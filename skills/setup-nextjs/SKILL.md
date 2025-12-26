---
name: setup-nextjs
description: Guide for integrating Sigma Auth (Bitcoin-native authentication) into Next.js applications using Better Auth and the @sigma-auth/better-auth-plugin package. Covers OAuth client setup, API routes, wallet unlock gate, and session management.
---

# Setup Sigma Auth in Next.js

Integrate Bitcoin-native authentication using Sigma Identity and Better Auth.

## When to Use

- Setting up OAuth authentication with Sigma Identity
- Integrating Bitcoin wallet-based login
- Implementing BAP identity authentication
- Configuring Better Auth in Next.js

## Quick Start

### 1. Install Package

```bash
bun add @sigma-auth/better-auth-plugin
# or
npm install @sigma-auth/better-auth-plugin
```

### 2. Environment Variables

```bash
# .env.local
NEXT_PUBLIC_SIGMA_CLIENT_ID=your-app-name
SIGMA_MEMBER_PRIVATE_KEY=your-member-wif
NEXT_PUBLIC_SIGMA_AUTH_URL=https://auth.sigmaidentity.com
```

### 3. Create Auth Client

```typescript
// lib/auth.ts
import { createAuthClient } from "better-auth/client";
import { sigmaClient } from "@sigma-auth/better-auth-plugin/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL || "https://auth.sigmaidentity.com",
  plugins: [sigmaClient()],
});

export const signIn = authClient.signIn;
```

### 4. Add API Routes

```typescript
// app/api/auth/callback/route.ts
import { handleCallback } from "@sigma-auth/better-auth-plugin/next";

export const GET = handleCallback({
  memberPrivateKey: process.env.SIGMA_MEMBER_PRIVATE_KEY!,
  clientId: process.env.NEXT_PUBLIC_SIGMA_CLIENT_ID!,
  authServerUrl: process.env.NEXT_PUBLIC_SIGMA_AUTH_URL!,
  redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`,
  onSuccess: (tokens) => ({
    redirect: "/dashboard",
  }),
  onError: (error) => ({
    redirect: `/error?message=${encodeURIComponent(error.message)}`,
  }),
});
```

### 5. Sign In Component

```typescript
// components/SignInButton.tsx
"use client";
import { signIn } from "@/lib/auth";

export function SignInButton() {
  const handleSignIn = async () => {
    await signIn.social({
      provider: "sigma",
      callbackURL: "/api/auth/callback",
    });
  };

  return <button onClick={handleSignIn}>Sign in with Bitcoin</button>;
}
```

## Architecture

**OAuth Flow**: Cross-domain authentication with Sigma Identity
- User redirects to `auth.sigmaidentity.com`
- Authenticates with Bitcoin wallet
- Returns authorization code
- Your app exchanges code for tokens
- Store tokens and user data locally

**Important**: Cross-domain cookies don't work. Better Auth's `useSession` only works same-domain. For OAuth clients, manage auth state locally with tokens.

## Wallet Unlock Gate

The plugin provides a wallet unlock gate that fronts Better Auth's OIDC authorize endpoint:

1. **Session** - If authenticated, proceed
2. **Local backup** - If encrypted backup exists, prompt password
3. **Cloud backup** - Redirect to restore
4. **Signup** - No backup, create account

This ensures Bitcoin identity is the foundation of authentication.

## Session Management

Store authentication state locally:

```typescript
// Store tokens after callback
localStorage.setItem("sigma_tokens", JSON.stringify(tokens));

// Create session context
const [user, setUser] = useState(null);

useEffect(() => {
  const tokens = localStorage.getItem("sigma_tokens");
  if (tokens) {
    // Fetch user info with access token
    fetchUserInfo(JSON.parse(tokens).access_token)
      .then(setUser);
  }
}, []);
```

## Advanced: Custom Provider

To run your own Sigma Auth server:

```typescript
// lib/auth-server.ts
import { betterAuth } from "better-auth";
import { sigmaProvider } from "@sigma-auth/better-auth-plugin/provider";

export const auth = betterAuth({
  database: { /* your DB config */ },
  plugins: [
    sigmaProvider({
      walletUnlockGate: true, // Enable wallet gate
    }),
  ],
});
```

## Testing

Test OAuth flow locally:
1. Set `NEXT_PUBLIC_SIGMA_AUTH_URL=http://localhost:3001`
2. Run local Sigma Auth server on port 3001
3. Register your app as OAuth client
4. Test sign in flow

## Troubleshooting

**"Invalid redirect URI"**: Ensure callback URL matches registered OAuth client
**"Missing member key"**: Set `SIGMA_MEMBER_PRIVATE_KEY` environment variable
**Session not persisting**: Check localStorage, implement proper token storage
**CORS errors**: Verify `NEXT_PUBLIC_SIGMA_AUTH_URL` is correct

## Resources

- Package README: See root README.md for full API documentation
- Example flows: Check `/src` for client/server implementations
- OAuth spec: Better Auth OIDC documentation
