import { describe, expect, test } from "bun:test";
import { createOAuthAccountIssuer } from "better-auth/db";

import {
	type AccountRecordAdapter,
	DEFAULT_UPSERT_ATTEMPTS,
	isUniqueConstraintViolation,
	SIGMA_ACCOUNT_ISSUER,
	SIGMA_PROVIDER_ID,
	SigmaAccountConflictError,
	upsertSigmaAccount,
} from "./account-record.js";

type Where = { field: string; value: unknown };
type Row = Record<string, unknown> & { id: string };

interface CreateCall {
	model: string;
	data: Record<string, unknown>;
}

interface UpdateCall {
	model: string;
	where: Where[];
	update: Record<string, unknown>;
}

interface FindOneCall {
	model: string;
	where: Where[];
}

interface FakeAdapterHooks {
	/** Runs before every `create`; throw to simulate a driver rejection. */
	onCreate?: (data: Record<string, unknown>, attempt: number) => void;
	/** Runs before every `update`; throw to simulate a driver rejection. */
	onUpdate?: (call: UpdateCall, attempt: number) => void;
	/** When true, `update` returns `null` even though it applied the change. */
	silentUpdates?: boolean;
}

/**
 * In-memory adapter that actually evaluates `where` clauses, so a test can
 * prove a row is *not* matched rather than merely that a filter was written a
 * certain way. Hooks are read at call time, so a test may install them after
 * construction (needed when the hook has to close over the row store).
 */
function createFakeAdapter(seed: Row[] = [], hooks: FakeAdapterHooks = {}) {
	const rows: Row[] = seed.map((row) => ({ ...row }));
	const findOneCalls: FindOneCall[] = [];
	const createCalls: CreateCall[] = [];
	const updateCalls: UpdateCall[] = [];
	let generated = 0;

	const matches = (row: Row, where: Where[]) =>
		where.every((clause) => row[clause.field] === clause.value);

	const adapter: AccountRecordAdapter = {
		async findOne<T>(data: {
			model: string;
			where: Where[];
		}): Promise<T | null> {
			findOneCalls.push(data);
			return (rows.find((row) => matches(row, data.where)) ?? null) as T | null;
		},
		async update<T>(data: {
			model: string;
			where: Where[];
			update: Record<string, unknown>;
		}): Promise<T | null> {
			updateCalls.push(data);
			hooks.onUpdate?.(data, updateCalls.length);
			const row = rows.find((candidate) => matches(candidate, data.where));
			if (!row) return null;
			Object.assign(row, data.update);
			return (hooks.silentUpdates ? null : row) as T | null;
		},
		async create<T>(data: {
			model: string;
			data: Record<string, unknown>;
		}): Promise<T> {
			createCalls.push(data);
			hooks.onCreate?.(data.data, createCalls.length);
			generated += 1;
			const row = { id: `generated-${generated}`, ...data.data } as Row;
			rows.push(row);
			return row as T;
		},
	};

	return { adapter, rows, findOneCalls, createCalls, updateCalls };
}

function sigmaRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "acct-1",
		userId: "user-1",
		accountId: "sigma-sub",
		providerId: SIGMA_PROVIDER_ID,
		issuer: SIGMA_ACCOUNT_ISSUER,
		...overrides,
	};
}

const baseParams = {
	accountId: "sigma-sub",
	userId: "user-1",
	accessToken: "at",
	refreshToken: "rt",
	idToken: "it",
	accessTokenExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
	now: new Date("2025-12-31T00:00:00.000Z"),
};

/** Postgres `unique_violation`, shaped the way node-postgres surfaces it. */
function pgUniqueViolation(): Error {
	return Object.assign(
		new Error(
			'duplicate key value violates unique constraint "account_issuer_accountId_key"',
		),
		{ code: "23505" },
	);
}

