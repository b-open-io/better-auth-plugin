# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Better Auth plugins for Sigma Identity - Bitcoin-native authentication with BAP (Bitcoin Attestation Protocol) identity support. This package provides OAuth/OIDC integration for apps authenticating with Sigma Identity.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build with TypeScript (tsc)
bun run dev          # Watch mode for development
bun run lint         # Biome check
bun run lint:fix     # Auto-fix with Biome
bun run lint:unsafe  # Auto-fix with unsafe transforms
```

Publishing: `bun run prepublishOnly` runs lint, clean, and build before npm publish.

## Testing

**DO NOT use `bun link` to test this plugin locally in other projects.** It causes dependency resolution problems and doesn't help anyway - you can't test local changes on production deployments. The only way to test changes is to publish and update the consuming project.

## Architecture

### Entry Points

The package exposes four entry points via package.json exports:

- **`/client`** (`src/client/index.ts`) - Browser OAuth client with PKCE, iframe-based signing
- **`/server`** (`src/server/index.ts`) - Server-side token exchange with bitcoin-auth signatures
- **`/next`** (`src/next/index.ts`) - Next.js App Router handlers for OAuth callback
- **`/provider`** (`src/provider/index.ts`) - Better Auth server plugin for running your own OIDC provider

### Client Plugin Flow

The `sigmaClient()` plugin fronts Better Auth's OIDC authorize endpoint:

1. Client calls `/oauth2/authorize` (custom gate, not `/api/auth/oauth2/authorize`)
2. Gate checks wallet status before forwarding to Better Auth
3. PKCE parameters stored in sessionStorage
4. After redirect, `handleCallback()` exchanges code via server endpoint
5. `SigmaIframeSigner` provides signing without exposing keys (iframe at `/signer`)

### Provider Plugin Flow

The `sigmaProvider()` plugin validates OAuth token exchange:

1. Before `/oauth2/token` hook validates bitcoin-auth signature on X-Auth-Token header
2. Verifies pubkey matches client's registered memberPubkey in metadata
3. After hooks store selectedBapId in consent and access token records
4. Supports BAP ID resolution via optional `resolveBAPId` callback

### Admin Plugin

The `sigmaAdminPlugin()` provides Bitcoin-native role resolution:

- NFT collection ownership → roles
- Token balance thresholds → roles
- BAP ID whitelist for admin
- Custom `extendRoles` callback

### Iframe Signer Protocol

`SigmaIframeSigner` communicates with Sigma's `/signer` page via postMessage:
- `SET_IDENTITY` - Set BAP ID for signing
- `SIGN_REQUEST` / `SIGN_RESPONSE` - BSM or BRC-77 signatures
- `SIGN_AIP_REQUEST` / `SIGN_AIP_RESPONSE` - AIP signatures for OP_RETURN
- `ENCRYPT_REQUEST` / `DECRYPT_REQUEST` - Type42 key derivation encryption
- `GET_FRIEND_PUBKEY_REQUEST` - Derived public key for friend

## Key Dependencies

- `better-auth` - Core auth framework (peer dependency)
- `bitcoin-auth` - Token generation/verification for signed requests
- `@bsv/sdk` - Bitcoin SV SDK (optional peer dependency for PublicKey)
- `@neondatabase/serverless` - Postgres pool type (optional)
- `zod` - Schema validation (optional)

## Environment Variables

Client apps need:
- `NEXT_PUBLIC_SIGMA_AUTH_URL` - Auth server URL (default: https://auth.sigmaidentity.com)
- `NEXT_PUBLIC_SIGMA_CLIENT_ID` - OAuth client ID
- `SIGMA_MEMBER_PRIVATE_KEY` - WIF for signing token exchange (server-side)

## Type System

Types in `src/types/index.ts`:
- `SigmaUserInfo` - OIDC userinfo with BAP extensions
- `BAPProfile` - Bitcoin Attestation Protocol identity structure
- `OAuthCallbackResult` / `OAuthCallbackError` - Callback handling types
- Subscription, wallet, and NFT types for connected wallet features
