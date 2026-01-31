# Changelog

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
