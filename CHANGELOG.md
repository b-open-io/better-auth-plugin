# Changelog

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
