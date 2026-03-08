# Identity Key Terminology Matrix

Three systems intersect in this stack: **Sigma Identity / BAP**, **BRC-31/42 auth**, and **BRC-100 wallets**. The important correction is that the stable BAP member key and the active wallet root are related, but not always the same key.

## The Hierarchy

```text
Sigma Master Key (WIF)
│   Top-level secret passed to new BAP({ rootPk: wif }).
│
└── Member Key at rootPath (for example "bap:0")
    │   Created by: masterKey.deriveChild(masterPub, "bap:N")
    │   rootAddress = memberKey.toPublicKey().toAddress()
    │   BAP ID = base58(ripemd160(sha256(rootAddress)))
    │   This is the stable identity root.
    │
    ├── Wallet Root at currentPath
    │   Initial currentPath = rootPath, so the first wallet root matches the member key.
    │   After rotation:
    │   - bap:0   -> bap:0:1
    │   - bap:0:1 -> bap:0:2
    │   This is the active BRC-100 / auth root.
    │
    └── Signing Key
        Created by: walletRoot.deriveChild(walletRootPub, "1-bap-identity")
        signingAddress = signingKey.toPublicKey().toAddress()
        Used for BAP attestations from the active wallet root.
```

Key rule:

- `rootPath` stays fixed and defines the BAP ID
- `currentPath` rotates and defines the active wallet/auth root

## Terminology Matrix

| Term | System | What it actually is | Format |
|------|--------|-------------------|--------|
| **Master Key** | Sigma/BAP | Top-level private key (WIF) | WIF string (base58check) |
| **BAP ID** | BAP | Stable identity hash derived from `rootAddress` | `base58(ripemd160(sha256(rootAddress)))` (~27 chars) |
| **`identityKey`** | BAP library code | Same as BAP ID (BAP's internal name) | Same as above |
| **`bapId`** | ClawNet/Convex | Same as BAP ID (ClawNet's field name) | Same as above |
| **`bap_id`** | Sigma Auth | Same as BAP ID (OAuth claim name) | Same as above |
| **`activeOrganizationId`** | Better Auth | Same as BAP ID (session field) | Same as above |
| **Member Key** | BAP | Stable key derived from `rootPath` | Private key (WIF) or compressed pubkey (hex) |
| **`rootAddress`** | BAP library | Bitcoin address of the stable member key | Bitcoin address (base58check) |
| **Wallet Root** | BRC-100 | Active key derived from `currentPath` | Private key (WIF) or compressed pubkey (hex) |
| **Signing Key** | BAP | Derived from the wallet root for attestations | Private key (derived with `"1-bap-identity"`) |
| **Identity Key** | BRC-31/42 | Compressed secp256k1 public key used for auth | `02`/`03` + 64 hex chars (66 chars total) |
| **`identityKey`** | BRC-31 headers | Usually the active wallet root public key | Same as above |

## Critical Distinctions

### "Identity Key" means two different things

- **In BAP code**: `getIdentityKey()` returns the BAP ID hash. This is a **derived identifier**, not a key.
- **In BRC-31/42 specs**: "identity key" means a **compressed public key** used for authentication.

These are completely different formats and cannot be interchanged.

### Stable member key vs active wallet key

At creation time, `currentPath === rootPath`, so the member key and wallet root are equal.

After rotation:

- the **member key** at `rootPath` stays fixed
- the **wallet root** at `currentPath` changes
- the **BRC-31 identity key** changes with the wallet root
- the **BAP ID** stays fixed because it comes from the member key's `rootAddress`

Systems should store these separately when both concepts matter:

- `member_pubkey`: stable identity linkage
- `wallet_pubkey`: active wallet/auth linkage

### BAP ID vs Bitcoin Address vs Public Key

| | BAP ID | Bitcoin Address | Compressed Pubkey |
|---|---|---|---|
| **Length** | ~27 chars (base58) | ~34 chars (base58check) | 66 hex chars |
| **Prefix** | varies | `1` (mainnet) | `02` or `03` |
| **Derived from** | sha256 + ripemd160 of rootAddress | ripemd160 of sha256 of pubkey | Direct from private key |
| **Reversible?** | No (hash) | No (hash) | Yes (from private key) |

### pubkeyToBapId — When it works

`pubkeyToBapId(pubkeyHex)` converts a public key to a BAP ID by:
1. `pubkey.toAddress()` = Bitcoin address
2. `base58(ripemd160(sha256(address)))` = BAP ID

This is **only valid** when the pubkey is the **stable member key** at `rootPath`. It works because `memberKey(rootPath).toPublicKey().toAddress() === rootAddress`.

It does **NOT** work with:
- A wallet root pubkey from a rotated `currentPath`
- A BAP signing key's pubkey
- An arbitrary pubkey unrelated to the BAP identity

## Recommended Library Semantics

For `bsv-bap`:

- `getMemberKey()` -> stable member key at `rootPath`
- `getWalletRoot()` / `getWalletPubkey()` -> active wallet root at `currentPath`
- `incrementPath()` -> wallet rotation, not identity rotation

## BAP Library Helper (bsv-bap)

The BAP library provides the derivation as `deriveIdentityKey(address)` on MasterID instances. For cross-system use (e.g., BRC-31 auth → BAP ID lookup), use:

```typescript
import { PublicKey, Hash, Utils } from "@bsv/sdk";
const { toHex, toBase58 } = Utils;

// Only valid when pubkey is the stable member key at rootPath
function bapIdFromMemberPubkey(pubkeyHex: string): string {
  const address = PublicKey.fromString(pubkeyHex).toAddress();
  return toBase58(Hash.ripemd160(toHex(Hash.sha256(address, "utf8")), "hex"));
}
```
