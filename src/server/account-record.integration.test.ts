/**
 * Integration coverage for {@link upsertSigmaAccount} against the *real*
 * Better Auth adapter factory and the real 1.7 account schema, rather than the
 * hand-written fake in `account-record.test.ts`.
 *
 * Two things are proven here that a fake cannot prove:
 *
 * 1. The installed `@better-auth/*` graph is a single coherent 1.7 package set,
 *    and this package declares no `@better-auth/*` dependency of its own that
 *    could pin an older member of that family into a consumer's lockfile.
 * 2. The row shape written by `upsertSigmaAccount` survives Better Auth's own
 *    `transformInput`, and the `(issuer, accountId)` lookup is evaluated by a
 *    real adapter's where-clause engine.
 */

import { describe, expect, test } from "bun:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";

import { SIGMA_ACCOUNT_ISSUER, upsertSigmaAccount } from "./account-record.js";

type Json = Record<string, unknown>;

const REPO_ROOT = new URL("../../", import.meta.url);

async function readJson(relativePath: string): Promise<Json> {
	const file = Bun.file(new URL(relativePath, REPO_ROOT));
	// An assertion rather than a skip: a missing manifest must fail the gate,
	// not quietly pass it.
	expect(await file.exists()).toBe(true);
	return (await file.json()) as Json;
}

/** Minimal `^x.y.z` satisfaction check — the only range form declared here. */
function satisfiesCaret(version: string, range: string): boolean {
	expect(range.startsWith("^")).toBe(true);
	const parse = (value: string) =>
		value.replace(/^\^/, "").split(".").map(Number);
	const [rMajor = 0, rMinor = 0, rPatch = 0] = parse(range);
	const [vMajor = 0, vMinor = 0, vPatch = 0] = parse(version);
	if (vMajor !== rMajor) return false;
	if (vMinor !== rMinor) return vMinor > rMinor;
	return vPatch >= rPatch;
}

describe("better-auth package graph", () => {
	test("declares no @better-auth/* dependency that could pin an older family member", async () => {
		const manifest = await readJson("package.json");
		const deps = (manifest.dependencies ?? {}) as Record<string, string>;
		const peers = (manifest.peerDependencies ?? {}) as Record<string, string>;

		// `@better-auth/oauth-provider` and `@better-auth/passkey` used to sit
		// here at `^1.6.17` while the peer claimed 1.7-only, so a consumer's
		// lockfile could retain 1.6 provider code. Neither is imported by this
		// package; both were removed rather than bumped.
		expect(
			Object.keys(deps).filter((n) => n.startsWith("@better-auth/")),
		).toEqual([]);
		expect(
			Object.keys(peers).filter((n) => n.startsWith("@better-auth/")),
		).toEqual([]);
	});

	test("resolves better-auth within the declared peer range", async () => {
		const manifest = await readJson("package.json");
		const peers = (manifest.peerDependencies ?? {}) as Record<string, string>;
		const range = peers["better-auth"];
		expect(range).toBe("^1.7.0");

		const installed = await readJson("node_modules/better-auth/package.json");
		expect(satisfiesCaret(String(installed.version), String(range))).toBe(true);
	});

	test("resolves @better-auth/core to the same minor as better-auth", async () => {
		const betterAuth = await readJson("node_modules/better-auth/package.json");
		const core = await readJson("node_modules/@better-auth/core/package.json");
		const minor = (value: unknown) =>
			String(value).split(".").slice(0, 2).join(".");

		expect(minor(core.version)).toBe(minor(betterAuth.version));
		expect(minor(betterAuth.version)).toBe("1.7");
	});
});

describe("the real Better Auth 1.7 account schema", () => {
	const account = getAuthTables({}).account;

	test("declares issuer as a required field", () => {
		expect(account?.fields.issuer).toBeDefined();
		expect(account?.fields.issuer?.required).toBe(true);
	});

	test("declares the unique (issuer, accountId) compound index", () => {
		expect(account?.indexes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fields: ["issuer", "accountId"],
					unique: true,
				}),
			]),
		);
	});
});

