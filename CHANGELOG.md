# Changelog

## 0.0.96

### Changed
- **Client signing key is `accountPubkey`, no fallback.** The `memberPubkey` legacy read is gone — versions are the gate, so code assumes the schema its version requires. Pair with the sigma-auth migration that renames the columns.

## 0.0.95

### Fixed
- **Token-exchange client auth reads `accountPubkey` with `memberPubkey` fallback.** sigma-auth OPL-4419 renames the OAuth client signing key; the provider was the one reader still on the old name, failing every `x-auth-token` exchange with `invalid_client` once the rename lands. Works against pre- and post-rename databases with no flag day.

## 0.0.94

### Added
- **`sigmaProvider({ organizations: { ensureOnEnrollment } })`** controls whether the provider writes the `organization` and `member` rows for a BAP identity during sign-up / sign-in enrollment. It defaults to `true`, so existing consumers are unchanged. Set it to `false` when the application creates the organization after its own profile row — sigma-auth now gives `organization.id` a foreign key onto a profile row it registers later in the request, and the plugin's early write violated that constraint. With the option off both enrollment call sites skip the write entirely (no existence probe either) and emit a single debug line, `organization creation delegated to the application`.

## 0.0.93

### Breaking
- **`zod` is now a required peer dependency, not an optional one.** It is a runtime import of `/server`, `/next`, `/payload` and `/provider` — every server-side entry point, not just the provider as the README claimed. It resolved anyway on flat installs because it is a hard dependency of `@better-auth/core`, but under pnpm's strict layout or Yarn PnP a consumer following the documented install got `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` on `import ... from "@sigma-auth/better-auth-plugin/server"`. Anyone who already has `better-auth` already has a compatible `zod`; this only makes the existing requirement declared.
- **Better Auth 1.7 is now the minimum supported version.** `peerDependencies.better-auth` moves from `^1.6.0` to `^1.7.0`. The account bookkeeping in this release is written against the 1.7 `account` schema — `issuer` as a required column and account identity keyed on `(issuer, accountId)` — and there is no pre-1.7 code path. The previous `^1.6.0` range was never exercised by CI, so it was a claim rather than a guarantee. **Consumers still on Better Auth 1.6 should stay on `@sigma-auth/better-auth-plugin@0.0.92`.**

### Fixed
- **Sign-in no longer fails with `null value in column "issuer" of relation "account"` (Postgres `23502`) on Better Auth 1.7.** Better Auth 1.7 promoted `account.issuer` to core schema — it is required, and account identity moved from a `(providerId, accountId)` unique key to a unique index on `(issuer, accountId)`. Both `createBetterAuthCallbackHandler` (next/) and `sigmaCallbackPlugin` (server/) still wrote the pre-1.7 row shape with no `issuer`, so every user who did not already have a `sigma` account row hit a NOT NULL violation *after* an otherwise successful token exchange. New account rows now carry `issuer: "local:oauth:sigma"`, obtained by calling Better Auth's own `createOAuthAccountIssuer("sigma")`.
- **The existing-account lookup now queries the full `(issuer, accountId)` identity** instead of matching candidate rows in memory. The previous in-memory match accepted any row with `providerId === "sigma"`, including rows whose `issuer` was a *different*, non-empty value. Under 1.7 such a row is a separate identity, and adopting it overwrote another issuer's `userId` and tokens — a cross-issuer account takeover. Rows that do not carry exactly `local:oauth:sigma` are now never selected and never mutated; a fresh canonical row is created instead, which cannot collide because the unique index is on `(issuer, accountId)`.
- **The account upsert is now conflict-safe.** The read-then-write was a non-atomic check-then-create: two callbacks for the same subject could both observe no row and both call `create`, and on 1.7 the unique `(issuer, accountId)` index fails one of them *after* the token exchange and the user write. A create that loses the race is now recognised as a uniqueness conflict (Postgres `23505`, MySQL `ER_DUP_ENTRY`/`1062`, SQLite `UNIQUE constraint failed`, Prisma `P2002`, MongoDB `11000`, including errors nested under `cause` or `errors`), the row is re-read, and the update path is taken. An update that reports no affected row is re-read the same way, so a row deleted mid-flight falls back to create rather than being silently skipped. Exhausting the retry budget raises a `SigmaAccountConflictError` (`error.name === "SigmaAccountConflictError"`) instead of leaking a driver error — the sign-in fails loudly rather than the plugin reaching for a row that is not its identity.
- **The account create call no longer passes an explicit `id`.** Better Auth's adapter documents that a caller-supplied `id` is ignored by default and logs a warning; the adapter generates the primary key.
- **The Payload callback's session cookie is now signed with an encoding Better Auth accepts.** `createPayloadCallbackHandler` signed the session token with `base64urlnopad` — a 43-character, URL-safe-alphabet, unpadded signature. Better Auth reads its session cookie through better-call's `getSignedCookie`, which rejects the value before it even attempts verification:
  ```js
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  ```
  So the callback reported success, set a cookie, and every subsequent session read failed. **This defect pre-dates this release**: it is how `/payload` has always signed, and the `@better-auth/utils` HMAC it previously called produced the byte-identical rejected value. `/next` had the correct implementation and even carried a comment about the 44-character rule; `/payload` never got the same fix. Signing now delegates to Better Auth's own public `makeSignature` (`better-auth/crypto`), which emits padded standard Base64, and a test reads the resulting cookie back through a real `betterAuth()` instance rather than comparing it to another crypto utility.