describe("SIGMA_ACCOUNT_ISSUER", () => {
	test("is Better Auth's own synthetic OAuth issuer for the sigma provider", () => {
		expect(SIGMA_PROVIDER_ID).toBe("sigma");
		expect(SIGMA_ACCOUNT_ISSUER).toBe(createOAuthAccountIssuer("sigma"));
	});

	// Canary: the value is persisted, so an upstream format change is a data
	// migration for consumers, not a transparent refactor.
	test("still resolves to the documented on-disk value", () => {
		expect(SIGMA_ACCOUNT_ISSUER).toBe("local:oauth:sigma");
	});
});

describe("isUniqueConstraintViolation", () => {
	const matching: Array<[string, unknown]> = [
		["postgres code", pgUniqueViolation()],
		["mysql code", Object.assign(new Error("nope"), { code: "ER_DUP_ENTRY" })],
		["mysql errno", Object.assign(new Error("nope"), { errno: 1062 })],
		["prisma code", Object.assign(new Error("nope"), { code: "P2002" })],
		["mongo code", Object.assign(new Error("nope"), { code: 11000 })],
		["sqlite message", new Error("UNIQUE constraint failed: account.issuer")],
		["mongo message", new Error("E11000 duplicate key error collection")],
		[
			"nested cause",
			new Error("adapter failed", { cause: pgUniqueViolation() }),
		],
		[
			"aggregate errors array",
			Object.assign(new Error("batch failed"), {
				errors: [new Error("unrelated"), pgUniqueViolation()],
			}),
		],
	];
	for (const [label, error] of matching) {
		test(`detects a ${label}`, () => {
			expect(isUniqueConstraintViolation(error)).toBe(true);
		});
	}

	const nonMatching: Array<[string, unknown]> = [
		["a plain error", new Error("connection reset")],
		[
			"a not-null violation",
			Object.assign(new Error("null value in column"), { code: "23502" }),
		],
		["a non-object", "23505"],
		["null", null],
		["undefined", undefined],
	];
	for (const [label, error] of nonMatching) {
		test(`does not match ${label}`, () => {
			expect(isUniqueConstraintViolation(error)).toBe(false);
		});
	}
});

describe("upsertSigmaAccount — identity lookup", () => {
	test("queries the full (issuer, accountId) account identity", async () => {
		const { adapter, findOneCalls } = createFakeAdapter();
		await upsertSigmaAccount({ adapter, ...baseParams });

		expect(findOneCalls).toHaveLength(1);
		expect(findOneCalls[0]?.model).toBe("account");
		expect(findOneCalls[0]?.where).toEqual([
			{ field: "issuer", value: "local:oauth:sigma" },
			{ field: "accountId", value: "sigma-sub" },
		]);
	});

	// Finding 1: a row sharing the accountId under a *different* issuer is a
	// different identity. It must not be selected, updated, or reparented.
	test("never selects or mutates a row belonging to another issuer", async () => {
		const { adapter, rows, createCalls, updateCalls } = createFakeAdapter([
			sigmaRow({
				id: "foreign-1",
				userId: "other-user",
				issuer: "https://idp.example.com",
				accessToken: "foreign-token",
			}),
		]);

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(updateCalls).toHaveLength(0);
		expect(createCalls).toHaveLength(1);
		expect(result.created).toBe(true);
		expect(result.id).not.toBe("foreign-1");

		const untouched = rows.find((row) => row.id === "foreign-1");
		expect(untouched?.userId).toBe("other-user");
		expect(untouched?.issuer).toBe("https://idp.example.com");
		expect(untouched?.accessToken).toBe("foreign-token");
	});

	// The same rule for the case the old `providerId` fallback used to catch: a
	// row that is "sigma" by providerId but whose issuer was backfilled to some
	// other value during the Better Auth 1.7 migration.
	test("does not adopt a sigma-providerId row backfilled with a non-canonical issuer", async () => {
		const { adapter, rows, createCalls } = createFakeAdapter([
			sigmaRow({ id: "legacy-1", userId: "other-user", issuer: "local:sigma" }),
		]);

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(result.created).toBe(true);
		expect(rows.find((row) => row.id === "legacy-1")?.userId).toBe(
			"other-user",
		);
		expect(createCalls[0]?.data.issuer).toBe("local:oauth:sigma");
	});
});

