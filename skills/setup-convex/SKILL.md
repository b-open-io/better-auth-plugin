---
name: setup-convex
description: Setup Sigma Auth OAuth integration in a Convex application. Guides through installing @sigma-auth/better-auth-plugin, configuring Convex environment variables, and setting up the auth server.
allowed-tools: "Bash(bun:*)"
---

# Setup Convex with Sigma Auth

Guide for integrating Sigma Auth (Bitcoin-native authentication) into a Convex application using the `@sigma-auth/better-auth-plugin` package.

## When to Use

- Building a Convex backend with Better Auth
- Adding Bitcoin-native auth to a Convex app
- Implementing OAuth flow with auth.sigmaidentity.com
- Integrating BAP (Bitcoin Attestation Protocol) identity
 - If you are **not** using Convex, follow Mode B in `setup-nextjs` instead

## Installation

```bash
bun add @sigma-auth/better-auth-plugin
```

## Quick Start

### 1. Environment Variables

**Next.js app (`.env.local`)**

```bash
# Convex + Next.js bridge
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-site-url

# Public variables (prefix depends on your framework, e.g., VITE_ or NEXT_PUBLIC_)
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

**Convex deployment (dashboard or CLI)**

```bash
bunx convex env set SITE_URL "https://your-site-url"
bunx convex env set BETTER_AUTH_SECRET "your-random-secret"
bunx convex env set NEXT_PUBLIC_SIGMA_CLIENT_ID "your-app-name"
bunx convex env set NEXT_PUBLIC_SIGMA_AUTH_URL "https://auth.sigmaidentity.com"
bunx convex env set SIGMA_MEMBER_PRIVATE_KEY "your-member-wif-key"
```

### 2. Server Configuration (`convex/auth.ts`)

Add the `sigmaCallbackPlugin` to your Better Auth server configuration. This runs inside the Convex environment.

```typescript
import { betterAuth } from "better-auth/minimal";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { sigmaCallbackPlugin } from "@sigma-auth/better-auth-plugin/server";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth({
  baseURL: process.env.SITE_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: authComponent.adapter(ctx),
  plugins: [
    convex({ authConfig }),
    sigmaCallbackPlugin({
      // Optional overrides (defaults to env vars)
      // clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID,
      // memberPrivateKey: process.env.SIGMA_MEMBER_PRIVATE_KEY,
    })
  ],
});
```

### 3. Client Configuration

Configure the client to use the `sigmaClient` plugin.

```typescript
import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  plugins: [
    convexClient(),
    sigmaClient(),
  ],
});

export const { signIn, useSession } = authClient;
```

### 4. OAuth Callback Page (`app/auth/sigma/callback/page.tsx`)

Required because OAuth redirects are GETs. Use `handleCallback` and rely on session cookies.

```typescript
const result = await authClient.sigma.handleCallback(searchParams);
```

### 5. Sign-In Component

```typescript
"use client";
import { signIn } from "@/lib/auth-client";

export function SignInButton() {
  return (
    <button onClick={() => signIn.sigma({
      clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID!,
      // callbackURL defaults to /auth/sigma/callback
    })}>
      Sign in with Sigma
    </button>
  );
}
```

## How It Works

1. **Client**: The `sigmaClient` initiates the OAuth flow, redirecting to `auth.sigmaidentity.com`.
2. **Callback**: The user is redirected back to `/auth/sigma/callback`.
3. **Server Plugin**: The `sigmaCallbackPlugin` running in Convex:
   - Intercepts the callback.
   - Exchanges the authorization code for tokens using the server-side `SIGMA_MEMBER_PRIVATE_KEY`.
   - Creates or updates the user in the Convex database (via Better Auth's internal adapter).
   - Establishes a session.

## HTTP Actions

In your Next.js app, proxy `/api/auth/*` to Convex using `@convex-dev/better-auth/nextjs`.

```typescript
// lib/auth-server.ts
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

export const { handler } = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
});
```

```typescript
// app/api/auth/[...all]/route.ts
import { handler } from "@/lib/auth-server";

export const { GET, POST } = handler;
```

In your Next.js app, proxy `/api/auth/*` to Convex (see `@convex-dev/better-auth` docs). The Sigma plugin endpoint is `/api/auth/sigma/callback` when proxied.

## Security

- **Private Key**: The `SIGMA_MEMBER_PRIVATE_KEY` is critical for signing token exchange requests. Ensure it is stored securely in Convex environment variables and never exposed to the client.
- **PKCE**: Handled automatically by the client/server plugin combination.

## Reference

Full documentation: https://github.com/b-open-io/better-auth-plugin
