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
2. **Issuer opening-reveal** — *specified, not implemented.* The issuer creates the note and therefore knows its opening (amount, recipient key, blinding). Handing that to an auditor would let them recompute the commitment and find it in the pool, with no ZK and no dependence on the holder cooperating — which matters, because an audit trail that only works with the auditee's goodwill is not an audit trail.

   What stops it here is narrow: a note commitment is `poseidon2(amount, recipient_key, blinding)`, and the vendored web SDK does not export Poseidon2 to JavaScript. An auditor could only verify by trusting someone else's recomputation, which defeats the purpose. Closing this means exporting the hash from the SDK and rebuilding it — mechanical, but not free.

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

## Permissioned token (Stellar testnet)

Seven-contract ERC-3643 stack, deployed by [`scripts/deploy-rwa.sh`](../scripts/deploy-rwa.sh).

| Contract | Address |
|---|---|
| RWA token — `RDXN` | `CCQW3X2XIYOVAEBRYVC25CRBY6NVGTW4K42HYU6Y34KHOMKL2H4LJZ2V` |
| Identity registry | `CCO2EI7P325L2OAR4NQHPUO25AXYBTMPC7DI6JSW5BTPGPCKA27J33SK` |
| Identity verifier | `CARCZ47PIRP2JCN3VEJ42UIWTWZ7SGKM764ZH554P3O2ODXI7P4VMKT6` |
| Compliance | `CA4EI7P5TO4Y2FAGX3QT7WB3OQL2VP3BQ7CQUUZRQZRN5GCW76LH2M7N` |
| Claim topics & issuers | `CDOW2IOHRHGNHASQDKPO3VJJAIPDTZOUCGWCM4EFVNOWSWS7YN5VWS2X` |
| Claim issuer | `CA7N55KMS4Y3MPUATH5ECWVUTRD3V3CQNM2B5RP7XDRUAFL5T6FNAIGG` |

Five holders, each with a per-investor identity contract carrying Ed25519-signed KYC and
AML claims. Positions are uneven and entry dates differ — coupons accrue per day from the
entry date, so a coupon is not a fixed fraction of a (publicly readable) balance.

**Policy enforcement, demonstrated:**

| Attempt | Result |
|---|---|
| `transfer` between two credentialed holders | [confirmed](https://stellar.expert/explorer/testnet/tx/1a0023ce550b28b267f5f0ee9ab7e92a16f4b50bdfc5db0f55075da7c8002308) |
| Issuing to an address the registry has never seen | **rejected** — `Error(Contract, #321)` `IdentityNotFound` |
| Issuing to a holder whose credential was revoked | **rejected** — `Error(Contract, #304)` `IdentityVerificationFailed` |

The rejection surfaces during **simulation**: standard tooling never submits the
transaction, so the failure is visible in the wallet and the RPC response rather than as a
failed transaction on the explorer.

## The bridge, demonstrated

[`scripts/policy-bridge.sh`](../scripts/policy-bridge.sh) reads the registry and moves the
association sets to match it. Nobody types a key: `verify_identity(holder)` is the question,
and an allowlist or blocklist insertion is the answer.

The run below is the whole argument, and step 2 is the part that matters.

| Step | Result |
|---|---|
| 1. Issuer revokes a holder's KYC claim — **in the identity registry only** | `ClaimRemoved` |
| 2. **Before syncing**, that holder withdraws from the pool | [succeeds](https://stellar.expert/explorer/testnet/tx/fc26065850fecbd250233b11d6338e73813c5da8802fe5fc8f5ad6956f80d40b) |
| 3. `policy-bridge.sh sync` | `credential absent → blocklisted (pool balance frozen)` |
| 4. The same holder tries again | **refused** — *"user note key exists in non-membership tree"* |

Step 2 is why the bridge exists. A permissioned token and a confidential rail each enforce
their own policy perfectly well, and still disagree: revoking a credential does nothing to
funds already inside the rail. Without something joining them, an issuer who revokes a
holder has revoked nothing where the money is.

With the bridge, one credential governs both — and because the pool validates proofs against
the *current* association roots, the freeze reaches backwards over balances the holder
already held.

### Enrolment and its trust boundary

An allowlist leaf is `poseidon2(note_public_key, asp_secret)`, and the ASP secret belongs to
the holder, not the issuer. Enrolment is therefore something a holder *consents to*: handing
that secret over is what makes them identifiable to the policy operator. In this demo the
bridge reads it from the rail CLI's local state; a real deployment would collect it during
onboarding, and the holder would know it had.

The operator remains trusted to mirror the registry faithfully — see the `PolicyBridge`
contract sketched above, which removes that discretion by making the check happen on-chain.

## Reference run

The full cycle, executed against the deployment above. Every hash is public.

| Step | Result | Transaction |
|---|---|---|
| Bridge — grant (allowlist insert ×2) | `LeafAdded` idx 0, 1 | [`03f0676…`](https://stellar.expert/explorer/testnet/tx/03f067603a497e4ad5b5fba17c96610fed716ea95526e0aab530e4b839d23b4b) · [`80049d1…`](https://stellar.expert/explorer/testnet/tx/80049d16457ec86d15752babe7cf8828ca5923ac1d7f6c619718ec9e464034ea) |
| Treasury funds the pool (100 XLM) | confirmed, 10.2 s | [`fc76008…`](https://stellar.expert/explorer/testnet/tx/fc76008210daf6f64a1e254090a2204bc9850c50f4ea8029fb04267a9d914c02) |
| Confidential coupon payment (12.34 XLM) | confirmed, 12.2 s | [`649c9d3…`](https://stellar.expert/explorer/testnet/tx/649c9d34848cdd9bfa8736f16e13b471e741c5268d26505a5a7a3a7ee6ffc922) |
| Recipient decrypts own balance | `12.34 XLM`, locally | — |
| Bridge — revoke (blocklist insert) | `LeafInserted` | [`2811a69…`](https://stellar.expert/explorer/testnet/tx/2811a6976e8bd2218eff9b16ad54c54d1126eeb1d721ea58d14c87294f92d2a8) |
| **Revoked holder attempts withdrawal** | **blocked** — *"user note key exists in non-membership tree"* | — |
| Bridge — re-grant (blocklist delete) | `LeafDeleted` | confirmed |
| Re-credentialed holder withdraws (5 XLM) | confirmed, 15.2 s | [`9cdd967…`](https://stellar.expert/explorer/testnet/tx/9cdd9675894941338fe0e5d053f4304f92622d0c10aa021e1877bc17c9733436) |

The amounts above appear in this table because we chose to publish them. They are not readable from the pool transactions themselves.

Proving takes roughly 9 s of CPU per operation. The revocation block surfaces client-side, when the wallet assembles its proof context — the association-set check fails before a transaction is ever built.
