# Identity Key Terminology Matrix

Three systems intersect in this stack: **Sigma Identity / BAP**, **BRC-31/42 auth**, and **BRC-100 wallets**.

## The Hierarchy

```text
Master Key (xprv or WIF)
│   Stored in master backup. Spans ALL accounts.
│   BIP32 (xprv) or Type42 (WIF) — used ONLY to derive member keys.
│   Multiple accounts = multiple independent member keys.
│   No on-chain relationship between accounts.
│
└── Member Key (WIF) — ONE per account, stable, never changes
    │   Derived from master via BIP32 path or Type42 invoice ("bap:N").
    │   rootAddress = memberKey.toPublicKey().toAddress()
    │   BAP ID = base58(ripemd160(sha256(rootAddress)))
    │   Used to sign: identity publication, key rotation transactions.
    │   Stored in member backup as WIF.
    │
    ├── Current Key = BRC-100 wallet root (Type42, rotates)
    │   │   memberKey.deriveChild(memberPub, "bap:{counter}")
    │   │   counter = 0 initially, increments on rotation.
    │   │
    │   └── Signing Key (Type42)
    │       currentKey.deriveChild(currentPub, "1-bapid-identity")
    │       signingAddress = signingKey.toPublicKey().toAddress()
    │       Used for BAP attestations from the active wallet.
    │
    └── Encryption Key (Type42)
        memberKey.deriveChild(memberPub, ENCRYPTION_PATH)
```

Key rules:

- **Master → Member**: BIP32 or Type42. Only place BIP32 may be used.
- **Member → everything below**: Type42 only. Member key is a WIF, not an HD key.
- **Member key never changes**. Defines BAP ID and root address permanently.
- **Rotation** increments a counter within the member. On-chain, a BAP ID transaction signed with the member key's root address announces the new signing address.
- **Multiple accounts** from one master are independent — no rotation or on-chain link between them. MasterID's "currentPath" just selects which account is active.

## Terminology Matrix

| Term | System | What it actually is | Format |
|------|--------|-------------------|--------|
| **Master Key** | Sigma/BAP | Top-level key (xprv or WIF) spanning all accounts | xprv string or WIF (base58check) |
| **BAP ID** | BAP | Stable identity hash derived from `rootAddress` | `base58(ripemd160(sha256(rootAddress)))` (~27 chars) |
| **`identityKey`** | BAP library code | Same as BAP ID (BAP's internal name) | Same as above |
| **`bapId`** | ClawNet/Convex | Same as BAP ID (ClawNet's field name) | Same as above |
| **`bap_id`** | Sigma Auth | Same as BAP ID (OAuth claim name) | Same as above |
| **`activeOrganizationId`** | Better Auth | Same as BAP ID (session field) | Same as above |
| **Member Key** | BAP | Stable key per account, derived from master | Private key (WIF) or compressed pubkey (hex) |
| **`rootAddress`** | BAP library | Bitcoin address of the member key | Bitcoin address (base58check) |
| **Current Key / Wallet Root** | BRC-100 | Active key derived from member via counter | Private key (WIF) or compressed pubkey (hex) |
| **Signing Key** | BAP | Derived from current key for attestations | Private key (derived with `"1-bapid-identity"`) |
| **Identity Key** | BRC-31/42 | Compressed secp256k1 public key for auth | `02`/`03` + 64 hex chars (66 chars total) |
| **`identityKey`** | BRC-31 headers | Usually the current key's public key | Same as above |

## Critical Distinctions

### "Identity Key" means two different things

- **In BAP code**: `getIdentityKey()` returns the BAP ID hash. This is a **derived identifier**, not a key.
- **In BRC-31/42 specs**: "identity key" means a **compressed public key** used for authentication.

These are completely different formats and cannot be interchanged.

### Member key vs current key

The member key is stable. The current key rotates with a counter:

- **Member key** — defines BAP ID, signs identity publication and rotation transactions
- **Current key** — `memberKey.deriveChild(pub, "bap:{counter}")` — BRC-100 wallet root, changes on rotation
- **Signing key** — derived from current key — signing address for attestations
- **BAP ID** stays fixed because it comes from the member key's `rootAddress`

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

This is **only valid** when the pubkey is the **stable member key**. It works because `memberKey.toPublicKey().toAddress() === rootAddress`.

It does **NOT** work with:
- A current key pubkey (after rotation)
- A signing key's pubkey
- An arbitrary pubkey unrelated to the BAP identity

## BAP Library Helper (bsv-bap)

```typescript
import { PublicKey, Hash, Utils } from "@bsv/sdk";
const { toHex, toBase58 } = Utils;

// Only valid when pubkey is the stable member key
function bapIdFromMemberPubkey(pubkeyHex: string): string {
  const address = PublicKey.fromString(pubkeyHex).toAddress();
  return toBase58(Hash.ripemd160(toHex(Hash.sha256(address, "utf8")), "hex"));
}
```
