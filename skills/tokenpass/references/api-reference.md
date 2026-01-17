# TokenPass API Reference

Complete REST API documentation for TokenPass Server.

All endpoints are prefixed with `/api/` and accept/return JSON.

## Wallet Management

### POST /api/register

Create a new wallet with an encrypted master seed.

**Request:**
```json
{
  "password": "string (required)",
  "displayName": "string (optional)",
  "paymail": "string (optional)",
  "logo": "string (optional, URL or data URI)"
}
```

**Response (200):**
```json
{
  "success": true
}
```

**Errors:**
- `400` - Missing password
- `500` - Wallet already exists

**Notes:**
- Password encrypts master seed with AES-256-CBC
- Creates BAP identity automatically
- Seed stored in `~/.tokenpass/seed.db`

---

### POST /api/login

Unlock wallet by decrypting master seed.

**Request:**
```json
{
  "password": "string (required)"
}
```

**Response (200):**
```json
{
  "success": true
}
```

**Errors:**
- `400` - Missing password
- `401` - Invalid password

**Notes:**
- Required after server restart or logout
- Keeps decrypted seed in memory

---

### POST /api/logout

Lock wallet by clearing in-memory seed.

**Request:** Empty POST

**Response (200):**
```json
{
  "success": true
}
```

**Notes:**
- Does not delete encrypted database
- Access tokens remain but cannot be used

---

### GET /api/status

Check wallet status.

**Response (200):**
```json
{
  "seed": true,
  "unlocked": true,
  "keys": [...],
  "states": [...]
}
```

| Field | Description |
|-------|-------------|
| `seed` | `true` if wallet exists |
| `unlocked` | `true` if wallet is unlocked |
| `keys` | Derived keys (empty if locked) |
| `states` | Access token states |

---

### POST /api/export

Export master seed and mnemonic.

**Request:**
```json
{
  "password": "string (required)"
}
```

**Response (200):**
```json
{
  "seed": "hex-encoded-seed",
  "mnemonic": "twelve or twenty-four word phrase"
}
```

**Errors:**
- `400` - Missing password
- `401` - Invalid password

**Security:** Never share seed or mnemonic.

---

## Access Tokens

### POST /api/auth

Generate OAuth-style access token for a host.

**Request:**
```json
{
  "password": "string (required)",
  "host": "string (required)",
  "expire": "string (optional, default: 'once')",
  "scopes": "string (optional, comma-separated)",
  "icon": "string (optional)"
}
```

**Expire Options:**

| Value | Duration |
|-------|----------|
| `once` | 10 seconds (default) |
| `1h` | 1 hour |
| `1d` | 1 day |
| `1w` | 1 week |
| `1m` | 1 month |
| `forever` | No expiration |

**Scope Options:**

| Scope | Description |
|-------|-------------|
| `sign` | Sign messages |
| `encrypt` | Encrypt messages |
| `decrypt` | Decrypt messages |
| `read_profile` | Read BAP identity |
| `write_profile` | Modify BAP identity |
| `read_state` | Read per-host state |
| `write_state` | Write per-host state |
| `fund` | Request funding/payment |
| `transfer` | Transfer tokens/assets |

**Response (200):**
```json
{
  "success": true,
  "accessToken": "uuid-v4-token",
  "expireTime": 1234567890123,
  "host": "example.com"
}
```

**Errors:**
- `400` - Missing password or host
- `401` - Invalid password

**Notes:**
- Each host gets unique derived Bitcoin key
- Token is UUID v4
- Use in `Authorization` header (no "Bearer" prefix)

---

## Cryptographic Operations

### POST /api/sign

Sign message with host-derived Bitcoin key.

**Headers:**
```
Authorization: <accessToken>
Content-Type: application/json
```

**Request:**
```json
{
  "message": "string (required)",
  "encoding": "string (optional, default: 'utf8')"
}
```

**Encoding Options:** `utf8`, `hex`, `base64`

**Response (200):**
```json
{
  "address": "1BitcoinAddress...",
  "sig": "signature-string",
  "message": "original-message",
  "ts": 1234567890123
}
```

**Errors:**
- `401` (code 1) - Wallet locked
- `401` (code 2) - Missing authorization
- `401` (code 3) - Invalid token
- `401` (code 5) - Token expired
- `417` - No wallet exists

**Notes:**
- Uses Bitcoin Signed Message (BSM) format
- Each host has unique address
- Supports binary data with hex/base64 encoding

---

### POST /api/encrypt

Encrypt message using ECIES.

**Headers:**
```
Authorization: <accessToken>
Content-Type: application/json
```

**Request:**
```json
{
  "message": "string (required)"
}
```

**Response (200):**
```json
{
  "encrypted": "encrypted-message-data"
}
```

**Errors:** Same as `/api/sign`

**Notes:**
- Uses ECIES (Elliptic Curve Integrated Encryption)
- Each host uses different encryption key

---

## Identity Management

### GET /api/profile

Get global BAP identity profile.

**Response (200):**
```json
{
  "host": "global",
  "displayName": "Alice",
  "paymail": "alice@example.com",
  "logo": "https://...",
  "bapID": "identity-key-string"
}
```

**Notes:**
- Returns empty `{}` if no profile exists
- No authentication required

---

### POST /api/profile

Update global BAP identity profile.

**Request:**
```json
{
  "displayName": "string (optional)",
  "paymail": "string (optional)",
  "logo": "string (optional)",
  "customField": "any value"
}
```

**Response (200):**
```json
{
  "success": true
}
```

**Notes:**
- Merges with existing profile
- Any JSON-serializable data accepted

---

## Error Handling

All errors return:

```json
{
  "error": "Error message",
  "code": 1,
  "success": false
}
```

**Error Codes:**

| Code | Description |
|------|-------------|
| 1 | Wallet is locked |
| 2 | Missing authorization header |
| 3 | Invalid access token |
| 5 | Access token expired |

**HTTP Status Codes:**

| Status | Description |
|--------|-------------|
| 200 | Success |
| 400 | Bad Request - missing fields |
| 401 | Unauthorized - invalid auth |
| 417 | Expectation Failed - no wallet |
| 500 | Internal Server Error |
