/**
 * Shared bookkeeping for the `account` row that links a Better Auth user to a
 * Sigma identity.
 *
 * Better Auth 1.7 promoted `account.issuer` to core schema: it is a required
 * column, and the uniqueness constraint on accounts moved from
 * `(providerId, accountId)` to a unique index on `(issuer, accountId)`. Writing
 * the pre-1.7 shape against a 1.7 database fails with a NOT NULL violation on
 * `issuer` (Postgres SQLSTATE 23502) after an otherwise successful token
 * exchange.
 *
 * This module targets Better Auth >= 1.7 only. Consumers still on 1.6 should
 * stay on `@sigma-auth/better-auth-plugin@0.0.92`.
 *
 * Both the `/next` route handler and the `/server` callback plugin funnel their
 * account writes through {@link upsertSigmaAccount} so the two stay in sync.
 */

// Imported rather than reimplemented: `createOAuthAccountIssuer` is the exact
// function Better Auth uses to key OAuth accounts that carry no issuer of their
// own. A local copy of another package's key-derivation formula silently drifts
// the moment upstream changes it, and a drifted issuer means a duplicated —
// or, worse, a mismatched — identity. `better-auth/db` re-exports the binding
// from `@better-auth/core/db`; importing it through `better-auth` keeps the
// dependency surface limited to the declared peer dependency instead of relying
// on `@better-auth/core` being hoisted into a resolvable position.
import { createOAuthAccountIssuer } from "better-auth/db";

/** Provider id used for every Sigma-linked account row. */
export const SIGMA_PROVIDER_ID = "sigma";

/**
 * The issuer Better Auth itself assigns to the `sigma` provider.
 *
 * Together with `accountId` (the Sigma `sub`) this is the account's identity
 * under Better Auth 1.7 and the key of its unique index.
 */
export const SIGMA_ACCOUNT_ISSUER: string =
	createOAuthAccountIssuer(SIGMA_PROVIDER_ID);

/** The subset of an `account` row this module reads. */
export interface SigmaAccountRow {
	id: string;
	userId: string;
	providerId?: string | null;
	issuer?: string | null;
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
 * ## Identity
 *
 * The lookup is keyed on the full Better Auth 1.7 account identity —
 * `(issuer, accountId)` — and is pushed down into the query rather than being
 * resolved in memory. That matters for correctness, not just tidiness: a row
 * that shares this `accountId` but carries a *different* issuer is a different
 * identity, and must never be selected here. Matching it would mean
 * overwriting another issuer's `userId` and tokens, i.e. moving account
 * ownership across an issuer boundary. Such a row is left completely untouched;
 * a fresh row is created under `local:oauth:sigma` instead, which cannot
 * collide because the unique index is on `(issuer, accountId)`.
 *
 * There is deliberately no `providerId === "sigma"` fallback for rows with an
 * empty issuer. On a 1.7 schema `issuer` is a required column, so such rows do
 * not exist; operators migrating a populated `account` table must backfill
 * Sigma rows with exactly `local:oauth:sigma` for them to keep matching.
 *
 * ## Concurrency
 *
 * Two callbacks for the same subject can interleave. The check-then-create is
 * therefore treated as optimistic: a create that loses the race to the unique
 * `(issuer, accountId)` index is caught, the row is re-read, and the update
 * path is taken instead. An update that reports no affected row is re-read the
 * same way, so a row deleted mid-flight falls back to the create path rather
 * than being silently skipped.
 *
 * If the conflict is not resolvable — for example a database that still carries
 * a legacy unique index on `(providerId, accountId)`, where a mis-backfilled
 * row blocks the canonical insert but never matches the canonical read — the
 * attempts are exhausted and {@link SigmaAccountConflictError} is thrown. That
 * is deliberate: failing the sign-in is preferable to reaching for the blocking
 * row and overwriting an identity that is not ours.
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

	// Matches exactly one row: the unique index on (issuer, accountId).
	const identityWhere: AccountWhere[] = [
		{ field: "issuer", value: SIGMA_ACCOUNT_ISSUER },
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
			// moves a row within the *same* identity — `(local:oauth:sigma, sub)` —
			// so it cannot take over another issuer's account.
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
					issuer: SIGMA_ACCOUNT_ISSUER,
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