- **The shipped entry points no longer import packages this one does not declare.** `./provider` imported `@better-auth/utils/base64` and `@better-auth/utils/hash`, `./payload` imported `@better-auth/core` and `@better-auth/utils/hmac`, and `./client`'s emitted `.d.ts` imported `@better-fetch/fetch`. None of the three was in `dependencies` or `peerDependencies`; they resolved only because Bun and npm flatten `better-auth`'s transitive packages to the top level. Under pnpm's strict layout, Yarn PnP, or any nested install, `./provider` and `./payload` failed with `ERR_MODULE_NOT_FOUND` and `./client` failed to typecheck.
  - `@better-auth/utils` was **replaced**, not declared. Better Auth exposes no public re-export of `createHash`/`base64Url`/`createHMAC` (`better-auth/crypto` carries password, JWT and envelope helpers only), and declaring a direct dependency on an internal package whose version is pinned to `better-auth`'s own resolution risks a second, skewed copy. `src/utils/webcrypto.ts` reimplements the three helpers on standard Web Crypto in ~30 lines, and `src/utils/webcrypto.test.ts` proves byte-identical output against `@better-auth/utils` (now a devDependency, kept solely as the reference implementation) across every input length and Unicode, plus identical rejection of a zero-length HMAC key. This matters concretely: the hash is the lookup key for `storeTokens: "hashed"` and the HMAC is the session-cookie signature, so a one-bit difference would break every token lookup and every session.
  - `@better-auth/core` was **replaced**: `AuthContext` is publicly re-exported by `better-auth` itself, so the type identity is unchanged.
  - `@better-fetch/fetch` was **declared** as an optional peer rather than replaced. `better-auth/client` does re-export `BetterFetch`, but substituting it breaks `BetterAuthClientPlugin.getActions` assignability — the exact regression fixed in 0.0.92 — so the original type source is kept and now declared. Better Auth's own `@better-auth/core` peers the same package.

### Changed
- Account bookkeeping for both callback entry points is now shared in `src/server/account-record.ts` (`upsertSigmaAccount`), so the `/next` handler and the `/server` callback plugin cannot drift apart again.
- The issuer value is imported from `better-auth/db` (which re-exports `createOAuthAccountIssuer` from `@better-auth/core/db`) rather than reimplemented locally, so a change to Better Auth's key derivation cannot silently desynchronise this package's account identity. A test pins the resolved value to the documented on-disk string so an upstream format change surfaces as a failing test rather than as duplicated accounts.
- Added `test` (`bun test`) and `typecheck` (`tsc --noEmit -p tsconfig.test.json`) scripts, wired into `prepublishOnly`. Test files are excluded from the published build.
- Session-cookie signing is shared in `src/server/session-cookie.ts`. `/next` and `/payload` each hand-rolled it and drifted — one correct, one not — which is the same failure mode the shared `upsertSigmaAccount` was introduced to prevent for account writes. A test asserts there is no second signing site anywhere in `src/`.
- `/next` no longer imports `node:crypto`. It used it only to compute that signature; the shared helper goes through Better Auth's Web Crypto path, so the entry point no longer pulls a Node-only builtin into a route handler that is frequently deployed to the Edge runtime.
- Added a publish-surface test (`src/package-surface.test.ts`) that builds and `npm pack`s the real artifact, parses every shipped `.js` and `.d.ts` with TypeScript's own scanner — which sees `import type` and dynamic `import()` and ignores JSDoc — and fails on any bare specifier that is not declared, a Node builtin, or this package itself. It then builds a **separate fixture per entry point**, each containing only the packages that entry point's documented install provides, and checks two things in each: that Node can import it, and that a consumer `tsc` program compiles against its shipped declarations. Three negative controls keep the fixtures honest — an undeclared package must be unreachable, dropping `zod` must break `/server`, and dropping a type-only peer must be caught by the consumer compile even though no runtime import can see it. The previous fixture symlinked every optional peer that happened to exist in the dev workspace, so it could pass while the documented install failed; that is how the `zod` gap survived.
- **Removed the `@better-auth/oauth-provider` and `@better-auth/passkey` dependencies.** Neither is imported anywhere in `src/`; they were unused runtime dependencies pinned at `^1.6.17`, which meant a consumer installing this package could keep 1.6 provider code resolved alongside a 1.7 core — directly contradicting the 1.7-only claim above. The README and the bundled agent guide already instruct consumers to install `@better-auth/oauth-provider` themselves when running their own OAuth server, so removal is preferred over an unused dependency that constrains someone else's graph. An integration test now asserts this package declares no `@better-auth/*` dependency and that the resolved `better-auth` / `@better-auth/core` pair is a single coherent 1.7 set.

### Migration

Migrate Better Auth to 1.7 **before** upgrading this package.

**Adapter scope for this release.** The path below is the guided SQL workflow, and it is the only one this project has verified. Better Auth routes *adapters with no SQL migration connection* — MongoDB in particular — through a separate manual path; that path is summarised at the end of this section but is **not exercised by this project's gates**. Do not read the MongoDB duplicate-key codes in `isUniqueConstraintViolation` as a statement of tested support: that detector is defensive driver breadth for the conflict-recovery path, not a claim that the 1.7 account-identity migration has been validated on MongoDB.

