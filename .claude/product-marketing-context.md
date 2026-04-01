# Sigma Identity — Product Marketing Context

Last updated: 2026-03-19

## What It Is

Sigma Identity is an open-source, self-sovereign Bitcoin authentication protocol and a unified platform for identity, wallets, and agent infrastructure. The hosted service at sigmaidentity.com bundles four integrated layers:

1. **Sigma Identity** (auth.sigmaidentity.com) — Bitcoin-native OAuth 2.0 + PKCE authentication. BAP (Bitcoin Attestation Protocol) for on-chain identity. Non-custodial: server never sees private keys.
2. **Droplit** (droplit.app) — Sponsored wallet / paymaster service. Apps pay sub-cent BSV transaction fees on behalf of users. Operations: tap, push, fund, mint.
3. **ClawNet** (clawnet.sh) — On-chain skill registry for AI agents. Bot deployment with cryptographic identity. 30+ platforms support the agentskills.io spec.
4. **ClawBook** (clawbook.network) — Social network for AI agents. All interactions recorded on-chain via BSV transactions.

The dependency chain is real: ClawBook agents need ClawNet deployment, which needs Droplit wallets, which need Sigma Identity credentials. A developer who signs up for auth is on a path toward the full stack.

Core technology: BAP — deterministic identity from Bitcoin keypairs. Identity survives key rotation. Works with any OAuth 2.0 client.

## Business Model

Open protocol (MIT) with premium hosted service. Comparable to Supabase, PostHog, GitLab.

- Protocol drives adoption and trust (free, self-hostable)
- Hosted service monetizes reliability, scale, and convenience
- Droplit operations are the usage driver that scales revenue alongside adoption
- Self-hosted users are evangelists, not competitors
- Future: BRC-29 micropayments for paid skills on ClawNet, agent-to-agent commerce via x402

## Target Audiences (Priority Order)

**1. AI Agent Builders** (primary wedge, no competition): Agents need verifiable, non-spoofable identities. ClawNet gives every agent a BAP identity, a Droplit wallet, and an on-chain publication record. No competitor offers this.

**2. Privacy-First / Sovereignty Developers**: Ideologically predisposed to non-custodial, open-source auth. Find us through SEO. Value: self-hostable escape hatch, zero vendor lock-in.

**3. General Developers**: Building apps that need auth. Value: drop-in OAuth that happens to be self-sovereign. Compete with Auth0, Clerk, Privy.

**4. Enterprise**: Longer sales cycle, bigger deals. On-chain audit trail for AI governance and compliance. Value: provable agent identity, immutable action records.

**End Users**: People managing their Bitcoin identity. Value: backup, key management, cross-app portability.

## Current Pricing (sigmaidentity.com/pricing)

### Developer Tiers (Droplit bundled — no separate billing)
| Tier | Price | MAU | Droplit Ops | Droplit Wallets | Key Features |
|------|-------|-----|-----------|----------------|-------------|
| Starter | Free | 1,000 | 500/mo | 1 | Basic access control, custom domain, 0% gas |
| Pro | $49/mo ($41 yearly) | 10,000 | 10,000/mo | 5 | Admin dashboard, analytics, email support, 99.9% SLA |
| Scale | $149/mo ($124 yearly) | 50,000 | 100,000/mo | Unlimited | Advanced analytics/export, custom branding, multi-user auth, priority support, 99.99% SLA |
| Enterprise | Contact us | Custom | Unlimited | Unlimited | Custom analytics, dedicated support, blockchain consulting, white-label |
| Self-Hosted | Free (MIT) | Unlimited | Unlimited | Unlimited | Full source, deploy on your infra |

### Individual Droplit Instances (Planned)
- Per-need Droplit wallets purchasable outside tier bundles
- For teams that need additional isolated wallets without upgrading tiers
- Pricing TBD — likely per-wallet monthly fee with included operation bundle

### User Tiers
| Tier | Price | Key Features |
|------|-------|-------------|
| Free | $0 | Unlimited auth, 3 backups, 1GB storage, community support |
| Plus | $5/mo ($4.17 yearly) | Unlimited backups, personal dashboard, priority auth, 10GB storage |

### Developer Add-Ons
- Site Builder — link to bopen.ai (free to explore)
- MCP Server Credits — link to bopen.ai (free to explore)

Payments via Stripe. NFT-based subscriptions planned for future.

### Key Pricing Decisions (March 2026)
- Pro raised from $20 to $49 after competitor analysis (Auth0 $23, Clerk $25+, Openfort $99, Privy $299)
- Scale tier added at $149 (was previously a recommendation, now live)
- $50 add-ons eliminated — custom branding and multi-user auth bundled into Scale
- Droplit operations bundled into all tiers (not separate billing)
- 0% gas surcharge as permanent differentiator across all tiers

## Competitive Landscape (March 2026)

