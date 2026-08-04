# Sigilo

**Confidential coupon payments for tokenized private credit, on Stellar.**

Every coupon an issuer pays on a public ledger is a published treasury statement. Anyone with an explorer reads the payment flow: who was paid, when, how much. Institutions raise this first when they evaluate tokenized private credit, and today the answer is to accept it or leave the public chain.

Sigilo pays those coupons through a confidential rail, keeps eligibility governed by the same KYC credential that governs the token, and lets a holder prove one specific payment to an auditor without opening anything else.

> ⚠️ Built for the [Stellar Builder Summit SP 26](https://bounties.grantfox.xyz/events/stellar-summit-sp-2026), Enterprise / Compliance / RWA sub-lane. **Testnet only**, on unaudited alpha dependencies. Not for real value.

---

## What is ours, and what is not

Judges at this event will see a lot of demos built on the same two libraries. The line matters, so here it is:

**Not ours.** The privacy pool, its Groth16 circuits, the association-set (ASP) contracts and the web SDK are Nethermind's [stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments). The permissioned-token suite is OpenZeppelin's [RWA / ERC-3643 implementation](https://github.com/OpenZeppelin/stellar-contracts). Both Apache-2.0, both pinned by commit in [NOTICE](NOTICE).

**Ours.** The bridge between them — and the argument for why one is needed.

A permissioned token asks an identity register who may hold it. A confidential rail proves, against its association sets, who may spend. Each enforces its own policy correctly, and neither knows about the other: **revoking a holder's credential does nothing to funds already inside the rail.** [`scripts/policy-bridge.sh`](scripts/policy-bridge.sh) closes that gap by making the association sets follow the register — grant puts a holder in the allowlist, revocation puts them in the blocklist, and because the pool checks proofs against the *current* roots, the freeze reaches backwards over coupons they already hold.

Also ours: the coupon service (accrual, payment cycle), the three-role demo interface, the local signer, and the deployment scripts.

## The demonstration

Reproduced on testnet, every hash public.

**A credential is enforced by the token.** Transferring to an address with no KYC claim is rejected by on-chain policy; after the claim is issued, the same transfer goes through.

**A coupon cycle pays without publishing amounts.** Five holders, accrued from each one's entry date — deliberately not pro-rata, because positions are public and proportional coupons would be recoverable from a single disclosed payment. Searching the payment transaction for any of the five amounts returns nothing; the operation declares only `invoke_host_function`. The recipient decrypts theirs locally.

**Revocation freezes, and the gap is visible.** After revoking a credential in the register, the holder still withdrew from the pool ([`c2f2264a`](https://stellar.expert/explorer/testnet/tx/c2f2264ad3d599dac9f7205c3c987568794d83785a7085dcce39de871805aeeb)). After running Sync, the same withdrawal was refused — *"user note key exists in non-membership tree"*. That first step is the argument: without the bridge, an issuer who revokes a holder has revoked nothing where the money is.

**An auditor verifies one payment and learns nothing else.** The holder generates a proof for a single coupon; the auditor checks it with no wallet, no storage and no privileged access. Change one digit of the proof and the verdict flips to Refused with `Proof: no`, while the other checks still pass — the interface says which guarantee broke.

Full run with transaction hashes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reference-run).

## What is hidden, and what is not

Confidentiality, not anonymity. Being precise about the boundary is the point — an enterprise reader will find these anyway.

| | Visible | Why, or how it is mitigated |
|---|---|---|
| Coupon amounts, in rail transactions | **no** | Pedersen commitments; recovered only by the recipient's key |
| Which holder received a given payment | **no** | on-chain; the issuer knows, from its own records |
| Addresses transacting with the pool | yes | inherent to the design — confidentiality, not anonymity |
| Token positions | yes | a securities register should be legible to a regulator; confidential balances are future work |
| Aggregate value the treasury funded into the pool | yes | mitigated by pre-funding in round amounts, decoupled from any cycle |
| **This demo's amounts** | **recomputable** | the seed publishes the rate and the positions. In a real deployment the deal rate is the issuer's private data — that is the thing the rail protects |

Two more limits worth stating plainly:

**Revocation is retroactive and total.** A blocklisted holder cannot spend *anything* in the pool, including coupons received before the revocation. This is deliberate and re-credentialing lifts it, but a payment to a revoked holder is best described as held in treasury until they are re-credentialed, not as excluded.

**The bridge is trusted.** It runs as an issuer-side service with admin rights over the association sets. Nothing on-chain forces it to mirror the register faithfully. The contract that would remove that discretion — a `PolicyBridge` performing a cross-contract `is_verified` check before touching a tree — is specified in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), not implemented.

**Enrolment needs the holder's consent.** An allowlist leaf commits to the holder's ASP secret, which is theirs. Handing it over is what makes them identifiable to the policy operator; the demo takes it from the CLI's local state, a real deployment would collect it during onboarding.

## Running it

Needs the Stellar CLI, Rust, Node 22+, `jq`, and clones of the two upstream repositories at the pinned commits.

```bash
export OZ_REPO=/path/to/stellar-contracts      # 9b5ed96, built to target/wasm32v1-none/release
export SPP_REPO=/path/to/stellar-private-payments   # 461c1d0

./scripts/deploy-rwa.sh          # permissioned token, identities, signed KYC claims
./scripts/export-demo-keys.sh    # throwaway signing keys for the browser
./scripts/policy-bridge.sh enroll
./scripts/policy-bridge.sh sync  # association sets follow the register

cd app && ./build.sh && cd ..
node app/server.mjs              # → http://localhost:8080/app/index.html
```

The rail also needs its own instance — the reference deployment's association sets are admin-gated by their deployer, so grant and revoke are not available on it. `deployments/scripts/deploy.sh` in `$SPP_REPO` deploys one; the web SDK embeds its deployment at compile time, so it must then be rebuilt against yours ([vendor/spp-sdk-web/README.md](vendor/spp-sdk-web/README.md) has the steps, including the macOS clang fix that upstream's guide omits).

**On macOS**, the SDK compiles SQLite to wasm and Apple clang has no wasm backend:

```bash
brew install llvm
export CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang
```

### Demo configuration, declared

The browser signs with **local seed keys**, not a wallet extension — a recorded demo cannot afford an extension popup per payment and an account switch per role. The signer is a plain object satisfying the SDK's three-method interface ([app/js/local-signer.js](app/js/local-signer.js)); `app/tools/key-gate.mjs` proves it derives the same keys the CLI does.

Editing the register and moving the association sets need the issuer's admin key and the Stellar CLI, so they run in [app/server.mjs](app/server.mjs) rather than the page. In a real deployment that is the securitiser's internal service.

The three roles share one page because they must: the rail's storage holds an exclusive OPFS lock, and a second tab evicts the first.

## Layout

```
app/            three-role demo interface + issuer back-office server
scripts/        deployment, policy bridge, credential and key management
tools/          leaf derivation, receipt verification probe
vendor/         rebuilt rail SDK, pinned against our own deployment
docs/           architecture, enforcement semantics, reference run
```

## Built on

| | Commit | License |
|---|---|---|
| [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) | `461c1d0` | Apache-2.0 |
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) | `9b5ed96` | Apache-2.0 |