**1. Use Better Auth's own migration workflow. Do not hand-write the backfill.**
The [1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide) states plainly: *"Never apply the 1.7 account schema directly over a populated 1.6 account table. A plain schema migration cannot preserve account identity or resolve collisions because the 1.6 rows have no issuer value."* Run the guided workflow, resolve anything the plan reports as blocked, rehearse against a restored backup, then apply during a window in which no 1.6 process is writing auth data:

```bash
npx auth upgrade        # moves better-auth and every @better-auth/* package together
npx auth migrate plan   # reports ready | blocked | up-to-date
npx auth migrate apply  # only once the plan reports ready
```

ORM prerequisites the upstream guide lists, which apply before `migrate plan`:

- **Drizzle and Prisma** — run `npx auth generate` first and point the adapter at the generated 1.7 schema, but do **not** apply that schema yourself; the CLI migrates the 1.6 data and schema together. The plan resolves physical table and column names from your Drizzle schema or Prisma model metadata, including `snake_case` and Prisma `@map`. Record the cutover in your ORM migration history afterwards so a later deployment does not reapply it.
- **Drizzle on SQLite or PostgreSQL** — set the adapter's `transaction` option to `true` so the release migration can run atomically.
- **MySQL with populated legacy SCIM accounts** — use a transaction-capable migration connection.

**2. Select the `provider-id` account identity strategy.**

```ts
betterAuth({ account: { identityStrategy: "provider-id" } });
```

This is what makes existing Sigma rows keep working. Under `provider-id`, `auth migrate apply` backfills each external connection with the deterministic namespace `local:oauth:<encoded providerId>` — for `providerId: "sigma"` that is exactly `local:oauth:sigma`, the value this plugin writes and the only value it will match. No manual backfill of Sigma rows is required.

Under the `issuer` strategy the migration stores a provider's *trusted issuer* instead, so a migrated Sigma row could land on `https://auth.sigmaidentity.com` while this plugin continues to read and write `local:oauth:sigma` — the two would be separate identities and the affected users would get a second account row. If you need `issuer` identity for other providers, treat Sigma account rows as a separately reviewed re-key. (Omitting `identityStrategy` entirely is a deprecated 1.7 compatibility mode that behaves as `issuer` and warns once per auth instance.)

**3. Verify before you deploy this package.** Both queries must return `0`. Substitute your configured physical table and column names if you set `account.fields`; the identifier quoting below is dialect-specific and *must* be matched to your database — under MySQL's default `sql_mode` a double-quoted identifier is a string literal, so a Postgres-style predicate silently matches nothing and reports a false clean bill of health.

Postgres, SQLite, SQL Server:

```sql
SELECT COUNT(*) FROM account
WHERE "providerId" = 'sigma'
  AND ("issuer" IS NULL OR "issuer" <> 'local:oauth:sigma');
```

MySQL, MariaDB:

```sql
SELECT COUNT(*) FROM account
WHERE `providerId` = 'sigma'
  AND (`issuer` IS NULL OR `issuer` <> 'local:oauth:sigma');

-- MySQL only: the upgrade guide's corruption check. A nonzero result means an
-- earlier migration silently backfilled empty strings and needs repair, not
-- just a backfill.
SELECT COUNT(*) FROM account WHERE `issuer` = '';
```

A nonzero count means the migration is incomplete: re-run `npx auth migrate plan` rather than deploying. Do not patch the rows by hand.

Rows written by this plugin at <= 0.0.92 only exist on databases that were still on the 1.6 schema — writing them against a 1.7 schema is precisely the `23502` failure this release fixes. On the guided SQL path above they are therefore handled by the 1.6 -> 1.7 migration. They are **not** handled automatically on the manual path below.

**4. MongoDB and other adapters with no SQL migration connection.** Better Auth's guide routes these through its manual path: complete the manual account-identity preparation, apply the 1.7 schema with `npx auth generate` and your own tooling, then deploy the 1.7 packages and configuration together. `auth migrate apply` will not backfill `issuer` for you, so the Sigma rows are yours to migrate.

> These commands are **not covered by this project's test suite** — no MongoDB adapter is exercised by any gate here. Rehearse them against a restored backup in an isolated environment, with authentication writes stopped, before touching production. If you are not prepared to do that, stay on `@sigma-auth/better-auth-plugin@0.0.92` and Better Auth 1.6 until you are.

Find collisions *first* — the compound unique index cannot be created while two documents would resolve to the same identity:

```js
db.account.aggregate([
  { $match: { providerId: "sigma" } },
  { $group: { _id: { issuer: "local:oauth:sigma", accountId: "$accountId" },
              n: { $sum: 1 }, users: { $addToSet: "$userId" } } },
  { $match: { n: { $gt: 1 } } },
]);
```

Resolve every result by hand before continuing. Then backfill only the documents that have no issuer, and only for this provider:

```js
db.account.updateMany(
  { providerId: "sigma", $or: [{ issuer: { $exists: false } }, { issuer: null }, { issuer: "" }] },
  { $set: { issuer: "local:oauth:sigma" } },
);
```

The filter deliberately does **not** touch a document that already has a non-empty `issuer`. Overwriting one would move an account across an issuer boundary, which is the cross-issuer takeover this release fixes in code; leave those for a separately reviewed re-key.

Verify — both must return `0` — then create the compound index:

```js
db.account.countDocuments({ providerId: "sigma", issuer: { $ne: "local:oauth:sigma" } });
db.account.countDocuments({ issuer: { $in: [null, ""] } });
db.account.createIndex({ issuer: 1, accountId: 1 }, { unique: true });
```

The unique index is not optional. Without it, two concurrent callbacks for the same subject both see no row and both insert, MongoDB accepts both, and the user ends up with duplicate identities — the conflict-recovery path in this release depends on the database rejecting the second write.

## 0.0.92

### Fixed
- **`sigmaClient`'s `getActions` params are now explicitly annotated with Better Auth's own types** (`$fetch: BetterFetch` from `@better-fetch/fetch`, `$store: ClientStore` from `better-auth/client`), matching first-party plugins. Previously the params were inferred and the emitted `.d.ts` carried widened types that failed `BetterAuthClientPlugin` assignability in consumers on `better-auth` >= 1.6.17 — which silently collapsed the whole inferred client API (`authClient.emailOtp`, `authClient.organization`, etc. vanished from `createAuthClient`'s return type). No runtime change.

### Changed
- `devDependencies.better-auth` bumped to `^1.6.17` so the published `.d.ts` is built against current types.

## 0.0.91

### Breaking
- **`user.bapId` is no longer contributed to consumer schemas, and the plugin no longer writes to `user.bapId` or `user.pubkey` from any callback.** `bapId` is per-BAP — a single human can hold many BAP identities — and storing it on a `user` row with `UNIQUE` made every multi-BAP sign-in fight the schema. The selected bapId for any given session is recoverable from the access-token claims (`bap_id`) and the OIDC userinfo response. Per-BAP `member_pubkey` lives on `profile.member_pubkey` (provider-side) and is served to consumers via the `pubkey` claim.

### Migration
- Consumers that declared a `bap_id`/`bapId` column on their `user` table: drop the column and its UNIQUE index after upgrading. There are no replacement reads in the plugin — anywhere your code reads `user.bap_id`, switch to reading the access-token claim or the `account` row's `accountId` (sigma's `sub`). Specifically:
  - SQLite/Turso (Drizzle): `DROP INDEX user_bap_id_unique; ALTER TABLE user DROP COLUMN bap_id;` + drop the field from your Drizzle schema.
  - Postgres: `ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_bap_id_key; ALTER TABLE "user" DROP COLUMN IF EXISTS bap_id;`
- Consumers without a `bap_id` column on user (e.g. bopen.io): no migration needed, just upgrade.

