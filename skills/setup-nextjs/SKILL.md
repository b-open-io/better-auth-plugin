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

### 1. Environment Variables (`.env.local`)

```bash
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif-key
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

### 2. Create Auth Client (`lib/auth.ts`)

```typescript
import { createAuthClient } from "better-auth/client";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL!,
  plugins: [sigmaClient()],
});

export const signIn = authClient.signIn;
```

### 3. Sign-In Component

```typescript
"use client";
import { signIn } from "@/lib/auth";

export function SignInButton() {
  return (
    <button onClick={() => signIn.sigma({
      clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID!,
      callbackURL: "/auth/sigma/callback",
    })}>
      Sign in with Sigma
    </button>
  );
}
```

### 4. Callback Page (`app/auth/sigma/callback/page.tsx`)

```typescript
"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth";

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const result = await authClient.sigma.handleCallback(searchParams);
        localStorage.setItem("sigma_user", JSON.stringify(result.user));
        localStorage.setItem("sigma_access_token", result.access_token);
        router.push("/");
      } catch (err: any) {
        setError(err.message || "Authentication failed");
      }
    };
    handleCallback();
  }, [searchParams, router]);

  if (error) return <div>Error: {error}</div>;
  return <div>Completing sign in...</div>;
}

export default function CallbackPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CallbackContent />
    </Suspense>
  );
}
```

### 5. Token Exchange API (`app/api/auth/sigma/callback/route.ts`)

```typescript
import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";

export const runtime = "nodejs";
export const POST = createCallbackHandler();
```

## OAuth Flow

1. User clicks "Sign in with Sigma"
2. Redirects to auth.sigmaidentity.com
3. User authenticates with Bitcoin wallet
4. Callback with code → exchange for tokens
5. Store tokens locally (cross-domain cookies don't work)
6. Redirect to dashboard

## Security Considerations

⚠️ **Token Storage Warning**: The examples above store tokens in `localStorage` for simplicity. For production:

- Consider using HTTP-only cookies for refresh tokens
- Implement token refresh logic
- Use secure session management
- Never expose `SIGMA_MEMBER_PRIVATE_KEY` to the client

## Key Concepts

**Cross-Domain OAuth**: Better Auth's `useSession` only works when auth server is on same domain. For OAuth with Sigma Identity, manage state with tokens stored locally.

**Wallet Unlock Gate**: Plugin ensures wallet access before authentication (session → local backup → cloud backup → signup).

**PKCE**: The client plugin automatically handles PKCE (Proof Key for Code Exchange) for secure OAuth flows.

## Reference

Full documentation: https://github.com/b-open-io/better-auth-plugin
