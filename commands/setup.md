---
description: Setup Sigma Auth in your application - guides through installation, environment configuration, and OAuth flow setup
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: [nextjs|payload|generic] - framework to configure (default: nextjs)
---

# Sigma Auth Setup

Quick setup guide for integrating Sigma Identity authentication.

## Your Task

Based on the argument provided (or default to nextjs):

1. **nextjs**: Setup @sigma-auth/better-auth-plugin in Next.js
2. **payload**: Setup with Payload CMS integration
3. **generic**: Show generic OAuth client setup

## Next.js Setup (Default)

### 1. Install Dependencies

```bash
bun add @sigma-auth/better-auth-plugin better-auth
```

### 2. Environment Variables

Create `.env.local`:

```bash
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif-key
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

### 3. Create Auth Client

Create `lib/auth.ts`:

```typescript
import { createAuthClient } from "better-auth/client";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL!,
  plugins: [sigmaClient()],
});

export const signIn = authClient.signIn;
```

### 4. Token Exchange API Route

Create `app/api/auth/sigma/callback/route.ts`:

```typescript
import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";

export const runtime = "nodejs";
export const POST = createCallbackHandler();
```

### 5. Callback Page

Create `app/auth/sigma/callback/page.tsx`:

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

### 6. Sign In Button

```typescript
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

## Payload CMS Setup

### 1. Install Dependencies

```bash
bun add @sigma-auth/better-auth-plugin payload-auth
```

### 2. Callback Handler

Create `app/api/auth/sigma/callback/route.ts`:

```typescript
import configPromise from "@payload-config";
import { createPayloadCallbackHandler } from "@sigma-auth/better-auth-plugin/payload";

export const runtime = "nodejs";
export const POST = createPayloadCallbackHandler({
  configPromise,
  createUser: async (payload, sigmaUser) => {
    return payload.create({
      collection: "users",
      data: {
        email: sigmaUser.email || `${sigmaUser.sub}@sigma.identity`,
        name: sigmaUser.name || sigmaUser.sub,
        bapId: sigmaUser.bap_id,
        pubkey: sigmaUser.pubkey,
      },
    });
  },
});
```

## OAuth Flow Overview

1. User clicks "Sign in with Sigma"
2. Redirects to auth.sigmaidentity.com
3. User authenticates with Bitcoin wallet
4. Callback with authorization code
5. Exchange code for tokens (server-side)
6. Store user data locally (cross-domain cookies don't work)

## OAuth Provider Setup (Running Your Own Auth Server)

If you're building an OAuth **provider** (like auth.sigmaidentity.com or TokenPass), you need BOTH `sigmaProvider` AND `oauthProvider` plugins.

### 1. Install Dependencies

```bash
bun add @sigma-auth/better-auth-plugin @better-auth/oauth-provider better-auth postgres
```

### 2. Server Auth Configuration (`lib/auth.ts`)

```typescript
import { oauthProvider } from "@better-auth/oauth-provider";
import { sigmaProvider } from "@sigma-auth/better-auth-plugin/provider";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

export const auth = betterAuth({
  database: getDatabase(), // Your database connection
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: "http://localhost:21000", // Your server URL

  plugins: [
    // Sigma plugin - adds pubkey field and Bitcoin/BAP authentication
    sigmaProvider({
      debug: process.env.NODE_ENV === "development",
    }),

    // OAuth Provider - enables your app as an OAuth 2.1 server
    oauthProvider({
      loginPage: "/auth",
      consentPage: "/consent",
      allowDynamicClientRegistration: true,
      defaultScope: "openid profile",
      scopes: [
        "openid",          // OIDC ID token
        "profile",         // User profile + BSV pubkey/BAP claims
        "email",           // Email access
        "offline_access",  // Refresh tokens
      ],
    }),

    nextCookies(),
  ],

  session: {
    storeSessionInDatabase: true,
  },

  // Allow clients from different ports during development
  trustedOrigins: [
    "http://localhost:21000",
    "http://localhost:4200",
    "http://localhost:3000",
  ],
});
```

### 3. API Route (`app/api/auth/[...all]/route.ts`)

```typescript
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth.handler);
```

### Common Mistake: Missing oauthProvider

If you see this error:
```
The following scopes are invalid: openid, profile
```

It means you're missing the `oauthProvider` plugin. The `oauthProvider` is required to handle OAuth flows and scope validation.

## Key Concepts

- **Cross-Domain**: Better Auth's `useSession` only works same-domain. Manage state with tokens.
- **PKCE**: Automatically handled by the client plugin
- **BAP Identity**: Available in `result.user.bap` after authentication
- **Provider vs Client**: `sigmaProvider` = run your own auth server; `sigmaClient` = authenticate against Sigma Identity

## Reference

Full documentation: https://github.com/b-open-io/better-auth-plugin
