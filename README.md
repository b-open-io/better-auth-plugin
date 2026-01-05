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
- **`/payload`** - Payload CMS integration with session management
- **`/provider`** - Better Auth server plugin for OIDC provider

## Architecture

### OAuth Flow (Cross-Domain)

When your app authenticates with Sigma Identity (or another Better Auth server on a different domain), you use OAuth/OIDC flow with tokens:

1. User clicks sign in → redirects to `auth.sigmaidentity.com`
2. User authenticates with Bitcoin wallet
3. Redirects back to your app with authorization code
4. Your backend exchanges code for access tokens
5. **Store user data and tokens locally** (Context, Zustand, localStorage, etc.)

**Important:** Cross-domain cookies don't work due to browser security. Better Auth's `useSession` hook only works when the auth server is on the **same domain** as your app. For OAuth clients, you manage authentication state locally with tokens.

### Wallet Unlock Gate

This plugin fronts Better Auth's OIDC authorize endpoint to ensure wallet access is a prerequisite to authentication.

The client redirects to `/oauth2/authorize` (custom gate) instead of `/api/auth/oauth2/authorize` (Better Auth directly). The gate checks:

1. **Session** - If authenticated, proceed immediately
2. **Local backup** - If encrypted backup exists, prompt for password
3. **Cloud backup** - If available, redirect to restore
4. **Signup** - No backup found, create new account

This makes Bitcoin identity the foundation of authentication.

## Quick Start (OAuth Client)

This is the standard setup for apps authenticating with Sigma Identity.

### 1. Environment Variables

```bash
# Your registered OAuth client ID
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app

# Member private key for signing token exchange requests (server-side only)
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif

# Sigma Auth server URL
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

### 2. Create Auth Client

```typescript
// lib/auth.ts
import { createAuthClient } from "better-auth/client";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL || "https://auth.sigmaidentity.com",
  plugins: [sigmaClient()],
});

// Export sign in method for OAuth flow
export const signIn = authClient.signIn;
```

### 3. Token Exchange API Route

This server-side endpoint exchanges the OAuth code for tokens.

```typescript
// app/api/auth/sigma/callback/route.ts
import { createCallbackHandler } from "@sigma-auth/better-auth-plugin/next";

export const runtime = "nodejs";
export const POST = createCallbackHandler();
```

### 4. OAuth Callback Page

This page handles the OAuth redirect and stores the authenticated user.

```typescript
// app/auth/sigma/callback/page.tsx
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
        // Exchange code for tokens and get user data
        const result = await authClient.sigma.handleCallback(searchParams);

        // Store user data in your app's state management
        // Example: Context, Zustand, localStorage, etc.
        localStorage.setItem("sigma_user", JSON.stringify(result.user));
        localStorage.setItem("sigma_access_token", result.access_token);
        localStorage.setItem("sigma_id_token", result.id_token);
        if (result.refresh_token) {
          localStorage.setItem("sigma_refresh_token", result.refresh_token);
        }

        // Redirect to your app
        router.push("/");
      } catch (err: any) {
        console.error("OAuth callback error:", err);
        setError(err.message || "Authentication failed");
      }
    };

    handleCallback();
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-red-600">Authentication Failed</h2>
          <p className="mt-2 text-sm text-gray-600">{error}</p>
          <button
            onClick={() => router.push("/")}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Completing sign in...</h2>
        <p className="mt-2 text-sm text-gray-600">Please wait</p>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CallbackContent />
    </Suspense>
  );
}
```

### 5. Sign In

```typescript
// In your sign-in button component
import { signIn } from "@/lib/auth";

const handleSignIn = () => {
  signIn.sigma({
    clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID || "your-app",
    // callbackURL defaults to /auth/sigma/callback
  });
};
```

### 6. Access User Data

Since you're managing state locally, access user data from your state management solution:

```typescript
// Example with Context
import { createContext, useContext, useEffect, useState } from "react";

const AuthContext = createContext<{ user: SigmaUserInfo | null }>({ user: null });

export function AuthProvider({ children }) {
  const [user, setUser] = useState<SigmaUserInfo | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem("sigma_user");
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
  }, []);

  return <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// In components
const { user } = useAuth();
const isAdmin = user?.bap?.idKey === process.env.ADMIN_BAP_ID;
```

## Alternative: Same-Domain Setup

If you run your own Better Auth server on the **same domain** as your app, you can use session cookies and the `useSession` hook:

```typescript
// lib/auth.ts
export const authClient = createAuthClient({
  baseURL: "/api/auth", // Same domain
  plugins: [sigmaClient()],
});