describe("upsertSigmaAccount — create path", () => {
	test("writes the full 1.7 account identity", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(createCalls).toHaveLength(1);
		const data = createCalls[0]?.data ?? {};
		expect(data.issuer).toBe("local:oauth:sigma");
		expect(data.providerId).toBe("sigma");
		expect(data.accountId).toBe("sigma-sub");
		expect(data.userId).toBe("user-1");
		expect(result).toEqual({
			id: "generated-1",
			created: true,
			reparented: false,
		});
	});

	test("does not send an explicit id — the adapter generates it", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		await upsertSigmaAccount({ adapter, ...baseParams });

		expect(createCalls[0]?.data).not.toHaveProperty("id");
	});

	test("writes token fields and timestamps", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		await upsertSigmaAccount({ adapter, ...baseParams });

		const data = createCalls[0]?.data ?? {};
		expect(data.accessToken).toBe("at");
		expect(data.refreshToken).toBe("rt");
		expect(data.idToken).toBe("it");
		expect(data.accessTokenExpiresAt).toEqual(baseParams.accessTokenExpiresAt);
		expect(data.createdAt).toEqual(baseParams.now);
		expect(data.updatedAt).toEqual(baseParams.now);
	});

	test("omits accessTokenExpiresAt when it is undefined", async () => {
		const { adapter, createCalls } = createFakeAdapter();
		await upsertSigmaAccount({
			adapter,
			...baseParams,
			accessTokenExpiresAt: undefined,
		});

		expect(createCalls[0]?.data).not.toHaveProperty("accessTokenExpiresAt");
	});
});

describe("upsertSigmaAccount — update path", () => {
	test("updates the matched row instead of creating a duplicate", async () => {
		const { adapter, createCalls, updateCalls } = createFakeAdapter([
			sigmaRow(),
		]);
		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(createCalls).toHaveLength(0);
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.where).toEqual([{ field: "id", value: "acct-1" }]);
		expect(result).toEqual({
			id: "acct-1",
			created: false,
			reparented: false,
		});
	});

	test("leaves the account identity columns alone", async () => {
		const { adapter, updateCalls } = createFakeAdapter([sigmaRow()]);
		await upsertSigmaAccount({ adapter, ...baseParams });

		expect(updateCalls[0]?.update).not.toHaveProperty("issuer");
		expect(updateCalls[0]?.update).not.toHaveProperty("accountId");
		expect(updateCalls[0]?.update).not.toHaveProperty("providerId");
	});

	test("reparents a row attached to a different user within the same identity", async () => {
		const { adapter, updateCalls } = createFakeAdapter([
			sigmaRow({ userId: "other-user" }),
		]);
		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(result.reparented).toBe(true);
		expect(updateCalls[0]?.update.userId).toBe("user-1");
	});

	test("omits accessTokenExpiresAt from the update when it is undefined", async () => {
		const { adapter, updateCalls } = createFakeAdapter([sigmaRow()]);
		await upsertSigmaAccount({
			adapter,
			...baseParams,
			accessTokenExpiresAt: undefined,
		});

		expect(updateCalls[0]?.update).not.toHaveProperty("accessTokenExpiresAt");
	});
});

