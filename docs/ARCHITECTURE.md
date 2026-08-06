# Architecture

## The problem

On a public ledger, every coupon payment an issuer makes is a published treasury statement. Anyone with an explorer reads the issuer's payment flow: who was paid, when, and how much per transaction. This is the objection institutions raise first when evaluating tokenized private credit, and today the choice is binary — full transparency, or leave the public chain.

## What Sigilo does

One identity policy governs two enforcement points:

![One identity policy, two enforcement points](img/policy-gate.svg)

The permissioned token enforces **who may hold**. The confidential payment pool enforces **who may spend**. The policy gate keeps both governed by the same KYC source — and, because it owns the lists outright, keeps the issuer from reaching either one directly.

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

## The bridge is a contract

[`contracts/policy-bridge`](../contracts/policy-bridge) owns both association sets and moves them only after asking the identity register itself. Deployed at
[`CCCVU6BZ…`](https://stellar.expert/explorer/testnet/contract/CCCVU6BZA4JRPZNYGCEMFYNV2DN3RJ676EY25NGMKSAMS4PFCRHE6JID).

> **That deployed instance predates the binding fix below.** Every hash on this
> page was produced against it and each one is a real run, so none of them are
> withdrawn — but the contract at that address is the version whose `revoke`
> takes a `note_key` argument, and it carries the defect described in the next
> section. It cannot be upgraded in place: it permanently administers the two
> association trees and exposes no `update_admin` passthrough, which is the same
> property that makes the gate non-circumventable. Shipping the fix means
> deploying new trees and a new bridge, and that redeployment has not been done.
> The source in this repository is fixed; the testnet deployment is not.

Both directions are gated, which is what makes it more than automation:

```rust
pub fn grant(env: Env, holder: Address, leaf: U256, note_key: U256) -> Result<(), Error> {
    Self::operator(&env)?.require_auth();
    if !Self::registry_verifies(&env, &holder)? {
        return Err(Error::NotCredentialed);      // cannot invent a credential
    }
    // …record Enrolment { leaf, note_key }, then insert the leaf
}

pub fn revoke(env: Env, holder: Address) -> Result<(), Error> {
    Self::operator(&env)?.require_auth();
    if Self::registry_verifies(&env, &holder)? {
        return Err(Error::StillCredentialed);    // the register still vouches
    }
    let on_record = Self::enrolment_of(&env, &holder)?;   // else NotEnrolled
    // …insert on_record.note_key into the blocklist
}
```

The second refusal is the one worth dwelling on, and the first version of this
contract did not actually make it.

`revoke` used to take the key to freeze as an argument. The gate was evaluated
against `holder` while the write acted on whatever `note_key` the caller passed,
and nothing joined the two — so an operator could satisfy the gate with an
uncredentialed decoy address and hand it a *credentialed* holder's note key,
which is public by design. The refusal below was real; it simply guarded the
wrong party. That is recorded here rather than quietly corrected, because a
project that publishes its negative results does not get to make an exception
for its own contract.

What closes it is the enrolment record. `revoke` takes no key at all, so there
is no argument with which to name a victim: the key frozen is the one written
when the register approved *this* holder. A reverse index makes the binding
exclusive — a note key already bound to someone else is refused at `grant` with
`NoteKeyBound` (#7), so the decoy cannot be given the victim's key in the first
place. An operator can neither invent a credential nor manufacture a freeze
against an investor in good standing, and the mechanism is nameable: the stored
`Enrolment`, and the errors `StillCredentialed` (#3), `NotEnrolled` (#4) and
`NoteKeyBound` (#7).

Test: `a_decoy_holder_cannot_be_used_to_freeze_a_third_party`. Delete the
uniqueness guard and that test fails, and no other does.

**What makes this real rather than decorative** is the handover: the association sets name the contract as their admin, so there is no path to them that skips it. The operator's own attempt is refused by the network, not by convention:

```
$ stellar contract invoke --id <allowlist> --source issuer -- insert_leaf --leaf 999888777
error: Missing signing key for account CCCVU6BZA4JRPZNYGCEMFYNV2DN3RJ676EY25NGMKSAMS4PFCRHE6JID
```

That account is the contract. It has no private key and never will.

| Attempt | Result |
|---|---|
| Operator writes to the allowlist directly | refused — no signing key exists for the contract |
| `grant` for a credentialed holder | [`b45d2091`](https://stellar.expert/explorer/testnet/tx/b45d2091cfcc) |
| `revoke` for a holder still in good standing | `Error(Contract, #3)` `StillCredentialed` |
| `revoke` for a holder never enrolled | `Error(Contract, #4)` `NotEnrolled` |
| `grant` binding a note key another holder already owns | `Error(Contract, #7)` `NoteKeyBound` |
| `revoke` when the register cannot be reached or is unconfigured | `Error(Contract, #6)` `VerifierUnavailable` |

`scripts/policy-bridge.sh` still exists, but its role changed: it proposes, and the contract decides. Its sixteen tests lead with the refusals, since those are the reason the contract exists.

### What remains trusted

**The leaf, at `grant` — and the failure there is liveness, not safety.**
`poseidon2(note_public_key, asp_secret)` is computed off-chain, because the ASP
secret belongs to the holder and the contract never sees it. So the contract
guarantees *that no leaf is inserted for an address the register refuses* — not
that a given leaf corresponds to the holder named alongside it. An operator who
records a wrong leaf denies that holder service, which they could already do by
declining to onboard them; they cannot use it to let an uncredentialed party
spend, because the pool still demands a valid proof against a real note. Closing
it means proving the derivation on-chain, which is a larger piece of work than
this one. In the meantime the holder can check it: the wallet re-derives the leaf
from their own key and compares.

**The note key, at `revoke` — and that one was a safety hole, now closed.** The
same "it is just a value the operator supplies" reasoning does *not* transfer to
the freeze path, and treating the two as one trade-off is how the defect went
unnoticed. A wrong leaf costs its own holder service; a wrong note key froze
somebody else. `revoke` no longer accepts one — it reads `Enrolment(holder)`,
written under the register's approval — and `DataKey::NoteKeyOwner` makes that
binding exclusive, so the key cannot be claimed by a second address. Tests:
`a_decoy_holder_cannot_be_used_to_freeze_a_third_party`,
`grant_twice_with_a_different_note_key_is_refused`.

**The register's silence is no longer read as a verdict.** `verify_identity`
reports refusal by trapping, and the first version treated *every* trap as "not
credentialed" — so `grant` failed closed while `revoke` failed open, and an
unreachable or misconfigured register became permission to freeze. Only
`Error(Contract, #304)` `IdentityVerificationFailed` and `#321`
`IdentityNotFound` are the register answering. Anything else — including `#310`
and `#311`, which mean the verifier's own storage was never configured — returns
`VerifierUnavailable` (#6) and stops both directions. Test:
`a_misconfigured_register_is_not_a_verdict`.

**Still deferred, deliberately.** Operator rotation: the operator address is
fixed at construction. That is availability, not integrity — a rotated operator
still cannot bypass the register — but a lost key means redeploying. And
enrolment is write-once: a holder bound to the wrong leaf cannot be rebound
without a redeploy, where previously a re-`grant` would have papered over it.
That is a deliberate trade of correctability for immutability, and it is the
price of the same one-way door that locks the operator out of the trees.

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

The operator no longer has discretion over whether a tree moves — the `PolicyBridge` contract
above re-checks the register on-chain before either insertion, and the trees answer to nobody
else. What is still taken on faith is the leaf itself; see [What remains trusted](#what-remains-trusted).

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

### The wallet's own run

Driven through [`app/wallet.html`](../app/wallet.html) as `inv2`, separate from the coupon cycle above. The private balance is read from the page before and after each step; every hash returns `"status":"SUCCESS"`.

| Step | `#bal-private` | Transaction |
|---|---|---|
| Deposit 10 XLM | 387.2291667 → 397.2291667 | [`887123c…`](https://stellar.expert/explorer/testnet/tx/887123c358c9e0e6c7edd1dfd5ed4aff6216143fc1dcea30db3adbde57edae79) |
| **Private send, 3 XLM to `inv5`** | 397.2291667 → 394.2291667 | [`6443916…`](https://stellar.expert/explorer/testnet/tx/6443916a4efd27590b1216a10d444261da792d01c196f68fef6d3b1279f7f80a) |
| Withdraw 2 XLM | 394.2291667 → 392.2291667 | [`072394c…`](https://stellar.expert/explorer/testnet/tx/072394c8f7c6604ce26a07e8649155988583e05de24056fcd3fa816f8195588b) |

The confidentiality check runs on **decoded** XDR. Encoded integers are binary, so searching the base64 response for a decimal figure succeeds on every transaction ever made and proves nothing — that check would have been a rubber stamp. Decoding envelope and result meta and counting the literal stroop value:

| Transaction | stroops | occurrences |
|---|---|---|
| Deposit | 100000000 | 11 |
| **Private send** | 30000000 | **0** |
| Withdraw | 20000000 | 6 |

Deposit and withdrawal are the positive control — value crossing the pool boundary is public by construction, and the identical method finds it both times. The transfer's zero is therefore a measurement rather than a failed search. That transaction carries `new_commitment` ×4, `new_nullifier` ×4 and `encrypted_output` ×6, and exposes no `amount` field in its envelope; `inv5` reads it as `3.00` locally from the note ciphertext.

**Not recorded:** the revoke → sync → refused-withdrawal step. The bridge at `CCCVU6BZ…` predates the binding fix and exposes the old `revoke(holder, note_key)` arity, so `scripts/policy-bridge.sh sync` cannot drive it. That refusal is already published in the coupon-cycle run above, and it is enforced by the pool's association-set check rather than by the bridge — so it would look the same before and after the fix either way.

Proving takes roughly 9 s of CPU per operation. The revocation block surfaces client-side, when the wallet assembles its proof context — the association-set check fails before a transaction is ever built.

## Using it in your own deployment

The reusable piece is [`contracts/policy-bridge`](../contracts/policy-bridge) — one Soroban contract, 368 lines against 526 of tests. Everything else in this repository exists to demonstrate it.

**What you need already.** The contract does not deploy an identity registry or a confidential pool; it binds two you already run. It calls them by name, so yours must expose these:

| Component | What the contract calls |
|---|---|
| Identity verifier (ERC-3643 / OZ RWA) | `verify_identity(address)` — reports refusal by trapping. Only `Error(Contract, #304)` and `#321` are read as *not credentialed*; any other trap is `VerifierUnavailable` and stops both directions |
| Allow-list (ASP membership) | `insert_leaf(leaf)`, plus `update_admin(new_admin)` once |
| Blocklist (ASP non-membership) | `insert_leaf(key, value)` to freeze, `delete_leaf(key)` to lift, plus `update_admin(new_admin)` once |

**Deploy it** with the four addresses it will govern:

```bash
stellar contract deploy --wasm policy_bridge.wasm \
  -- --operator <your issuer key> --verifier <identity verifier> \
     --allowlist <asp membership> --blocklist <asp non-membership>
```

**Then hand over both trees — this is the step that matters.** Until the association sets name the contract as their admin, the operator can still write to them directly and every guarantee below is decorative:

```bash
stellar contract invoke --id <allowlist> -- update_admin --new_admin <bridge>
stellar contract invoke --id <blocklist> -- update_admin --new_admin <bridge>
```

**Verify the handover took.** Read each tree's admin and require it to be the bridge you just deployed:

```bash
KEY=$(printf '{"vec":[{"symbol":"Admin"}]}' | stellar xdr encode --type ScVal --output single-base64)
stellar contract read --id <allowlist> --durability persistent --key-xdr "$KEY"
# → the bridge's contract id
```

Assert *who* the admin is, not merely that you are refused. A refusal is equally consistent with some earlier bridge owning the tree, so it passes in exactly the case worth catching — that mistake was in this repository, and [`scripts/deploy-bridge.sh`](../scripts/deploy-bridge.sh) now checks identity instead. It also refuses to deploy at all unless both trees still answer to the operator, because the handover is the one step that cannot be retried.

**From then on**, `grant(holder, leaf, note_key)`, `revoke(holder)` and `restore(holder)` replace every direct write. Each asks the registry first and refuses to contradict it — `grant` fails with `NotCredentialed` (#2), `revoke` fails with `StillCredentialed` (#3), either fails with `VerifierUnavailable` (#6) when the register cannot be reached. `revoke` and `restore` take no key: they act on the `Enrolment` recorded at `grant`, so the key frozen is always the one the register approved, and `NoteKeyBound` (#7) stops two holders claiming one key. `enrolment(holder)` and `is_credentialed(holder)` are public reads, so anyone can check both the binding and the decision the contract acted on, and every state change emits a `PolicyChanged` event carrying the action, the holder and both keys — so an auditor reconstructs who was enrolled or frozen, when, and *which key moved*, without asking you.

**The honest limit on portability.** Those function names and arities are how the contract talks to its neighbours, and they match Nethermind's ASP contracts and OpenZeppelin's verifier at the pinned commits. Different components mean editing those call sites — the pattern transfers, the exact invocations may not. And this is testnet work on unaudited alpha dependencies: adopt the design, not this build, for anything holding real value.
