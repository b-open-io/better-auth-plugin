---
name: setup-nextjs
description: Setup Sigma Auth OAuth integration in a Next.js application. Guides through installing @sigma-auth/better-auth-plugin, configuring environment variables, creating auth client, implementing sign-in flow, and setting up API routes for token exchange with Bitcoin-native authentication.
---

# Setup Next.js with Sigma Auth

Guide for integrating Sigma Auth (Bitcoin-native authentication) into a Next.js application using the @sigma-auth/better-auth-plugin package.

## When to Use

- Setting up new Next.js app with Sigma Identity authentication
- Adding Bitcoin-native auth to existing Next.js project
- Implementing OAuth flow with auth.sigmaidentity.com
- Integrating BAP (Bitcoin Attestation Protocol) identity

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
    <button onClick={() => signIn.social({ provider: "sigma", callbackURL: "/dashboard" })}>
      Sign in with Sigma
    </button>
  );
}
```

### 4. Token Exchange API Route

**App Router** (`app/api/auth/callback/sigma/route.ts`):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@sigma-auth/better-auth-plugin/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  
  const tokenData = await exchangeCodeForToken({
    code: code!,
    authServerURL: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL!,
    clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID!,
    memberPrivateKey: process.env.SIGMA_MEMBER_PRIVATE_KEY!,
    redirectURI: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/sigma`,
  });

  const response = NextResponse.redirect(new URL("/dashboard", request.url));
  response.cookies.set("access_token", tokenData.access_token, {
    httpOnly: true,
    secure: true,
    maxAge: tokenData.expires_in,
  });

  return response;
}
```

## OAuth Flow

1. User clicks "Sign in with Sigma"
2. Redirects to auth.sigmaidentity.com
3. User authenticates with Bitcoin wallet
4. Callback with code → exchange for tokens
5. Store tokens in HTTP-only cookies
6. Redirect to dashboard

## Key Concepts

**Cross-Domain OAuth**: Better Auth's `useSession` only works when auth server is on same domain. For OAuth, manage state with tokens/cookies.

**Wallet Unlock Gate**: Plugin ensures wallet access before authentication (session → local backup → cloud backup → signup).

**Security**: `SIGMA_MEMBER_PRIVATE_KEY` is server-only. Use HTTP-only cookies. Enable HTTPS in production.

## Reference

Full documentation in `/.flow/repos/better-auth-plugin/README.md`
