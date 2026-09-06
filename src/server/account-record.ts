/**
 * Shared Sigma account bookkeeping for Better Auth >= 1.7.3.
 * Account identity is (providerId, accountId); issuer is no longer a core field.
 * Both callback entry points use this helper. Consumers that applied the
 * 1.7.0–1.7.2 issuer schema must complete the official cleanup before upgrading.
 */

/** Provider id used for every Sigma-linked account row. */
export const SIGMA_PROVIDER_ID = "sigma";

/** The subset of an `account` row this module reads. */
export interface SigmaAccountRow {
	id: string;
	userId: string;
	providerId?: string | null;
}

type AccountWhere = {
	field: string;
	value: unknown;
	operator?: string;
	connector?: string;
};

/**
 * Structural subset of Better Auth's database adapter used here. Declared with
 * method syntax so a real `Adapter` stays assignable under
 * `strictFunctionTypes`.
 */
export interface AccountRecordAdapter {
	findOne<T>(data: { model: string; where: AccountWhere[] }): Promise<T | null>;
	update<T>(data: {
		model: string;
		where: AccountWhere[];
		update: Record<string, unknown>;
	}): Promise<T | null>;
	create<T>(data: { model: string; data: Record<string, unknown> }): Promise<T>;
}

/**
 * Thrown when the account row could not be settled because a concurrent writer
 * kept winning the race. Deliberately distinct from a driver error so the
 * caller can tell "someone else is writing this row" apart from "the database
 * rejected the write".
 */
export class SigmaAccountConflictError extends Error {
	override readonly name = "SigmaAccountConflictError";
	readonly accountId: string;
	readonly attempts: number;

	constructor(accountId: string, attempts: number, options?: ErrorOptions) {
		super(
			`Could not settle the sigma account row for accountId=${accountId} after ${attempts} attempts; a concurrent writer kept winning the race.`,
			options,
		);
		this.accountId = accountId;
		this.attempts = attempts;
	}
}

/**
 * Driver-level unique-violation codes, lowercased.
 *
 * Better Auth adapters surface the underlying driver error largely untouched,
 * so the code has to be recognised per driver rather than through a single
 * normalised type.
 */
const UNIQUE_VIOLATION_CODES: ReadonlySet<string> = new Set([
	"23505", // Postgres / CockroachDB: unique_violation
	"er_dup_entry", // MySQL / MariaDB (mysql2 `code`)
	"1062", // MySQL / MariaDB (`errno`)
	"sqlite_constraint_unique", // node:sqlite / better-sqlite3
	"sqlite_constraint_primarykey",
	"2067", // SQLite extended result code: SQLITE_CONSTRAINT_UNIQUE
	"1555", // SQLite extended result code: SQLITE_CONSTRAINT_PRIMARYKEY
	"p2002", // Prisma: unique constraint failed
	"11000", // MongoDB: duplicate key
	"11001", // MongoDB: duplicate key on update
]);

/** Message fragments, lowercased, for drivers that do not expose a code. */
const UNIQUE_VIOLATION_PATTERNS: readonly string[] = [
	"duplicate key value",
	"violates unique constraint",
	"unique constraint failed",
	"unique violation",
	"duplicate entry",
	"e11000 duplicate key",
	"unique index",
];

const ERROR_CODE_KEYS: readonly string[] = ["code", "errno", "number"];

/**
 * Best-effort detection of "this row already exists" across the drivers Better
 * Auth adapters wrap. Walks `cause` chains and aggregate `errors` arrays,
 * because adapters routinely rethrow the driver error nested inside their own.
 *
 * A false negative degrades to the pre-existing behaviour (the driver error
 * propagates to the caller); a false positive costs one extra read plus an
 * update of a row we would have written anyway.
 */
export function isUniqueConstraintViolation(
	error: unknown,
	depth = 0,
): boolean {
	if (depth > 5 || error === null || typeof error !== "object") return false;
	const record = error as Record<string, unknown>;

	for (const key of ERROR_CODE_KEYS) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number") {
			if (UNIQUE_VIOLATION_CODES.has(String(value).toLowerCase())) return true;
		}
	}

	if (typeof record.message === "string") {
		const message = record.message.toLowerCase();
		if (
			UNIQUE_VIOLATION_PATTERNS.some((pattern) => message.includes(pattern))
		) {
			return true;
		}
	}

	if (isUniqueConstraintViolation(record.cause, depth + 1)) return true;

	const nested = record.errors;
	if (Array.isArray(nested)) {
		return nested.some((entry) =>
			isUniqueConstraintViolation(entry, depth + 1),
		);
	}

	return false;
}

export interface UpsertSigmaAccountParams {
	adapter: AccountRecordAdapter;
	/** Sigma `sub` — the stable subject id from the token exchange. */
	accountId: string;
	/** Better Auth user id the account should belong to. */
	userId: string;
	accessToken?: string | null;
	refreshToken?: string | null;
	idToken?: string | null;
	/**
	 * Pass `undefined` to leave the stored value untouched, or a `Date`/`null`
	 * to write it.
	 */
	accessTokenExpiresAt?: Date | null;
	/** Injectable clock, primarily for tests. */
	now?: Date;
	/** Log prefix so each call site keeps its existing log namespace. */
	logPrefix?: string;
	/** Race-resolution attempts before giving up. Primarily for tests. */
	maxAttempts?: number;
}