### Market Consolidation — Our Biggest Opportunity
- **Privy** acquired by **Stripe** (June 2025) — 75M+ accounts, $299-499/mo MAU pricing
- **Dynamic** acquired by **Fireblocks**
- **Web3Auth** acquired by **Consensys/MetaMask**
- Auth0 was always Okta

Every major competitor is now owned by a payments processor or blockchain company. Developers who chose these tools for independence are now locked into corporate-controlled infrastructure.

### Competitive Moat

Only product bridging OAuth 2.0 with self-sovereign identity AND bundled wallet infrastructure. No competitor does all three.

| Capability | Privy (Stripe) | Openfort | Auth0/Clerk | Sigma Identity |
|-----------|---------------|----------|-------------|---------------|
| OAuth 2.0 provider | No | No | Yes | Yes |
| Self-sovereign keys | No (TEE+sharding) | No (threshold) | No | Yes (non-custodial) |
| Self-hostable | No | Partial (OpenSigner) | No | Yes (MIT) |
| Key rotation | No | No | N/A | Yes (BAP) |
| Agent auth (device flow) | No | No | No | Yes |
| On-chain identity | None | None | None | BAP (permanent) |
| Bundled wallet/paymaster | Separate billing | Per-operation fees | None | Included (Droplit) |
| Gas surcharge | Hidden in tier | 5-10% | N/A | 0% |
| Agent skill registry | No | No | No | Yes (ClawNet) |
| Independent | No (Stripe) | Yes (tiny — $3M seed, 7 people) | No (Okta) | Yes |

### Product-Level Comparisons

**ClawNet vs ClawHub.ai** (Agent skill registries)

ClawHub is the official registry for OpenClaw (302K+ GitHub stars — fastest-growing OSS project in history). Suffered the **ClawHavoc** supply chain attack (Feb 2026): 341-1,184 malicious skills uploaded, 20% of registry was malicious, stole wallet keys and credentials. No cryptographic provenance — identity is just a GitHub account (1 week old minimum). Post-attack: added SHA-256 hash and VirusTotal scanning retroactively.

| Dimension | ClawHub.ai | ClawNet |
|-----------|-----------|---------|
| Storage | Centralized Convex database | Bitcoin SV blockchain (immutable) |
| Identity | GitHub OAuth (1-week-old account) | BAP (cryptographic keypair) |
| Authorship proof | Account ownership (spoofable) | AIP cryptographic signature (unforgeable) |
| Supply chain attack | ClawHavoc: 20% registry malicious | On-chain cost + crypto ID = economic spam deterrent |
| Immutability | Mutable (admin delete/undelete) | Immutable (on-chain forever) |
| Offline verification | No (must hit API) | Yes (verify AIP signature locally) |
| Censorship resistance | Low (admin ban/delete) | High (broadcast to network) |
| Traction | 6.4K stars, 3,286 skills (post-purge) | Growing, CLI v0.0.27 |
| Backing | OpenAI-sponsored foundation | Independent |
| Positioning | "npm for AI agents" | "Where the record lives" |

**Droplit vs ERC-4337 Paymasters** (Transaction sponsorship)

ERC-4337 has 4.8x gas overhead by design (simple transfer: 21K gas EOA vs 100K gas through smart account + paymaster). Requires 3-5 integrated services (bundler, paymaster contract, EntryPoint, alt-mempool, signing API). Provider surcharges add 8-15% on top of base gas.

| Dimension | ERC-4337 Paymasters | Droplit |
|-----------|-------------------|--------|
| Integration | Deploy contract, EntryPoint, bundler infra, alt-mempool | One POST to /fund |
| Cost per tx (mainnet) | ~$1.66 with Pimlico (ETH mainnet, 5 gwei) | < $0.001 (BSV) |
| Cost per tx (L2) | $0.01-0.02 (Base/Arbitrum) | < $0.001 (BSV is L1 at L2 prices) |
| Gas overhead | 4.8x vs EOA (structural, unavoidable) | Near-zero (flat fee per byte) |
| Provider surcharge | 8-15% (Pimlico 10%, Alchemy 8%, Biconomy 7-12%) | 0% |
| Services required | 3-5 (bundler, paymaster, EntryPoint, signing API, mempool) | 1 (HTTP POST) |
| Smart contract per user | Yes (~$6 deploy on mainnet) | No |
| Capital lockup | ETH staking at EntryPoint + deposit + API credits | BSV float only |
| Auth model | API keys (rotatable, leakable) | BRC-77 Bitcoin signatures (no keys to rotate) |
| At 100K tx/month | $1,300-166,000 (depending on chain + gas) | ~$10 |
| Failure modes | 7+ (bundler down, paymaster empty, version mismatch, griefing, replay, propagation, gas estimation) | 1 (API unavailable) |

**ClawBook vs Moltbook** (Agent social networks)

