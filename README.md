# Sigilo

**Confidential coupon payments for tokenized private credit, on Stellar.**

Every coupon an issuer pays on a public ledger is a published treasury statement. Anyone with an explorer reads the payment flow: who was paid, when, how much. Institutions raise this first when they evaluate tokenized private credit, and today the answer is to accept it or leave the public chain.

Sigilo pays those coupons confidentially — amounts hidden from outside observers on-chain — gates them with the same identity policy that gates the token, and lets a holder disclose one specific payment to an auditor without opening anything else.

> ⚠️ Built for the [Stellar Builder Summit SP 26](https://bounties.grantfox.xyz/events/stellar-summit-sp-2026), Enterprise / Compliance / RWA sub-lane. **Testnet only**, on unaudited alpha dependencies. Not for real value.

![One identity policy, two enforcement points](docs/img/policy-gate.svg)

---

## What is ours, and what is not

Judges at this event will see a lot of demos built on the same two libraries. The line matters, so here it is first.

**Not ours.** The privacy pool, its Groth16 circuits, the association-set (ASP) contracts and the web SDK are Nethermind's [stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments). The permissioned-token suite is OpenZeppelin's [RWA / ERC-3643 implementation](https://github.com/OpenZeppelin/stellar-contracts). Both Apache-2.0, both pinned by commit in [NOTICE](NOTICE).

**Ours.** [`contracts/policy-bridge`](contracts/policy-bridge) — the on-chain policy gate that binds them, and the argument for why one is needed.

A permissioned token asks an identity registry who may hold it. Confidential payments prove, against an allow-list and a blocklist, who may spend. Each enforces its own policy correctly, and neither knows about the other: **revoking a holder's credential does nothing to funds already inside the pool.**

The contract closes that gap and, more importantly, closes it without asking anyone to be trusted. It owns both lists and consults the registry before moving either — `grant` fails unless the registry verifies the holder, `revoke` fails while it still does. So an operator can neither invent a credential nor manufacture a freeze against an investor in good standing. Their own attempt to reach the lists directly is refused by the network:

```
error: Missing signing key for account CCCVU6BZA4JRPZNYGCEMFYNV2DN3RJ676EY25NGMKSAMS4PFCRHE6JID
```

That account is the contract. It has no private key.

And because the pool checks proofs against the *current* list roots, a freeze reaches backwards over coupons the holder already received.

Also ours: the coupon service (accrual, payment cycle), the three-role demo interface, the local signer, and the deployment scripts.

## The demonstration

Reproduced on testnet, every hash public.

**A credential is enforced by the token.** Transferring to an address with no KYC claim is rejected by on-chain policy; after the claim is issued, the same transfer goes through.

**A coupon cycle pays without publishing amounts.** Five holders, accrued from each one's entry date — deliberately not pro-rata, because positions are public and proportional coupons would be recoverable from a single disclosed payment. Searching the payment transaction for any of the five amounts returns nothing; the operation declares only `invoke_host_function`. The recipient decrypts theirs locally.

**Revocation freezes, and the gap is visible.** After revoking a credential in the register, the holder still withdrew from the pool ([`c2f2264a`](https://stellar.expert/explorer/testnet/tx/c2f2264ad3d599dac9f7205c3c987568794d83785a7085dcce39de871805aeeb)). After running Sync, the same withdrawal was refused — *"user note key exists in non-membership tree"*. That first step is the argument: with nothing joining the two, an issuer who revokes a holder has revoked nothing where the money is.

**An auditor verifies one payment and learns nothing else.** The holder generates a proof for a single coupon; the auditor checks it with no wallet, no storage and no privileged access. Raise the receipt's claimed amount by one digit and the verdict flips to Refused with `Proof: no`, while the other checks still pass — the interface says which guarantee broke.

### The run, with hashes

Every one of these is a public testnet transaction.

| Step | Transaction |
|---|---|
| Policy gate — grant, allow-list insert | [`03f0676…`](https://stellar.expert/explorer/testnet/tx/03f067603a497e4ad5b5fba17c96610fed716ea95526e0aab530e4b839d23b4b) |
| Treasury funds the pool | [`fc76008…`](https://stellar.expert/explorer/testnet/tx/fc76008210daf6f64a1e254090a2204bc9850c50f4ea8029fb04267a9d914c02) |
| Confidential coupon payment | [`649c9d3…`](https://stellar.expert/explorer/testnet/tx/649c9d34848cdd9bfa8736f16e13b471e741c5268d26505a5a7a3a7ee6ffc922) |
| Policy gate — revoke, blocklist insert | [`2811a69…`](https://stellar.expert/explorer/testnet/tx/2811a6976e8bd2218eff9b16ad54c54d1126eeb1d721ea58d14c87294f92d2a8) |
| **Revoked holder withdraws — before sync** | [`c2f2264…`](https://stellar.expert/explorer/testnet/tx/c2f2264ad3d599dac9f7205c3c987568794d83785a7085dcce39de871805aeeb) |
| Re-credentialed holder withdraws | [`9cdd967…`](https://stellar.expert/explorer/testnet/tx/9cdd9675894941338fe0e5d053f4304f92622d0c10aa021e1877bc17c9733436) |

The fifth row is the one to open. It is a successful withdrawal by a holder whose credential had already been revoked — the gap the policy gate closes. After syncing, the same withdrawal is refused.

Full sequence and enforcement semantics: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reference-run). Step-by-step walkthrough: [docs/DEMO.md](docs/DEMO.md).

## What is hidden, and what is not

Confidentiality, not anonymity. Being precise about the boundary is the point — an enterprise reader will find these anyway.

| | Visible | Why, or how it is mitigated |
|---|---|---|
| Coupon amounts, in pool transactions | **no** | Pedersen commitments; recovered only by the recipient's key |
| Which holder received a given payment | **no** | on-chain; the issuer knows, from its own records |
| Addresses transacting with the pool | yes | inherent to the design — confidentiality, not anonymity |
| Token positions | yes | a securities register should be legible to a regulator; confidential balances are future work |
| Aggregate value the treasury funded into the pool | yes | mitigated by pre-funding in round amounts, decoupled from any cycle |
| **This demo's amounts** | **recomputable** | the seed publishes the rate and the positions. In a real deployment the deal rate is the issuer's private data — that is the thing the confidential payments protect |

Two more limits worth stating plainly:

**Revocation is retroactive and total.** A blocklisted holder cannot spend *anything* in the pool, including coupons received before the revocation. This is deliberate and re-credentialing lifts it, but a payment to a revoked holder is best described as held in treasury until they are re-credentialed, not as excluded.

**The leaf derivation is trusted.** The contract removed the operator's discretion over *whether* a tree moves, but not over *what* goes into it. An allow-list leaf is `poseidon2(note_public_key, asp_secret)`, computed off-chain because the ASP secret belongs to the holder and the contract never sees it. So the guarantee is that no leaf is inserted for an address the registry refuses — not that a given leaf corresponds to the holder named alongside it. Closing that means proving the derivation on-chain, which is a larger piece of work than this one.

**Enrolment needs the holder's consent.** An allow-list leaf commits to the holder's ASP secret, which is theirs. Handing it over is what makes them identifiable to the policy operator; the demo takes it from the CLI's local state, a real deployment would collect it during onboarding.

## Using it in your own deployment

The reusable piece is [`contracts/policy-bridge`](contracts/policy-bridge) — one Soroban contract, 203 lines. Everything else in this repository exists to demonstrate it.

**What you need already.** The contract does not deploy an identity registry or a confidential pool; it binds two you already run. It calls them by name, so yours must expose these:

| Component | What the contract calls |
|---|---|
| Identity verifier (ERC-3643 / OZ RWA) | `verify_identity(address)` — reports failure by trapping, which is read as *not credentialed* |
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

**Verify you locked yourself out.** Try to write to a tree directly; the network should refuse you, because the contract that now owns it has no private key:

```bash
stellar contract invoke --id <allowlist> --source <issuer> -- insert_leaf --leaf 1
# error: Missing signing key for account C…
```

[`scripts/deploy-bridge.sh`](scripts/deploy-bridge.sh) does all four steps and ends with that check, printing a warning if the handover did not take.

**From then on**, `grant(holder, leaf)`, `revoke(holder, note_key)` and `restore(holder, note_key)` replace every direct write. Each asks the registry first and refuses to contradict it — `grant` fails with `NotCredentialed` (#2), `revoke` fails with `StillCredentialed` (#3). `is_credentialed(holder)` is a public read, so anyone can check the decision the contract acted on, and every call emits a `PolicyChanged` event, so an auditor reconstructs who was enrolled or frozen and when without asking you.

**The honest limit on portability.** Those function names and arities are how the contract talks to its neighbours, and they match Nethermind's ASP contracts and OpenZeppelin's verifier at the pinned commits. Different components mean editing those call sites — the pattern transfers, the exact invocations may not. And this is testnet work on unaudited alpha dependencies: adopt the design, not this build, for anything holding real value.

## Running the demo

Needs the Stellar CLI, Rust, Node 22+, `jq`, and clones of the two upstream repositories at the pinned commits.

```bash
export OZ_REPO=/path/to/stellar-contracts      # 9b5ed96, built to target/wasm32v1-none/release
export SPP_REPO=/path/to/stellar-private-payments   # 461c1d0

./scripts/deploy-rwa.sh          # permissioned token, identities, signed KYC claims
./scripts/export-demo-keys.sh    # throwaway signing keys for the browser
./scripts/policy-bridge.sh enroll
./scripts/policy-bridge.sh sync  # allow-list and blocklist follow the registry

cd app && ./build.sh && cd ..
node app/server.mjs              # → http://localhost:8080/app/index.html
```

The confidential payment pool also needs its own instance — the reference deployment's allow-list and blocklist are admin-gated by their deployer, so grant and revoke are not available on it. `deployments/scripts/deploy.sh` in `$SPP_REPO` deploys one; the web SDK embeds its deployment at compile time, so it must then be rebuilt against yours ([vendor/spp-sdk-web/README.md](vendor/spp-sdk-web/README.md) has the steps, including the macOS clang fix that upstream's guide omits).

**On macOS**, the SDK compiles SQLite to wasm and Apple clang has no wasm backend:

```bash
brew install llvm
export CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang
```

### Demo configuration, declared

The browser signs with **local seed keys**, not a wallet extension — a recorded demo cannot afford an extension popup per payment and an account switch per role. The signer is a plain object satisfying the SDK's three-method interface ([app/js/local-signer.js](app/js/local-signer.js)); `app/tools/key-gate.mjs` proves it derives the same keys the CLI does.

Editing the registry and moving the allow-list and blocklist need the issuer's admin key and the Stellar CLI, so they run in [app/server.mjs](app/server.mjs) rather than the page. In a real deployment that is the securitiser's internal service.

The three roles share one page because they must: the payment SDK's storage holds an exclusive OPFS lock, and a second tab evicts the first.

## Layout

```
app/            three-role demo interface + issuer back-office server
scripts/        deployment, policy gate, credential and key management
tools/          leaf derivation, receipt verification probe
vendor/         rebuilt payment SDK, pinned against our own deployment
docs/           architecture, enforcement semantics, reference run
```

## Built on

| | Commit | License |
|---|---|---|
| [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) | `461c1d0` | Apache-2.0 |
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) | `9b5ed96` | Apache-2.0 |
