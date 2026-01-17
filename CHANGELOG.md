# Changelog

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