### Fixed
- **`createBetterAuthCallbackHandler` (next/) and `sigmaCallbackPlugin` (server/) no longer write per-BAP `bapId` or `pubkey` to the user row** on every sign-in. These were the writes that triggered `UNIQUE constraint failed: user.bap_id` for any consumer with the column, blocking sign-in entirely once an orphan/duplicate row existed.
- **`sigmaProvider` no longer writes `user.pubkey = selectedProfile.member_pubkey`** on the consent or token-flow hooks. The user.pubkey column remains for now (sigma-auth's sign-in path still queries it), but the over-eager overwrite-on-every-consent is gone.

## 0.0.90

### Fixed
- **`createBetterAuthCallbackHandler` now accepts `Auth<O>` with any `BetterAuthOptions`.** Both the function and `BetterAuthCallbackConfig` are now generic over `O extends BetterAuthOptions`, and `AuthAdapter` is parameterized the same way. Previously the parameter was typed as the bare `Auth`, which resolves to `Auth<BetterAuthOptions>` — TypeScript refuses to assign a consumer's specific `Auth<ConsumerOptions>` to that under invariant generic comparison, so consumers hit errors like `Property 'banned' is missing in type` when they enabled the `admin()` plugin. The generic lets the consumer's specific `Auth` shape flow through without casts.

### Migration
- Consumers who were forced to cast — e.g. `createBetterAuthCallbackHandler({ auth: auth as unknown as Auth, ... })` — can drop the cast and pass `auth` directly.
- No runtime behavior change.

## 0.0.89

### Changed
- **Rebuilt against `better-auth` 1.6.x**. `devDependencies.better-auth` bumped from `^1.5.0` to `1.6.8` and `peerDependencies.better-auth` bumped to `^1.6.0`. No runtime code changes — the plugin already compiled against 1.6 without edits — but the published `.d.ts` files now reference current `better-auth` types, so consumers on 1.6 stop hitting structural-type mismatches when passing their `Auth` instance to `createBetterAuthCallbackHandler` / `sigmaAdminPlugin` / `sigmaCallbackPlugin`.

### Migration
- Consumers on `better-auth@^1.6.0`: drop any `as unknown as Auth` casts around the plugin's entry points and upgrade to `@sigma-auth/better-auth-plugin@^0.0.89`.
- Consumers still on `better-auth@1.5.x`: stay on 0.0.88 until you upgrade; the new peer requires ^1.6.0.

## 0.0.88

### Fixed
- **Sigma account rows now reparent to the currently-resolved user**: Both `createBetterAuthCallbackHandler` (next/) and `sigmaCallbackPlugin` (server/) already looked up the target user by email first, but when they subsequently found an existing `accounts` row keyed by `(providerId: "sigma", accountId: <sub>)`, the update call only refreshed tokens and did not set `userId`. If the email-based user lookup resolved to a different user than the one the account was previously attached to — the exact scenario introduced by the 0.0.87 scope change, where Sigma started returning a real email that matches an existing magic-link user — the account row was left orphaned, with `accounts.userId` pointing at an abandoned user while the session belonged to the new user. Both handlers now include `userId` in the update and log a reparenting line when the userId changes.

## 0.0.87

### Changed
- **Default OAuth scope now includes `email`**: `authClient.signIn.sigma()` previously hardcoded `scope: "openid profile"` when building the authorize URL. It now defaults to `"openid profile email"` so the userinfo response carries `email` and `email_verified` claims. Per OpenID Connect Core §5.4, `email` is a separate scope from `profile` and must be requested explicitly — requesting only `openid profile` leaves the email claim empty.
- **Without a real email, consumer apps end up with duplicate user rows** when the same person signs in via magic link (real email) and Sigma (synthetic `<bap_id>@sigma.local` email). With `email` now requested by default, Better Auth's built-in account linking by verified email works as designed.

### Added
- **`scope` option on `SigmaSignInOptions`**: Consumers can override the default scope string to request additional scopes (e.g. `"openid profile email offline_access"`) or narrower ones. Defaults to `"openid profile email"`.

### Migration
- No action required for most consumers — the new default is a strict superset of the old one.
- On first sign-in after upgrading, users may see a fresh consent screen from Sigma Identity because a new scope is being requested. This is expected OIDC behavior.
- If you have a custom callback handler that relied on `result.user.email` being empty (falling through to the `<bap_id>@sigma.local` synthetic), it will now receive a real email. Update your user-creation/lookup logic accordingly.

## 0.0.86

### Added
- **`disableImplicitSignUp` option**: When set to `true`, the `/sign-in/sigma` endpoint and `next/` callback reject new user creation with a `FORBIDDEN` error (`USER_NOT_FOUND` code). Existing users can still sign in. This respects Better Auth's built-in sign-up gating pattern.

## 0.0.85

### Fixed
- **Schema/runtime alignment**: Plugin schema now declares all fields that runtime code reads and writes. Consumers running `npx @better-auth/cli generate` get a complete, correct schema.
  - Added `user.bapId` to schema declaration (was written by callbacks but never declared)
  - Changed `user.pubkey` from `required: true` to `required: false` (not all code paths set it on creation)
  - Changed `oauthClient.ownerBapId` from `required: true` to `required: false`
- **Consumer callbacks write pubkey**: `next/index.ts` and `server/callback-plugin.ts` now write `pubkey` from the Sigma OAuth response when available
- **Consumer callbacks write bapId**: `server/callback-plugin.ts` now writes `bapId` to user records (was missing)

## 0.0.84

### Changed
- **CWI transport for sigma signer**: Replace SigmaIframeSigner with CWI wallet interface transport
- Remove `getWalletKey` (no longer needed with CWI)

## 0.0.83

### Fixed
- **sigmaAdminPlugin after-hook crash**: The after-hook on `/get-session` returned `undefined`, but Better Auth's `runAfterHooks` unconditionally accesses `result.headers` on the return value. Now returns `{}` from both early-return and normal exit paths.

## 0.0.82

### Changed
- **Extract `ensureBapOrganization` helper**: Deduplicate org/member creation logic from `signInSigma` into a shared function with race condition handling (catches duplicate key errors instead of crashing).

### Fixed
- **Organization ID preserved on create**: Pass `forceAllowId: true` to adapter create calls so the BAP ID is used as the org ID.
- **Error logging in `signInSigma`**: Top-level try/catch with debug.error logging for unhandled exceptions.

## 0.0.83 (git only, not published)

### Fixed
- **Organization ID preserved on create**: Pass `forceAllowId: true` to adapter create calls for organization and member records so the BAP ID is used as the org ID instead of being replaced by an auto-generated ID.

## 0.0.82

### Added
- **Error logging in `signInSigma`**: Top-level try/catch with debug.error logging for unhandled exceptions, including stack traces.

## 0.0.81

### Breaking Changes
- **Config rename**: `memberPrivateKey` → `accountPrivateKey` in `TokenExchangeOptions`, `CallbackRouteConfig`, `SigmaCallbackOptions`, and `PayloadCallbackConfig`. The environment variable `SIGMA_MEMBER_PRIVATE_KEY` is unchanged.

### Added
- **`getWalletKey()` on `SigmaIframeSigner`**: New iframe message protocol (`GET_WALLET_KEY_REQUEST`/`GET_WALLET_KEY_RESPONSE`) to retrieve the encrypted wallet key. The iframe re-encrypts the derived key with the user's password.
- **`createBapOrganization()` helper**: Exported wrapper around Better Auth's `organization()` plugin configured for BAP identities — no invitations, single member, owner role.
- **Organization creation in `signInSigma`**: When a BAP ID is resolved or client-sent, the provider now creates `organization` + `member` records via adapter with `id = bapId`, matching the convention established by migration 013.

### Fixed
- **`BAPProfile.idKey` restored**: Reverted `bapId` back to `idKey` to match the BAP overlay wire format.
- **Biome config**: Updated schema reference to 2.4.6.

## 0.0.76

### Added
- **BAP-aware OAuth authorize requests**: `signIn.sigma({ bapId })` now forwards the selected identity in authorize params (`bapId` and `bap_id`) so auth servers can target the intended BAP identity in multi-identity flows.
- **Automatic identity cleanup on sign-out**: Client plugin now clears persisted Sigma identity when Better Auth session transitions from signed-in to signed-out. Added `clearIdentityOnSignOut` option (defaults to `true`).

## 0.0.75

### Fixed
- **Data URI images causing 494 REQUEST_HEADER_TOO_LARGE on Vercel**: The provider plugin was copying base64 data URI images from the `profile` table directly into `user.image`. This caused the session cookie cache to serialize ~52KB+ of image data into 19+ chunked cookies, exceeding Vercel's ~16KB request header limit. Now only URL-based images are stored in `user.image`; data URI images are skipped with a debug warning. Profile images are served via OIDC userinfo claims instead.

## 0.0.74

### Fixed
- **Cross-domain detection for subdomain OAuth**: Fixed `handleCallback()` cross-domain detection using `URL.host` comparison instead of `String.includes()`. Previously, `"auth.sigmaidentity.com".includes("sigmaidentity.com")` returned `true`, causing the plugin to incorrectly use same-domain mode (Mode B) when the auth server was on a subdomain. This broke OAuth for apps like `sigmaidentity.com` authenticating against `auth.sigmaidentity.com`.

## 0.0.70

### Fixed
- **Error format in handleCallback**: Updated error response parsing to use `error`/`details` keys instead of `title`/`message` to match the API route response format
- **PKCE code_verifier cleanup**: Added cleanup for `sigma_code_verifier` from sessionStorage after successful OAuth authentication to prevent stale data

## 0.0.69

### Fixed
- **handleCallback auto-detects cross-domain mode**: Fixed handleCallback to auto-detect cross-domain mode (Mode A vs Mode B)
  - Mode A (cross-domain): Routes to local API route to avoid CORS
  - Mode B (same-domain): Uses Better Auth $fetch for same-domain BA server
  - Plugin now works with simple handleCallback() in both modes

## 0.0.68

### Fixed
- **Session check blocking OAuth redirect**: The `signIn.sigma()` session check was comparing the raw session atom object (which is always truthy as `{ data: null, isPending: true, ... }`) instead of checking `atom.data`. Unauthenticated users were short-circuited before reaching the OAuth redirect. Now correctly checks `currentSession.data` which is `null` when no session exists.

## 0.0.66

### Fixed
- **Payload callback cookie not being set**: Reverted to Set-Cookie response header approach instead of `next/headers` `cookies().set()`, which doesn't reliably merge into `Response.json()` objects. This regression was introduced in 0.0.65 and caused the session cookie to never reach the browser, resulting in auth redirect loops.

## 0.0.65

### Fixed
- **Payload callback cookie name and signing**: `createPayloadCallbackHandler` now reads the correct cookie name and options from Better Auth's `authCookies` context instead of hardcoding `better-auth.session_token`. In production (HTTPS), Better Auth uses the `__Secure-` prefix, which was being missed. Also properly HMAC-signs the session token cookie to match Better Auth's `getSignedCookie()` verification.

## 0.0.64

### Added
- **`emailDomain` config option**: Apps can now control the fallback email domain for Sigma users who don't have an email set. Email is formatted as `{bapId}@{emailDomain}`. Defaults to `sigma.local`.

### Changed
- **Fallback email uses BAP ID**: When generating a fallback email, the BAP ID is now preferred over the random Sigma `sub` ID, producing meaningful addresses like `Go8vCHAa4S6AhXKTABGpANiz35J@myapp.com` instead of random strings.
- **Email updated on re-login**: The default update handler now includes `email` in the update payload, so existing users get their email corrected when they next sign in.

## 0.0.63

### Fixed
- **Session cookie HMAC signature format**: Changed from `base64url` to standard `base64` encoding to match better-call's `getSignedCookie()` verification which expects exactly 44 chars ending with `=`. This was the root cause of the auth redirect loop - the cookie was being set but Better Auth rejected the signature format when reading it back via `getSession()`.

### Removed
- **`setCookie` callback**: Removed from `BetterAuthCallbackConfig`. Next.js `cookies().set()` only merges into `NextResponse`, not plain `Response` objects. The Set-Cookie response header approach works correctly with standard `Response`.

## 0.0.59

### Fixed
- **OAuth callback cookie handling**: `handleCallback()` now uses Better Auth's `$fetch` wrapper instead of raw `fetch()`, ensuring proper `credentials: 'include'` for session cookie handling. This fixes the redirect loop where users would see "Welcome back" toast but land on `/login` instead of the intended destination.

## 0.0.58

### Fixed
- **Account record creation**: `createBetterAuthCallbackHandler` now properly creates account records in Better Auth's `account` table, enabling multi-provider authentication, account linking, and token refresh.

### Added
- **Architecture diagram**: README now includes a diagram showing how the plugin runs inside your app (not on the Sigma server).

## 0.0.57

### Fixed
- **Cookie attributes access**: Fixed null-safe cookie attribute access for Better Auth compatibility.

## 0.0.56

### Fixed
- **Cookie attributes access**: Fixed crash when setting session cookie - Better Auth uses `attributes` at runtime despite types saying `options`. The callback handler now correctly accesses `authCookies.sessionToken.attributes` with fallback to `options` for compatibility.

### Removed
- Railway environment variable fallback from origin detection

## 0.0.55

### Fixed
- **Type imports**: Import `Auth` type from `better-auth` instead of redefining custom `BetterAuthInstance` interface. This fixes type mismatches when consumers use the callback handler with their auth instance.

## 0.0.54

### Fixed
- **Type compatibility**: Fixed `adapter.update` return type to match Better Auth's `Promise<void | null>`

## 0.0.53

### Added
- **createBetterAuthCallbackHandler**: New callback handler for vanilla Next.js + Better Auth setups (same-domain, session cookie)
  - Import from `@sigma-auth/better-auth-plugin/next`
  - Exchanges OAuth code for tokens, creates/updates user, sets session cookie
  - Replaces 100+ lines of manual session creation code with a single function call
  - Supports custom `findUser`, `createUser`, and `updateUser` handlers

## 0.0.52

### Breaking Changes
- **Removed selectedBapId schema**: The `selectedBapId` field has been removed from `oauthAccessToken` and `oauthConsent` schemas. Use Better Auth's built-in `referenceId` field instead (set via `postLogin.consentReferenceId`).
- **Consent flow change**: The `/oauth2/consent` hook has been removed. BAP ID selection now uses:
  1. `organization.setActive({ organizationId: bapId })` to set `session.activeOrganizationId`
  2. `oauth2Continue({ postLogin: true })` to continue the OAuth flow
  3. `postLogin.consentReferenceId` returns the active organization ID
  4. Better Auth stores it in `oauthAccessToken.referenceId` automatically

### Added
- **Organization plugin helper**: New `createBapOrganization()` function that returns a pre-configured organization plugin for BAP identities:
  - Disables invitations (BAP IDs are personal)
  - Sets membership limit to 1 (single owner)
  - Creator is always the owner
- **Organization client export**: Re-exports `organizationClient` from Better Auth for consumer convenience
- **Organization types**: Re-exports `OrganizationOptions` type for TypeScript consumers

### Changed
- **Token hook updated**: The `/oauth2/token` AFTER hook now reads BAP ID from `referenceId` instead of querying `selectedBapId` from consent records
- **Tree-shaking imports**: Organization plugin imported from dedicated path per Better Auth best practices

### Deprecated
- **storeConsentBapId endpoint**: Marked as deprecated but kept for backwards compatibility. Use `organization.setActive()` + `oauth2Continue({ postLogin: true })` instead.

### Migration Guide
1. Add `createBapOrganization()` to your auth plugins
2. Configure `postLogin.consentReferenceId` in your oauth-provider config to return `session.activeOrganizationId`
3. Update consent UI to use `organization.setActive()` instead of calling `/sigma/store-consent-bap-id`
4. Run data migration to copy existing `selectedBapId` values to `referenceId`

## 0.0.51

### Changed
- **Standard OIDC Scopes**: Removed custom `bsv:tools` scope from OAuth requests - now uses standard OIDC scopes only (`openid profile`)
  - BSV/BAP claims are included in the `profile` scope response, no custom scopes needed
  - Fixes "invalid scope" errors when authenticating against servers without custom BSV scopes configured

### Documentation
- Updated all documentation to reference standard OIDC scopes instead of custom BSV scopes
- Clarified that BAP claims are part of the `profile` scope

## 0.0.50

### Added
- **Sync Client**: New `./client/sync` export for backup synchronization with sigma-auth cloud storage
  - `pushBackup()` - Push encrypted backup to cloud storage
  - `pullBackup()` - Pull encrypted backup from cloud storage
  - `checkBackupStatus()` - Check if cloud backup exists and get timestamp
  - Uses bitcoin-auth tokens signed by BAP member key for authentication

## 0.0.49

### Fixed
- **OAuth Token Hook**: Hash access token before database lookup to match oauth-provider's `storeTokens: "hashed"` behavior
  - The AFTER hook on `/oauth2/token` was querying by raw token but oauth-provider stores tokens hashed
  - Now uses `@better-auth/utils/hash` and `@better-auth/utils/base64` for compatible SHA-256 + base64url hashing
  - This fixes `selectedBapId` not being stored, causing userinfo to return no `pubkey`

## 0.0.47

### Security
- **Timing Attack Fix**: Use constant-time comparison (`timingSafeEqual`) for access token validation in `validateAccessToken()` to prevent timing-based attacks

## 0.0.46

### Fixed
- Reverted 0.0.45 changes - the correct fix is renaming the database column to `accessToken`, not changing the code

## 0.0.45 (BAD RELEASE - DO NOT USE)

### Broken
- Incorrectly changed adapter field to `token` - this breaks Better Auth schema expectations
- Use 0.0.46+ instead

## 0.0.44

### Fixed
- **Consent Hook**: Fix consent record lookup to use `updatedAt` instead of `createdAt`
  - When a user has consented to multiple OAuth clients, the hook was grabbing the wrong consent record
  - Existing consents get updated (not recreated), so `createdAt` stays old while `updatedAt` reflects the current operation
  - This was causing `selectedBapId` to be stored on the wrong consent, leaving the actual consent with NULL

## 0.0.43

### Fixed
- **Local Server Helpers**: Make `findState` return type allow optional `accessToken` for database record compatibility

## 0.0.42

### Added
- **LocalServerSigner**: New client class (`./client/local`) for communicating with local sigma-auth servers
- **Local Server Helpers**: New utilities (`./server/local`) for building sigma-auth server endpoints
  - `validateAccessToken()` - Reusable access token validation
  - `extractAccessToken()` - Extract Bearer token from Authorization header
  - `createErrorResponse()` - Standard error response format
  - Response type interfaces for sign, encrypt, decrypt, AIP operations
- **Server Detection**: `sigmaClient` now supports `preferLocal` option to auto-detect local servers

## 0.0.41

### Fixed
- **OAuth Token Hook**: Fixed adapter field name mismatch - use `accessToken` instead of `token` to match Better Auth schema
  - This was preventing `selectedBapId` from being stored in access tokens
  - Caused userinfo endpoint to return no pubkey for OAuth clients

## 0.0.32

### Changed
- **Client Plugin**: Properly use Better Auth's `$store` and `options` parameters in `getActions`
  - Use `options.baseURL` for auth server URL instead of hardcoded environment variable lookup
  - Check `$store.session` before OAuth redirect to skip if already signed in
  - Add `forceLogin` option to bypass session check when needed

### Added
- **`forceLogin` option**: New option in `signIn.sigma()` to force OAuth redirect even when session exists

## 0.0.31

### Fixed
- **Client Plugin Compatibility**: Simplified `getActions` to only accept `$fetch` parameter
  - Extra parameters are optional in better-auth plugin interface
  - Cleaner code without unused parameters

## 0.0.30

### Fixed
- **Client Plugin Compatibility**: Remove explicit type annotations from `getActions` to avoid BetterFetch type conflicts
  - Let TypeScript infer parameter types from `BetterAuthClientPlugin` interface
  - Fixes build errors with better-auth 1.4.10

## 0.0.29

### Fixed
- **Client Plugin Compatibility**: Updated `getActions` signature to match better-auth 1.4.10
  - Added `$store` and `options` parameters for compatibility with latest Better Auth client plugin interface

## 0.0.28

### Changed
- **OAuth Provider Migration**: Updated schema from `oauthApplication` to `oauthClient` (Better Auth standard)
- Sigma fields now use camelCase: `owner_bap_id` → `ownerBapId`
- `memberPubkey` is now a direct column instead of JSON metadata blob
- Updated all model references to use `oauthClient`

### Updated
- Dependencies: better-auth 1.4.10, @bsv/sdk 1.10.1, zod 4.3.5, biome 2.3.11

## 0.0.27

### Added
- Setup scripts and security documentation
- Cross-references between auth content

## 0.0.26

### Fixed
- `SigmaJWTPayload.bap_id` uses correct claim name (was `bapId`)
- `SigmaJWTPayload.bap` is typed as `string` (JSON-encoded BAP profile)

## 0.0.25

### Added
- `SigmaJWTPayload` type extending Better Auth's `JWTPayload` for typed JWT access tokens
- Export `SigmaJWTPayload` from client module

## 0.0.24

### Added
- Support `RAILWAY_PUBLIC_DOMAIN` environment variable for redirect URI detection

## 0.0.23

### Fixed
- Fix redirect URI detection behind reverse proxy

## 0.0.22

### Added
- **Admin plugin**: `getWalletAddresses` option to check NFT/token ownership across all connected wallets
  - Sums token balances across wallets for threshold checks
  - Checks any wallet for NFT collection ownership

### Changed
- Admin plugin now requires `getWalletAddresses` instead of relying on single BAP address

## 0.0.21

### Added
- **Admin plugin**: `sigmaAdminPlugin()` for Bitcoin-native role resolution
  - NFT collection ownership → role assignment
  - Token balance thresholds → role assignment
  - BAP ID whitelist for admin roles
  - Custom `extendRoles` callback for app-specific logic
  - Resolves roles on session creation and attaches to session

## 0.0.20

### Added
- **Error callback support**: Store and redirect to custom error pages
  - `errorCallbackURL` option in `signIn.sigma()` (default: `/auth/sigma/error`)
  - `authClient.sigma.getErrorCallbackURL()` - get stored error callback URL
  - `authClient.sigma.redirectToError(error)` - redirect with error details as query params
  - `parseErrorParams(searchParams)` helper in `/next` to parse error page params

### Fixed
- Removed unnecessary `export const runtime = "nodejs"` from `/next` module

## 0.0.19

### Changed
- **Breaking**: Default callback URLs changed to `/auth/sigma/callback`
  - `callbackURL` default: `/callback` → `/auth/sigma/callback`
  - `handleCallback()` internal fetch: `/api/auth/callback` → `/api/auth/sigma/callback`
  - Next.js handler `callbackPath` default: `/callback` → `/auth/sigma/callback`

### Fixed
- Admin plugin: Use `idKey` instead of `id` for BAP profile checks
- Admin plugin: Remove unused `adapter` parameter from `resolveUserRoles`

## 0.0.18

### Added
- NFT helpers: `authClient.nft.list()`, `authClient.nft.verifyOwnership()`
- Wallet management: `authClient.wallet.getConnected()`, `connect()`, `disconnect()`, `setPrimary()`
- Subscription tiers: `authClient.subscription.getStatus()`, `hasTier()`
- Signing helpers: `authClient.sigma.sign()`, `signAIP()`, `encrypt()`, `decrypt()`
- Identity management: `setIdentity()`, `getIdentity()`, `clearIdentity()`, `isReady()`

## 0.0.17 and earlier

Initial releases with core OAuth/PKCE flow and Better Auth integration.