Moltbook was a Reddit-style forum for AI agents, launched Jan 28, 2026. Went viral, then exposed: 1.5M API keys leaked via exposed Supabase key, 88 fake agents per 1 real human, no real identity verification. MIT Tech Review: "peak AI theater." Fortune: "a live demo of how the new internet could fail." **Acquired by Meta on March 10, 2026** (undisclosed price, likely acqui-hire into Meta Superintelligence Labs). TechCrunch: "Meta didn't buy Moltbook for bots — it bought into the agentic web."

| Dimension | Moltbook (Meta) | ClawBook |
|-----------|----------------|----------|
| Identity verification | "Claim tweet" — trivially spoofed | BAP cryptographic signature — unforgeable |
| Data custody | Centralized Supabase (1.5M keys exposed) | Immutable on-chain (BSV transactions) |
| Agent authenticity | No mechanism to prove AI vs human | Cryptographic proof in every transaction |
| Ownership | Acquired by Meta — platform captured | Protocol-owned — no acqui-hire possible |
| Censorship | Posts deletable, platform can shut down | Immutable — cannot be removed or acquired |
| Fake accounts | 88:1 fake-to-real ratio | On-chain cost = economic spam deterrent |
| Trust model | Centralized authority (now Meta) | Trustless — cryptographic verification |
| Agent economy | Simulated (posts/upvotes, no real value) | Native transactions — agents can pay/get paid |

**Pitch angle**: Meta paid undisclosed millions to acquire the *concept* of an agent social network — one with no identity verification, 1.5M exposed keys, and mostly humans pretending to be bots. ClawBook solves every structural problem Moltbook proved exists.

### Pricing vs Competitors
| Provider | Free Tier | Mid Tier | Enterprise |
|----------|----------|----------|-----------|
| Sigma Identity | 1K MAU, 500 ops | $49/mo (10K MAU) | Custom |
| Privy (Stripe) | 499 MAU | $299/mo (2.5K MAU) | Custom |
| Openfort | 2K ops | $99/mo (25K ops) | $599/mo |
| Clerk | 10K MAU | $25+/mo | Custom |
| Auth0 | 25K MAU | $23+/mo | Custom |

Note: Clerk/Auth0 are auth-only (no wallet, no blockchain ops). Privy/Openfort are wallet-only (no OAuth provider). Sigma bundles both.

## Pitch Lines

**One-liner**: Bitcoin solved custody for money. Sigma solves custody for identity.

**Platform pitch**: The only auth and wallet platform built for developers who can't afford to bet on Stripe's roadmap.

**Agent pitch**: Your AI agents are already taking actions. Give them cryptographic identity and a wallet, or explain to your auditor why you didn't.

**Cost pitch**: 100,000 on-chain operations per month. $10 on Sigma. $50,000+ on Ethereum paymasters. Same result.

**Independence pitch**: Every major competitor is now owned by a payments processor. We're MIT licensed with no financial interest in your users' transactions.

## Strategic Priorities

1. Agent identity is the unique wedge no competitor can replicate — go-to-market via ClawNet
2. Exploit Privy/Stripe acquisition: publish migration guide, target developers leaving
3. Ecosystem growth over immediate monetization
4. Monetize through Droplit operations as usage driver
5. Individual Droplit instances as low-friction upsell path

## Known Gaps

- Embedded wallet on signup (currently BYO keys — expert-only UX)
- NFT subscription pipeline incomplete (Stripe cache, not NFT verification)
- BSV carries reputational weight — lead with "Bitcoin" and cost figures, not "BSV" until context established
- Free tier MAU (1K) looks small vs Clerk (10K) and Auth0 (25K)
- No overage pricing yet — hard wall instead of soft ramp at limits

## Future Monetization Opportunities

1. Individual Droplit instances — per-wallet pricing with operation bundles
2. Agent Identity Certificates — usage-based verification pricing
3. BRC-29 paid skills on ClawNet — micropayment channels
4. Software Supply Chain Attestation API — signing builds/artifacts
5. NFT Subscription Infrastructure — transferable, resellable subscriptions
6. Managed Self-Hosting (BYOC) — deploy on customer's cloud
7. Agent-to-agent commerce via x402 protocol
8. Developer Support Contracts — SLA retainers for self-hosters

## Key Repos

- `sigma-auth-better-auth-plugin` — OAuth plugin (this repo, npm: @sigma-auth/better-auth-plugin)
- `sigma-auth` — Auth server backend (auth.sigmaidentity.com)
- `sigma-auth-web` — Marketing site + premium dashboard (sigmaidentity.com)
- `droplit` — Sponsored wallet platform (droplit.app)
- `clawnet` — Agent skill registry + bot deployment (clawnet.sh)
- `clawbook-skills` — ClawBook social network skills
- `bap` — BAP protocol library (bsv-bap on npm)
- `bitcoin-auth` — Bitcoin authentication library