describe("upsertSigmaAccount — concurrency", () => {
	// Finding 2: a concurrent callback wins the create race, so the unique
	// (issuer, accountId) index rejects ours. Recovery must not fail the
	// sign-in, and must converge on the winner's row rather than duplicating it.
	test("recovers from a unique violation on create by updating the winner's row", async () => {
		const hooks: FakeAdapterHooks = {};
		const { adapter, rows, createCalls, updateCalls } = createFakeAdapter(
			[],
			hooks,
		);
		hooks.onCreate = (_data, attempt) => {
			if (attempt > 1) return;
			// The concurrent writer's row lands between our read and our write.
			rows.push(sigmaRow({ id: "winner-1", userId: "user-2" }));
			throw pgUniqueViolation();
		};

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(createCalls).toHaveLength(1);
		expect(updateCalls).toHaveLength(1);
		expect(result).toEqual({
			id: "winner-1",
			created: false,
			reparented: true,
		});
		expect(rows.filter((row) => row.accountId === "sigma-sub")).toHaveLength(1);
		expect(rows.find((row) => row.id === "winner-1")?.accessToken).toBe("at");
		expect(rows.find((row) => row.id === "winner-1")?.userId).toBe("user-1");
	});

	test("rethrows a create failure that is not a uniqueness conflict", async () => {
		const notNull = Object.assign(
			new Error('null value in column "issuer" violates not-null constraint'),
			{ code: "23502" },
		);
		const { adapter, createCalls } = createFakeAdapter([], {
			onCreate: () => {
				throw notNull;
			},
		});

		await expect(
			upsertSigmaAccount({ adapter, ...baseParams }),
		).rejects.toThrow(notNull);
		expect(createCalls).toHaveLength(1);
	});

	test("retries when the update itself hits the unique index", async () => {
		const { adapter, updateCalls } = createFakeAdapter([sigmaRow()], {
			onUpdate: (_call, attempt) => {
				if (attempt === 1) throw pgUniqueViolation();
			},
		});

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(updateCalls).toHaveLength(2);
		expect(result).toEqual({ id: "acct-1", created: false, reparented: false });
	});

	test("rethrows an update failure that is not a uniqueness conflict", async () => {
		const boom = new Error("connection terminated unexpectedly");
		const { adapter } = createFakeAdapter([sigmaRow()], {
			onUpdate: () => {
				throw boom;
			},
		});

		await expect(
			upsertSigmaAccount({ adapter, ...baseParams }),
		).rejects.toThrow(boom);
	});

	// Adapters that do not echo the updated row must not be mistaken for a lost
	// race: the row is re-read to tell "nothing matched" apart from "this
	// adapter returns nothing".
	test("treats a null update result as success when the row is still there", async () => {
		const { adapter, createCalls, findOneCalls, rows } = createFakeAdapter(
			[sigmaRow()],
			{ silentUpdates: true },
		);

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(createCalls).toHaveLength(0);
		expect(findOneCalls).toHaveLength(2);
		expect(result).toEqual({ id: "acct-1", created: false, reparented: false });
		expect(rows[0]?.accessToken).toBe("at");
	});

	test("falls back to create when the row is deleted mid-update", async () => {
		const hooks: FakeAdapterHooks = {};
		const { adapter, rows, createCalls, updateCalls } = createFakeAdapter(
			[sigmaRow()],
			hooks,
		);
		hooks.onUpdate = (_call, attempt) => {
			// A concurrent unlink removes the row before our write lands.
			if (attempt === 1) rows.length = 0;
		};

		const result = await upsertSigmaAccount({ adapter, ...baseParams });

		expect(updateCalls).toHaveLength(1);
		expect(createCalls).toHaveLength(1);
		expect(result.created).toBe(true);
	});

	test("gives up with a conflict error when every attempt loses the race", async () => {
		const { adapter, createCalls } = createFakeAdapter([], {
			onCreate: () => {
				throw pgUniqueViolation();
			},
		});

		await expect(
			upsertSigmaAccount({ adapter, ...baseParams }),
		).rejects.toBeInstanceOf(SigmaAccountConflictError);
		expect(createCalls).toHaveLength(DEFAULT_UPSERT_ATTEMPTS);
	});

	test("honours a custom attempt budget", async () => {
		const { adapter, createCalls } = createFakeAdapter([], {
			onCreate: () => {
				throw pgUniqueViolation();
			},
		});

		await expect(
			upsertSigmaAccount({ adapter, ...baseParams, maxAttempts: 1 }),
		).rejects.toBeInstanceOf(SigmaAccountConflictError);
		expect(createCalls).toHaveLength(1);
	});
});
