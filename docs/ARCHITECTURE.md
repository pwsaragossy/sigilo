# Architecture

## The problem

On a public ledger, every coupon payment an issuer makes is a published treasury statement. Anyone with an explorer reads the issuer's payment flow: who was paid, when, and how much per transaction. This is the objection institutions raise first when evaluating tokenized private credit, and today the choice is binary — full transparency, or leave the public chain.

## What Sigilo does

One identity policy governs two enforcement points:

```
                    ┌──────────────────────────┐
                    │   Identity Registry      │
                    │   (ERC-3643 / T-REX)     │
                    │   KYC claims per holder  │
                    └───────────┬──────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              │                                    │
    ┌─────────▼──────────┐            ┌────────────▼─────────────┐
    │  Permissioned      │            │  Policy Bridge           │
    │  token (RWA)       │            │  (this project)          │
    │                    │            │                          │
    │  can_transfer()    │            │  grant  → allowlist ins. │
    │  rejects           │            │  revoke → blocklist ins. │
    │  uncredentialed    │            └────────────┬─────────────┘
    └────────────────────┘                         │
                                       ┌───────────▼──────────────┐
                                       │  Confidential rail       │
                                       │  (privacy pool + ASP)    │
                                       │                          │
                                       │  proofs bind spender to  │
                                       │  the association sets    │
                                       └──────────────────────────┘
```

The permissioned token enforces **who may hold**. The confidential rail enforces **who may spend**. The bridge keeps both governed by the same KYC source.

## Enforcement semantics (verified against the pool implementation)

These are the properties the rail actually provides — not the ones a privacy pool is often assumed to provide. Getting this wrong would mean demoing something the system does not do.

| Property | Reality |
|---|---|
| Who is checked by the policy circuits | **The spender only.** Membership and non-membership proofs bind the *input* notes' keys. The recipient of a transfer is never checked against an association set. |
| Paying a revoked address | **Succeeds on-chain.** Excluding a revoked investor from a payment batch is the issuer service's policy decision, made off-chain — labelled as such throughout. |
| Revoking | **Insert into the blocklist** (sparse Merkle tree of non-membership). The allowlist tree is append-only — it has an insert, not a remove. |
| Effect of revocation | **Retroactive freeze.** The pool requires the proof's association-set roots to equal the *current* roots, so a revoked holder can no longer spend or withdraw *anything* in the pool — including coupons received before the revocation. |
| Undoing it | Re-credentialing restores spending. The demonstrable cycle is `grant → pay → revoke → frozen → re-grant → spendable`. |

The retroactive freeze is the interesting property for an institutional reader: revocation is not advisory, and it is not partial.

## Trust boundary

The bridge runs as an issuer-side service today: it reads the identity registry and calls `insert_leaf` on the association-set contracts, of which it is admin. **Nothing on-chain forces the bridge to mirror the registry faithfully** — an operator could insert a key that holds no KYC claim. This is stated plainly rather than glossed over.

The upgrade that removes the trust: a `PolicyBridge` contract holding admin over the association sets, whose insertion entrypoint performs a cross-contract `identity_registry.is_verified(address)` check before updating a tree. Then the association set is a *provable* projection of the identity registry, and the operator has no discretion.

```rust
// Target interface — specified, not yet implemented.
pub trait PolicyBridge {
    /// Insert into the allowlist only if the identity registry
    /// verifies the address. Reverts otherwise.
    fn grant(e: &Env, holder: Address, asp_leaf: U256) -> Result<(), Error>;

    /// Insert into the blocklist. Callable when the registry no
    /// longer verifies the holder.
    fn revoke(e: &Env, holder: Address, asp_leaf: U256) -> Result<(), Error>;
}
```

## What is confidential, and what is not

| Data | Visibility |
|---|---|
| Coupon payment amounts (transfers inside the pool) | **Hidden** |
| Who received a given payment | **Hidden** on-chain |
| Token positions (holder balances) | **Public** — a securities register should be transparent to the regulator |
| Aggregate amount the treasury funded into the pool | **Public** — mitigated by funding ahead of, and decoupled from, payment cycles |
| Demo values specifically | **Recomputable** from this repository's seed. In a real deployment the coupon rate is the issuer's private data — that is what the rail protects |

Confidentiality, not anonymity: addresses transacting with the pool remain visible; amounts do not.

## Selective disclosure

Two paths to an auditor, with different guarantees:

1. **Holder-generated proof.** The recipient proves a specific payment: amount, existence in the pool, and possession — cryptographically verified. The circuit requires the note's private key, so only the holder can produce this.
2. **Issuer opening-reveal.** The issuer, as creator of the note, hands the auditor its opening (amount, recipient key, blinding); the auditor recomputes the commitment and checks it against the pool. No ZK involved, and it does not depend on the holder cooperating.

The auditor interface labels each field **proven** or **attested**. Coupon references travel in a tamper-evident context field whose *contents* are asserted by the prover — that distinction is surfaced, not hidden.

## Deployment (Stellar testnet)

Own instance — the reference deployment's association sets are admin-gated by their deployer and cannot be operated by third parties.

| Contract | Address |
|---|---|
| Pool (allowlist + blocklist) | `CCOCML4RJ7GO4MZS4OMD63W3HRJFXEIJBWRQGQTMOB35PDUBMLREN7WH` |
| ASP membership (allowlist) | `CBWRBDQOXMIOR3MJCHIZHIQPKRCRFPQOACM6COHLXKMLRR3LYJQIGKAO` |
| ASP non-membership (blocklist) | `CB4AQSEAICIMFQEJCPWOJNCMEJ57SQYXFTBMS42Y2LDZA6LLPPHMFBRL` |
| Groth16 verifier (AB policy) | `CCKYMOHY4GDQMVKZFATOIOAJ6HCXAUXKBWQC3L5ZQYJNAIJ7DMIONADZ` |
| Public key registry | `CBJKSJGUAN7SAJ5ZBAL6K3VWHV7YD6PYTWSOEG2G43ZPMVEK4GV23ELJ` |

Deployed at ledger 3958947. Trees: 10 levels. Proofs: Groth16 over BN254, verified on-chain through native host functions (CAP-0074, CAP-0080).