export interface UpsertSigmaAccountResult {
	/** Id of the created or updated row. */
	id: string;
	created: boolean;
	/** True when an existing row was moved to a different user. */
	reparented: boolean;
}

/** Default number of read/write attempts before reporting a conflict. */
export const DEFAULT_UPSERT_ATTEMPTS = 3;

/**
 * Creates or updates the `sigma` account row for a user.
 *
 * The canonical lookup uses (providerId, accountId). A different provider's
 * row is never selected even when it shares the same subject. Retained legacy
 * issuer values do not participate in identity and are never changed here.
 *
 * Consumers must retain a unique constraint on (providerId, accountId) to
 * arbitrate concurrent creates. A unique violation triggers a bounded re-read
 * and update of the winning row; disappearing rows are retried as creates.
 * Unresolved conflicts fail closed after the configured attempt budget.
 */
export async function upsertSigmaAccount(
	params: UpsertSigmaAccountParams,
): Promise<UpsertSigmaAccountResult> {
	const { adapter, accountId, userId } = params;
	const now = params.now ?? new Date();
	const logPrefix = params.logPrefix ?? "[Sigma Account]";
	const maxAttempts = Math.max(
		1,
		params.maxAttempts ?? DEFAULT_UPSERT_ATTEMPTS,
	);

	const tokenFields: Record<string, unknown> = {
		accessToken: params.accessToken,
		refreshToken: params.refreshToken,
		idToken: params.idToken,
	};
	if (params.accessTokenExpiresAt !== undefined) {
		tokenFields.accessTokenExpiresAt = params.accessTokenExpiresAt;
	}

	// Matches exactly one row: the unique index on (providerId, accountId).
	const identityWhere: AccountWhere[] = [
		{ field: "providerId", value: SIGMA_PROVIDER_ID },
		{ field: "accountId", value: accountId },
	];
	const findExisting = () =>
		adapter.findOne<SigmaAccountRow>({
			model: "account",
			where: identityWhere,
		});

	let lastConflict: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const existing = await findExisting();

		if (existing) {
			// Reparent the sigma account row to the currently-resolved user if it
			// was previously attached to a different one. This happens when the
			// Sigma token now returns a real email that matches an existing user,
			// where before the lookup fell through to a synthetic
			// `<sub>@sigma.local` email. Without reparenting, `account.userId` is
			// orphaned against the user that now holds the session. This only ever
			// moves a row within the *same* identity — `(sigma, sub)` —
			// so it cannot take over another provider's account.
			const reparented = existing.userId !== userId;
			if (reparented) {
				console.log(
					"%s Reparenting sigma account %s from user %s to user %s",
					logPrefix,
					existing.id,
					existing.userId,
					userId,
				);
			}

			let updated: SigmaAccountRow | null;
			try {
				updated = await adapter.update<SigmaAccountRow>({
					model: "account",
					where: [{ field: "id", value: existing.id }],
					update: { userId, ...tokenFields, updatedAt: now },
				});
			} catch (error) {
				if (!isUniqueConstraintViolation(error)) throw error;
				lastConflict = error;
				continue;
			}

			if (updated) {
				console.log("%s Updated account record: %s", logPrefix, existing.id);
				return { id: existing.id, created: false, reparented };
			}

			// A null result is ambiguous: some adapters simply do not echo the
			// updated row, others use it to report that nothing matched. Re-read
			// to tell the two apart instead of assuming either.
			const recheck = await findExisting();
			if (recheck && recheck.id === existing.id) {
				console.log("%s Updated account record: %s", logPrefix, existing.id);
				return { id: existing.id, created: false, reparented };
			}
			lastConflict = new Error(
				`Account row ${existing.id} disappeared during update`,
			);
			continue;
		}

		try {
			// No explicit `id`: Better Auth's adapter generates the primary key and
			// logs a warning for a caller-supplied id it then ignores.
			const created = await adapter.create<SigmaAccountRow>({
				model: "account",
				data: {
					accountId,
					providerId: SIGMA_PROVIDER_ID,
					userId,
					...tokenFields,
					createdAt: now,
					updatedAt: now,
				},
			});
			console.log("%s Created account record: %s", logPrefix, created?.id);
			return { id: created.id, created: true, reparented: false };
		} catch (error) {
			// Lost the race to a concurrent callback for the same subject. The
			// winner's row is the canonical one: re-read and update it on the next
			// pass rather than failing a sign-in that has already burned its
			// authorization code.
			if (!isUniqueConstraintViolation(error)) throw error;
			console.warn(
				"%s Concurrent create for accountId %s; retrying as an update (attempt %d/%d)",
				logPrefix,
				accountId,
				attempt,
				maxAttempts,
			);
			lastConflict = error;
		}
	}

	throw new SigmaAccountConflictError(accountId, maxAttempts, {
		cause: lastConflict,
	});
}