/** Fresh in-memory store plus a real adapter built by Better Auth's factory. */
function createRealAdapter() {
	const db: {
		user: Json[];
		account: Json[];
		session: Json[];
		verification: Json[];
	} = { user: [], account: [], session: [], verification: [] };
	// No cast: assigning the real `Adapter` to `AccountRecordAdapter` is itself
	// part of the proof, and `tsc` checks it in the typecheck gate.
	const adapter = memoryAdapter(db)({});
	return { db, adapter };
}

const params = {
	accountId: "sigma-sub",
	userId: "user-1",
	accessToken: "at",
	refreshToken: "rt",
	idToken: "it",
	accessTokenExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
	now: new Date("2025-12-31T00:00:00.000Z"),
};

describe("upsertSigmaAccount against a real Better Auth 1.7 adapter", () => {
	test("persists issuer through the adapter's transformInput", async () => {
		const { db, adapter } = createRealAdapter();

		const result = await upsertSigmaAccount({ adapter, ...params });

		expect(result.created).toBe(true);
		expect(db.account).toHaveLength(1);
		const row = db.account[0] ?? {};
		expect(row.issuer).toBe(SIGMA_ACCOUNT_ISSUER);
		expect(row.providerId).toBe("sigma");
		expect(row.accountId).toBe("sigma-sub");
		expect(row.userId).toBe("user-1");
		expect(row.accessToken).toBe("at");
		// The adapter, not us, minted the primary key.
		expect(typeof row.id).toBe("string");
		expect(result.id).toBe(row.id as string);
	});

	// Control for the test above: the same adapter drops fields the schema does
	// not know about. `issuer` surviving therefore means it is a genuine field
	// of the installed schema, not that this adapter passes everything through.
	test("the same adapter drops a field the schema does not declare", async () => {
		const { db, adapter } = createRealAdapter();

		await adapter.create({
			model: "account",
			data: {
				accountId: "control",
				providerId: "sigma",
				issuer: SIGMA_ACCOUNT_ISSUER,
				userId: "user-1",
				createdAt: params.now,
				updatedAt: params.now,
				notAColumn: "dropped",
			},
		});

		expect(db.account[0]).toHaveProperty("issuer");
		expect(db.account[0]).not.toHaveProperty("notAColumn");
	});

	test("a second callback for the same subject updates instead of duplicating", async () => {
		const { db, adapter } = createRealAdapter();

		const first = await upsertSigmaAccount({ adapter, ...params });
		const second = await upsertSigmaAccount({
			adapter,
			...params,
			accessToken: "at-2",
			now: new Date("2026-01-02T00:00:00.000Z"),
		});

		expect(second).toEqual({ id: first.id, created: false, reparented: false });
		expect(db.account).toHaveLength(1);
		expect(db.account[0]?.accessToken).toBe("at-2");
	});

	test("reparents within the same identity when the resolved user changes", async () => {
		const { db, adapter } = createRealAdapter();

		const first = await upsertSigmaAccount({ adapter, ...params });
		const second = await upsertSigmaAccount({
			adapter,
			...params,
			userId: "user-2",
		});

		expect(second).toEqual({ id: first.id, created: false, reparented: true });
		expect(db.account).toHaveLength(1);
		expect(db.account[0]?.userId).toBe("user-2");
	});

	// The finding-1 guarantee, re-proven against a real adapter's own where
	// evaluation rather than the fake's.
	test("does not match or mutate a same-accountId row under another issuer", async () => {
		const { db, adapter } = createRealAdapter();

		await adapter.create({
			model: "account",
			data: {
				accountId: "sigma-sub",
				providerId: "sigma",
				issuer: "https://auth.sigmaidentity.com",
				userId: "other-user",
				accessToken: "foreign-token",
				createdAt: params.now,
				updatedAt: params.now,
			},
		});
		const foreignBefore = JSON.stringify(db.account[0]);

		const result = await upsertSigmaAccount({ adapter, ...params });

		expect(result.created).toBe(true);
		expect(db.account).toHaveLength(2);
		expect(JSON.stringify(db.account[0])).toBe(foreignBefore);
		expect(db.account[1]?.issuer).toBe(SIGMA_ACCOUNT_ISSUER);
		expect(db.account[1]?.userId).toBe("user-1");
	});
});
