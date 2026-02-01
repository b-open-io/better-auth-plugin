---
name: setup-nextjs
description: Setup Sigma Auth OAuth integration in a Next.js application. Guides through installing @sigma-auth/better-auth-plugin, configuring environment variables, creating auth client, implementing sign-in flow, and setting up API routes for token exchange with Bitcoin-native authentication.
allowed-tools: "Bash(bun:*)"
---

# Setup Next.js with Sigma Auth

Guide for integrating Sigma Auth (Bitcoin-native authentication) into a Next.js application using the @sigma-auth/better-auth-plugin package.

## When to Use

- Setting up new Next.js app with Sigma Identity authentication
- Adding Bitcoin-native auth to existing Next.js project
- Implementing OAuth flow with auth.sigmaidentity.com
- Integrating BAP (Bitcoin Attestation Protocol) identity

## Scripts

### detect.ts - Project Analysis

Analyzes your project structure and provides setup recommendations.

```bash
# Analyze current directory
bun run scripts/detect.ts

# Analyze specific project
bun run scripts/detect.ts /path/to/project
```

**Output:** JSON report including:
- Framework detection (Next.js App Router, Pages Router, Payload CMS)
- Package manager detection
- Directory structure
- Existing auth configuration
- Recommendations for setup

### validate-env.ts - Environment Validation

Validates required environment variables and checks WIF format.

```bash
# Check environment from .env.local or .env
bun run scripts/validate-env.ts

# Check specific env file
bun run scripts/validate-env.ts .env.production
```

**Output:** JSON report with status of each required variable.

### health-check.ts - Integration Health Check

Tests connection to Sigma Auth server and validates OAuth configuration.

```bash
# Check default auth server
bun run scripts/health-check.ts

# Check specific auth server
bun run scripts/health-check.ts https://auth.sigmaidentity.com
```

**Output:** JSON report including:
- Auth server connectivity
- OpenID configuration availability
- JWKS endpoint status
- Response latency

## Installation

```bash
bun add @sigma-auth/better-auth-plugin
```

## Quick Start

### Choose Your Integration Mode

- **Mode A — OAuth client (cross-domain)**: Your app is **not** the auth server. You handle tokens locally.
- **Mode B — Same-domain Better Auth server**: You run Better Auth (or proxy to Convex/another backend) on your own domain and can use sessions.

---

### Mode A — OAuth Client (Cross-Domain)

Use this when your users authenticate against `auth.sigmaidentity.com` (or another Better Auth server) on a **different** domain.

#### 1. Environment Variables (`.env.local`)

```bash
# Public variables
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com

# Private variables (server-only)
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif-key

# Optional (needed behind proxies for correct redirect_uri)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

#### 2. Client Configuration (`lib/auth-client.ts`)

```typescript
import { createAuthClient } from "better-auth/react";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: "/api/auth", // default; points to your app's API routes
  plugins: [sigmaClient()],
});

export const { signIn } = authClient;
```

> If you are **not** using React hooks, import `createAuthClient` from `"better-auth/client"` instead.
>
> For cross-domain OAuth, manage user state locally (cookies/local state). `useSession` only works in Mode B.

#### 3. Token Exchange API (`app/api/auth/sigma/callback/route.ts`)

```typescript
import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";

export const runtime = "nodejs";
export const POST = createCallbackHandler();
```

#### 4. OAuth Callback Page (`app/auth/sigma/callback/page.tsx`)

This page handles the OAuth redirect and stores tokens locally.

```typescript
const result = await authClient.sigma.handleCallback(searchParams);
// result contains { access_token, user, ... } - store manually
```

#### 5. Sign-In Component

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

---

### Mode B — Same-Domain Better Auth Server (Prisma/Convex/Other)

Use this when your app runs Better Auth on the **same domain** (or proxies to it).
If you're using **Convex**, follow `setup-convex` for the exact wiring.

#### 1. Environment Variables (`.env.local`)

```bash
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif-key
```

#### 2. Server Configuration (`lib/auth.ts`)

Add `sigmaCallbackPlugin` to your Better Auth server config. It registers `POST /sigma/callback` inside Better Auth.

```typescript
import { betterAuth } from "better-auth";
import { sigmaCallbackPlugin } from "@sigma-auth/better-auth-plugin/server";

export const auth = betterAuth({
  plugins: [
    sigmaCallbackPlugin({
      // Optional overrides (defaults to env vars)
      // clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID,
      // memberPrivateKey: process.env.SIGMA_MEMBER_PRIVATE_KEY,
    })
  ],
  // ... other config (database, etc.)
});
```

#### 3. API Route (`app/api/auth/[...all]/route.ts`)

Expose Better Auth in Next.js. The plugin endpoint becomes `/api/auth/sigma/callback`.

```typescript
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { POST, GET } = toNextJsHandler(auth);
```

#### 4. Client Configuration (`lib/auth-client.ts`)

```typescript
import { createAuthClient } from "better-auth/react";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: "/api/auth",
  plugins: [sigmaClient()],
});

export const { signIn, useSession } = authClient;
```

#### 5. OAuth Callback Page (`app/auth/sigma/callback/page.tsx`)

Still required because OAuth redirects are GETs. In this mode you can rely on session cookies instead of storing tokens manually.

---

## Security Considerations

⚠️ **Environment Variables**: Never expose `SIGMA_MEMBER_PRIVATE_KEY` to the client. It is required only on the server for signing token exchange requests.

⚠️ **Token Storage**: In Mode A, store tokens securely (avoid `localStorage` for refresh tokens in production).

**Same-Domain Sessions**: `useSession` only works when your auth server is on the same domain (Mode B).

**Wallet Unlock Gate**: Plugin ensures wallet access before authentication (session → local backup → cloud backup → signup).

**PKCE**: The client plugin automatically handles PKCE (Proof Key for Code Exchange) for secure OAuth flows.

## Reference

Full documentation: https://github.com/b-open-io/better-auth-plugin