export const { useSession } = authClient;

// In components
const { data: session } = useSession();
```

This requires setting up Better Auth server with the Sigma provider plugin on your domain.

## Payload CMS Integration

For Payload CMS apps using [payload-auth](https://github.com/b-open-io/payload-auth), the `/payload` entry point provides a callback handler that automatically:

1. Exchanges the authorization code for tokens
2. Finds or creates a user in your Payload users collection
3. Creates a better-auth session in Payload's sessions collection
4. Sets the session cookie

### Setup

```typescript
// app/api/auth/sigma/callback/route.ts
import configPromise from "@payload-config";
import { createPayloadCallbackHandler } from "@sigma-auth/better-auth-plugin/payload";

export const runtime = "nodejs";
export const POST = createPayloadCallbackHandler({ configPromise });
```

### Custom User Creation

Override the default user creation to add custom fields:

```typescript
export const POST = createPayloadCallbackHandler({
  configPromise,
  createUser: async (payload, sigmaUser) => {
    return payload.create({
      collection: "users",
      data: {
        email: sigmaUser.email || `${sigmaUser.sub}@sigma.identity`,
        name: sigmaUser.name || sigmaUser.sub,
        emailVerified: true,
        role: ["subscriber"], // Custom role
        bapId: sigmaUser.bap_id,
        pubkey: sigmaUser.pubkey,
      },
    });
  },
});
```

### Configuration Options

```typescript
interface PayloadCallbackConfig {
  /** Payload config promise (required) */
  configPromise: Promise<unknown>;

  /** Sigma Auth server URL (default: NEXT_PUBLIC_SIGMA_AUTH_URL) */
  issuerUrl?: string;

  /** OAuth client ID (default: NEXT_PUBLIC_SIGMA_CLIENT_ID) */
  clientId?: string;

  /** Member private key (default: SIGMA_MEMBER_PRIVATE_KEY env) */
  memberPrivateKey?: string;

  /** Callback path (default: /auth/sigma/callback) */
  callbackPath?: string;

  /** Users collection slug (default: "users") */
  usersCollection?: string;

  /** Sessions collection slug (default: "sessions") */
  sessionsCollection?: string;

  /** Session cookie name (default: "better-auth.session_token") */
  sessionCookieName?: string;

  /** Session duration in ms (default: 30 days) */
  sessionDuration?: number;

  /** Custom user creation handler */
  createUser?: (payload, sigmaUser) => Promise<{ id: string | number }>;

  /** Custom user lookup handler */
  findUser?: (payload, sigmaUser) => Promise<{ id: string | number } | null>;
}
```

### Response

The callback returns `PayloadCallbackResult`:

```typescript
{
  user: SigmaUserInfo;        // Sigma identity data
  access_token: string;       // Access token
  id_token: string;           // OIDC ID token
  refresh_token?: string;     // Refresh token (if issued)
  payloadUserId: string;      // Local Payload user ID
  isNewUser: boolean;         // True if user was just created
}
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

## Key Concepts

### OAuth Endpoints

When using OAuth flow, there are **two different endpoints**:

1. **OAuth Redirect URI** (`/auth/sigma/callback`) - Where the auth server redirects after authorization
2. **Token Exchange API** (`/api/auth/sigma/callback`) - Internal endpoint that exchanges code for tokens

The redirect URI is what you configure in your OAuth client settings. The token exchange API is called internally by your callback page.

### Authentication Result

After successful authentication via `handleCallback()`, you receive:

```typescript
{
  user: {
    sub: string;              // User ID
    name?: string;            // Display name
    email?: string;           // Email (if available)
    picture?: string;         // Avatar URL
    pubkey: string;           // Bitcoin public key
    bap?: {                   // BAP identity (if available)
      idKey: string;          // BAP ID
      identity: {
        name?: string;
        alternateName?: string;
        description?: string;
        // ... other BAP profile fields
      };
    };
  };
  access_token: string;       // Access token for API calls
  id_token: string;           // JWT ID token (OIDC)
  refresh_token?: string;     // Refresh token (if issued)
}
```

## Features

- PKCE flow for public clients
- Bitcoin Auth signatures for secure token exchange
- BAP (Bitcoin Attestation Protocol) identity support
- Multi-identity wallet support
- Subscription tier verification via NFT ownership
- Type-safe with full TypeScript support
- Full OIDC compliance with ID tokens

## Documentation

Full documentation: [https://sigmaidentity.com/docs](https://sigmaidentity.com/docs)

## License

MIT
