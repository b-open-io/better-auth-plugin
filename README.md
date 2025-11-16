# @sigma-auth/better-auth-plugin

Better Auth plugins for Sigma Identity - Bitcoin-native authentication with BAP identity support.

## Installation

```bash
bun add @sigma-auth/better-auth-plugin
# or
npm install @sigma-auth/better-auth-plugin
```

## Entry Points

This package provides multiple entry points for different use cases:

- **`/client`** - Browser-side OAuth client with PKCE
- **`/server`** - Server-side utilities for token exchange
- **`/next`** - Next.js API route handlers
- **`/provider`** - Better Auth server plugin for OIDC provider

## Architecture: Fronting Better Auth

This plugin intentionally fronts Better Auth's OIDC authorize endpoint to ensure wallet access is a prerequisite to authentication.

The client redirects to `/oauth2/authorize` (custom gate) instead of `/api/auth/oauth2/authorize` (Better Auth directly). The gate checks:

1. **Session** - If authenticated, proceed immediately
2. **Local backup** - If encrypted backup exists, prompt for password
3. **Cloud backup** - If available, redirect to restore
4. **Signup** - No backup found, create new account

This makes Bitcoin identity the foundation of authentication.

## Quick Start (Next.js Client App)

### 1. Create Auth Client

```typescript
import { createAuthClient } from "better-auth/client";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: "https://auth.sigmaidentity.com",
  plugins: [sigmaClient()],
});
```

### 2. Sign In

```typescript
authClient.signIn.sigma({
  clientId: "your-app",
  callbackURL: "/callback",
});
```

### 3. Handle Callback

```typescript
import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";

export const runtime = "nodejs";
export const POST = createCallbackHandler();
```

## Server Plugin (Auth Provider)

For building your own Sigma Identity server:

```typescript
import { betterAuth } from "better-auth";
import { sigmaProvider } from "@sigma-auth/better-auth-plugin/provider";

export const auth = betterAuth({
  plugins: [
    sigmaProvider({
      enableSubscription: true,
      resolveBAPId: async (pool, userId, pubkey, register) => {
        // Your BAP ID resolution logic
      },
      getPool: () => database,
      cache: redisCache,
    }),
  ],
});
```

## Features

- PKCE flow for public clients
- Bitcoin Auth signatures for secure token exchange
- BAP (Bitcoin Attestation Protocol) identity support
- Multi-identity wallet support
- Subscription tier verification via NFT ownership
- Type-safe with full TypeScript support

## Environment Variables

```bash
# Client App
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

## Documentation

Full documentation: [https://sigmaidentity.com/docs](https://sigmaidentity.com/docs)

## License

MIT
