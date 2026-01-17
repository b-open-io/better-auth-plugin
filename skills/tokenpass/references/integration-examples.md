# TokenPass Integration Examples

Code examples for common TokenPass integrations.

## Basic Setup

### TypeScript Client

```typescript
class TokenPassClient {
  private baseUrl = 'http://localhost:21000';
  private accessToken?: string;

  async login(password: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
  }

  async getToken(password: string, host: string, options?: {
    expire?: string;
    scopes?: string;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password,
        host,
        expire: options?.expire || '1h',
        scopes: options?.scopes || 'sign'
      })
    });
    const { accessToken } = await res.json();
    this.accessToken = accessToken;
    return accessToken;
  }

  async sign(message: string): Promise<{
    address: string;
    sig: string;
    message: string;
    ts: number;
  }> {
    if (!this.accessToken) throw new Error('No access token');

    const res = await fetch(`${this.baseUrl}/api/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.accessToken
      },
      body: JSON.stringify({ message })
    });
    return res.json();
  }

  async encrypt(message: string): Promise<string> {
    if (!this.accessToken) throw new Error('No access token');

    const res = await fetch(`${this.baseUrl}/api/encrypt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.accessToken
      },
      body: JSON.stringify({ message })
    });
    const { encrypted } = await res.json();
    return encrypted;
  }
}

// Usage
const client = new TokenPassClient();
await client.login('my-password');
await client.getToken('my-password', 'myapp.com', { scopes: 'sign,encrypt' });
const sig = await client.sign('Hello World');
console.log(sig);
```

---

## Sigma Auth Integration

### Better Auth Plugin Setup

```typescript
// lib/auth.ts
import { betterAuth } from 'better-auth';
import { sigmaAuthPlugin } from '@sigma-auth/better-auth-plugin';

export const auth = betterAuth({
  plugins: [
    sigmaAuthPlugin({
      tokenPassUrl: 'http://localhost:21000',
      // Optional: customize callback URL
      callbackUrl: '/api/auth/callback/sigma'
    })
  ]
});
```

### OAuth Callback Handler

```typescript
// app/api/auth/callback/sigma/route.ts
import { auth } from '@/lib/auth';

export async function GET(request: Request) {
  return auth.handler(request);
}

export async function POST(request: Request) {
  return auth.handler(request);
}
```

### Frontend Login Button

```tsx
// components/SigmaLoginButton.tsx
'use client';

import { authClient } from '@/lib/auth-client';

export function SigmaLoginButton() {
  const handleLogin = async () => {
    await authClient.signIn.sigma({
      callbackUrl: '/dashboard'
    });
  };

  return (
    <button onClick={handleLogin}>
      Sign in with Sigma
    </button>
  );
}
```

---

## Message Authentication

### Sign and Verify Flow

```typescript
// Server: Sign a challenge
const challenge = crypto.randomUUID();
const { sig, address } = await fetch('http://localhost:21000/api/sign', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': accessToken
  },
  body: JSON.stringify({ message: challenge })
}).then(r => r.json());

// Client: Send to your backend
const authPayload = { challenge, sig, address };

// Backend: Verify signature using @bsv/sdk
import { BSM } from '@bsv/sdk';

const isValid = BSM.verify(
  Buffer.from(challenge),
  BSM.fromCompact(sig, 'base64'),
  address
);
```

---

## React Hook Example

```typescript
// hooks/useTokenPass.ts
import { useState, useCallback } from 'react';

interface TokenPassState {
  isUnlocked: boolean;
  address?: string;
}

export function useTokenPass() {
  const [state, setState] = useState<TokenPassState>({ isUnlocked: false });
  const [loading, setLoading] = useState(false);

  const checkStatus = useCallback(async () => {
    const res = await fetch('http://localhost:21000/api/status');
    const { unlocked, keys } = await res.json();
    setState({
      isUnlocked: unlocked,
      address: keys?.[0]?.address
    });
  }, []);

  const login = useCallback(async (password: string) => {
    setLoading(true);
    try {
      await fetch('http://localhost:21000/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      await checkStatus();
    } finally {
      setLoading(false);
    }
  }, [checkStatus]);

  const sign = useCallback(async (
    password: string,
    host: string,
    message: string
  ) => {
    // Get token
    const authRes = await fetch('http://localhost:21000/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, host, expire: 'once' })
    });
    const { accessToken } = await authRes.json();

    // Sign message
    const signRes = await fetch('http://localhost:21000/api/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': accessToken
      },
      body: JSON.stringify({ message })
    });
    return signRes.json();
  }, []);

  return { ...state, loading, checkStatus, login, sign };
}
```

---

## cURL Examples

### Complete Flow

```bash
# 1. Register (first time only)
curl -X POST http://localhost:21000/api/register \
  -H "Content-Type: application/json" \
  -d '{"password":"secret123","displayName":"Alice"}'

# 2. Login
curl -X POST http://localhost:21000/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"secret123"}'

# 3. Check status
curl http://localhost:21000/api/status

# 4. Get token
TOKEN=$(curl -s -X POST http://localhost:21000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"secret123","host":"example.com","expire":"1h","scopes":"sign"}' \
  | jq -r '.accessToken')

# 5. Sign message
curl -X POST http://localhost:21000/api/sign \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{"message":"Hello World"}'

# 6. Get profile
curl http://localhost:21000/api/profile

# 7. Logout
curl -X POST http://localhost:21000/api/logout
```

---

## Error Handling

```typescript
async function safeTokenPassCall<T>(
  fn: () => Promise<T>
): Promise<{ data?: T; error?: string }> {
  try {
    const data = await fn();
    return { data };
  } catch (err) {
    if (err instanceof Response) {
      const body = await err.json();

      switch (body.code) {
        case 1:
          return { error: 'Wallet is locked. Please login first.' };
        case 2:
          return { error: 'Missing authorization token.' };
        case 3:
          return { error: 'Invalid access token.' };
        case 5:
          return { error: 'Access token expired. Please re-authenticate.' };
        default:
          return { error: body.error || 'Unknown error' };
      }
    }
    return { error: String(err) };
  }
}
```
