# Sigilo

**Confidential coupon payments for tokenized private credit, on Stellar.**

Enterprise / Compliance / RWA → [The demonstration](#the-demonstration).
Confidential-token and private-payment wallets → [The wallet](#the-wallet).

We revoked a holder's KYC credential and they withdrew from the privacy pool anyway: [`c2f2264a`](https://stellar.expert/explorer/testnet/tx/c2f2264ad3d599dac9f7205c3c987568794d83785a7085dcce39de871805aeeb), a real testnet transaction, published rather than deleted. That is the gap. A permissioned token and a confidential rail each enforce their own policy correctly and neither knows about the other, so revoking a credential does nothing to money already inside the pool.

Everyone else proves you are on the list. Sigilo proves you are *not* — and does it where the money already is.

![One identity policy, two enforcement points](docs/img/policy-gate.svg)

Sigilo binds OpenZeppelin's ERC-3643 permissioned token to Nethermind's confidential payment pool through an original Soroban contract — [`contracts/policy-bridge`](contracts/policy-bridge), 368 lines of contract and 526 of tests. Full attribution and pinned commits [below](#what-is-ours-and-what-is-not). Testnet only; see [Running the demo](#running-the-demo).

Every coupon an issuer pays on a public ledger is a published treasury statement: who was paid, when, how much. Institutions raise this first when they evaluate tokenized private credit, and today the answer is to accept it or leave the public chain. Sigilo pays those coupons confidentially, gates them with the same identity policy that gates the token, and lets a holder disclose one payment to an auditor without opening anything else.

The holder's half of that has a page of its own — see [The wallet](#the-wallet).

---

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

### The wallet's own run, with hashes

Driven entirely through [`app/wallet.html`](app/wallet.html) as `inv2`, with the private balance read before and after each step. These are separate transactions from the coupon cycle above.

| Step | `#bal-private` | Transaction |
|---|---|---|
| Deposit 10 XLM into the pool | 387.2291667 → 397.2291667 | [`887123c…`](https://stellar.expert/explorer/testnet/tx/887123c358c9e0e6c7edd1dfd5ed4aff6216143fc1dcea30db3adbde57edae79) |
| **Private send, 3 XLM to `inv5`** | 397.2291667 → 394.2291667 | [`6443916…`](https://stellar.expert/explorer/testnet/tx/6443916a4efd27590b1216a10d444261da792d01c196f68fef6d3b1279f7f80a) |
| Withdraw 2 XLM to the public address | 394.2291667 → 392.2291667 | [`072394c…`](https://stellar.expert/explorer/testnet/tx/072394c8f7c6604ce26a07e8649155988583e05de24056fcd3fa816f8195588b) |

All three return `"status":"SUCCESS"` from `getTransaction`. The middle row is the confidentiality claim, and it is checked rather than asserted — **on decoded XDR, because the amount is encoded as binary and grepping the base64 response for a decimal figure passes on every transaction ever made.** Decoding envelope and result meta and searching for the literal stroop value:

| Transaction | amount in stroops | occurrences in decoded XDR |
|---|---|---|
| Deposit | 100000000 | **11** — envelope 5, meta 6 |
| **Private send** | 30000000 | **0** — envelope 0, meta 0 |
| Withdraw | 20000000 | **6** — envelope 2, meta 4 |

The deposit and the withdrawal are the control: value crossing the pool boundary is public by construction, and the same method finds it every time. The transfer's zero is therefore a result and not a broken search. That transaction carries the full confidential machinery — `new_commitment` ×4, `new_nullifier` ×4, `encrypted_output` ×6 — and has no `amount` field anywhere in its envelope. `inv5` opens it as `3.00` in their own wallet, from the note ciphertext, with their own key.

Reproduce any row:

```bash
curl -s -X POST https://soroban-testnet.stellar.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":{"hash":"<HASH>"}}' \
| jq -r '.result.envelopeXdr' | stellar xdr decode --type TransactionEnvelope --output json \
| grep -c 30000000        # → 0 for the send, non-zero for deposit and withdrawal
```

**What this run does not contain, and why.** The fourth step — revoke the credential, sync, and watch the withdrawal be refused in the wallet — was not recorded. The bridge deployed at `CCCVU6BZ…` predates the binding fix and still exposes `grant(holder, leaf)` / `revoke(holder, note_key)`, while [`scripts/policy-bridge.sh`](scripts/policy-bridge.sh) now calls the fixed signatures, so `sync` cannot drive that deployment. Producing it means redeploying the association trees, which mints new note keys for every holder and orphans the contract ids the table above narrates. The refusal itself is demonstrated in the coupon-cycle run — rows four and five — and that path runs through the pool's association-set check, not the bridge, so a screenshot of it would look identical before and after the fix and would not be evidence of the fix regardless.

Full sequence and enforcement semantics: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reference-run). Step-by-step walkthrough: [docs/DEMO.md](docs/DEMO.md).

## The wallet

A confidential balance is only worth holding if you can prove one line of it. That is the half most privacy wallets leave out, and it is the half that decides whether a holder can answer an accountant, a counterparty or a regulator without surrendering everything else at the same time. Hiding a balance is the easy part. Opening exactly one payment out of it, to someone who holds no keys, is the part that makes the hiding usable.

**[`app/wallet.html`](app/wallet.html)** is the holder's side as its own page: the balance decrypted locally, a private send, a deposit, a withdrawal the policy gate can refuse, the payment history, the enrolment check a holder runs against their own key — and a receipt for one payment, verified on the same page by a panel with no keys, no storage and no account. Linked from the demo's header; it navigates rather than opening a tab, because the storage lock allows one page at a time.

The demo's Investor tab shows the same balance from inside the issuer's story. This page is the holder's own, which is why the checks a holder runs against their own key live here and not there.

**Nothing on the page is readable off it.** The amounts come out of note ciphertexts with the holder's own key. An observer reading the same transactions on an explorer sees `invoke_host_function` and two addresses — the position is public because a securities register should be, and every coupon paid against it is not.

**Disclosure is theirs to give.** The holder picks one payment and proves that payment: the circuit requires the note's spending key, so not even the issuer can produce it on their behalf. Each disclosed field is marked **proven** or **attested**, because a zero-knowledge proof and a claim someone made are different objects and a receipt that blurs them is worse than no receipt. Raise the claimed amount by one digit and the verdict flips to Refused with `Proof: no` while the other checks still pass — the panel says which guarantee broke, not merely that one did.

**The withdrawal is where the policy gate is felt.** A blocklisted holder is refused client-side, before a transaction exists, over coupons they already held. A refusal for any other reason — an empty balance, no spendable note — is reported as itself: the freeze is named only when the rail actually named it.

**The enrolment is checkable by the person it was done to.** The wallet re-derives the allow-list leaf standing in the holder's name from their own key and compares it, which is what turns [the leaf trade-off](#the-trade-offs-behind-those-rows) into something detectable rather than something to be told. The secret behind it never reaches the page and the issuer never holds it, so a match means nobody enrolled a stranger in their place. It lives here and nowhere else — a check on your own key belongs on your own page, and one copy cannot drift from another.

**What the wallet is not.** It opens the five seeded holders from throwaway keys, not an account you own; a real one holds a single key and asks a browser extension for it. Deposit, private send and withdrawal are now recorded on testnet with published hashes — [the wallet's own run](#the-wallets-own-run-with-hashes) — but the policy-gated *refusal* is not, for the reason given there. Proving is real work: roughly 9–13 s of Groth16 per operation, in a worker, and the page says so rather than looking hung.

## Verify this yourself

Nothing here asks to be taken on trust. Three checks run without our deployment, our keys, or us:

```bash
cd contracts/policy-bridge && cargo test   # 16 tests, led by the refusals:
                                           # revoke() fails while the registry still verifies (#3)
node tools/verify-receipt.mjs --self-test  # the vendored SDK loads outside a browser, and the
                                           # exact receipt schema the auditor accepts
node app/tools/key-gate.mjs                # the browser signer derives the same keys as the CLI,
                                           # per holder — the demo's wallets are not staged
```

`cargo test` names its own argument: `refuses_to_freeze_someone_still_in_good_standing` is the constraint nobody implements, because it costs the operator flexibility and buys them nothing until an investor sues. Beside it, `a_decoy_holder_cannot_be_used_to_freeze_a_third_party` is the one that found a real defect in this contract — see [the leaf and the key](#the-trade-offs-behind-those-rows).

And the two transactions that carry the whole argument, on a public explorer, no tooling at all:

- [the revoked holder's withdrawal succeeding](https://stellar.expert/explorer/testnet/tx/c2f2264ad3d599dac9f7205c3c987568794d83785a7085dcce39de871805aeeb) — before the policy gate was told
- [the same holder withdrawing again after re-credentialing](https://stellar.expert/explorer/testnet/tx/9cdd9675894941338fe0e5d053f4304f92622d0c10aa021e1877bc17c9733436)

## What is hidden, and what is not

Confidentiality, not anonymity. Being precise about the boundary is the point — an enterprise reader will find these anyway.

| | Visible | Why, or how it is mitigated |
|---|---|---|
| Coupon amounts, in pool transactions | **no** | Pedersen commitments; recovered only by the recipient's key |
| Which holder received a given payment | **no** | on-chain; the issuer knows, from its own records |
| Addresses transacting with the pool | yes | inherent to the design — confidentiality, not anonymity |
| Token positions | yes | a securities register should be legible to a regulator; confidential balances are future work |
| Aggregate value the treasury funded into the pool | yes | mitigated by pre-funding in round amounts, decoupled from any cycle |
| **Membership of the allow-list** | **yes** | a cap table, not a mixer — see below |
| **This demo's amounts** | **recomputable** | the seed publishes the rate and the positions. In a real deployment the deal rate is the issuer's private data — that is the thing the confidential payments protect |

### The trade-offs behind those rows

Each of these is a decision, not an oversight. They are stated as what was traded for what.

**Membership is public, and the set is small.** This deployment has five holders. A regulated issuance has tens, not tens of thousands, and every association-root transition is a public subtraction against that set — so a revocation is a timestamped, attributable event. Amounts stay hidden; membership does not. That is the correct shape for a securities register and the wrong shape for a mixer, and Sigilo is the first one. Pooling across issuers would enlarge the set, and immediately raises whose policy binds whom — unsolved here, and named rather than papered over.

**Revocation is retroactive and total, and that is the point.** A blocklisted holder cannot spend *anything* in the pool, including coupons received before the revocation. Surgical revocation would leave a sanctioned holder free to spend every pre-revocation coupon — exactly the failure this project exists to prevent. The cost is that a payment to a revoked holder is best described as held until they are re-credentialed, not as excluded. Re-credentialing lifts it.

**The leaf derivation is trusted — and at `grant`, the failure is liveness, not safety.** An allow-list leaf is `poseidon2(note_public_key, asp_secret)`, computed off-chain because the ASP secret belongs to the holder and the contract never sees it. So the guarantee is that no leaf is inserted for an address the registry refuses, not that a given leaf belongs to the holder named beside it. An operator who inserts a wrong leaf denies that holder service — which they could already do by refusing to onboard them. They cannot use it to let an uncredentialed party spend, because the pool still requires a valid proof against a real note. Proving the derivation on-chain removes the assumption; that is a larger piece of work than this one. In the meantime the holder can **check it themselves** — [the wallet](#the-wallet) re-derives the leaf from their own key and compares it to the one on record.

**The same reasoning was wrong at `revoke`, and that one was a safety hole.** This is the project's own negative result, kept here because the argument above is exactly the mistake that produced it. Freezing a holder means inserting their *note key* into the blocklist, and `revoke` used to take that key as an argument: the credential check ran against the `holder` named in the call while the write acted on whatever key was passed, with nothing joining them. An operator could therefore satisfy the gate with an uncredentialed decoy address of their own and hand it a credentialed holder's note key — which is public by design — and freeze an investor in good standing. A wrong leaf costs its own holder service; a wrong note key cost somebody else theirs. Treating both as one liveness trade-off is how it went unnoticed. It is closed now: `revoke` and `restore` take no key at all, reading the `Enrolment` written when the register approved that holder, and a reverse index refuses any attempt to bind one holder's key to another (`NoteKeyBound`, #7). Tests `a_decoy_holder_cannot_be_used_to_freeze_a_third_party` and `grant_twice_with_a_different_note_key_is_refused` fail if either guard is removed. **The testnet deployment still runs the version with the defect** — see [the note in ARCHITECTURE.md](docs/ARCHITECTURE.md#the-bridge-is-a-contract).

**Enrolment needs the holder's consent, and the interface says so.** An allow-list leaf commits to the holder's ASP secret, which is theirs. Handing it over is what makes them identifiable to the policy operator. The demo reads it from the CLI's local state; a real deployment collects it during onboarding, and the holder knows it did.

## What is ours, and what is not

Judges at this event will see a lot of demos built on the same two libraries, so here is the line, drawn after you have seen what it produced.

**Not ours.** The privacy pool, its Groth16 circuits, the association-set (ASP) contracts and the web SDK are Nethermind's [stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments). The permissioned-token suite is OpenZeppelin's [RWA / ERC-3643 implementation](https://github.com/OpenZeppelin/stellar-contracts). Both Apache-2.0, both used unmodified, both pinned by commit in [NOTICE](NOTICE).

**Ours.** [`contracts/policy-bridge`](contracts/policy-bridge) — 368 lines, plus 526 lines of tests. The on-chain policy gate that binds the two, and the argument for why one is needed. To put it in front of your own registry and pool, see [Using it in your own deployment](docs/ARCHITECTURE.md#using-it-in-your-own-deployment).

A permissioned token asks an identity registry who may hold it. Confidential payments prove, against an allow-list and a blocklist, who may spend. Each enforces its own policy correctly, and neither knows about the other: **revoking a holder's credential does nothing to funds already inside the pool.**

The contract closes that gap without asking anyone to be trusted. It owns both lists and consults the registry before moving either — `grant` fails unless the registry verifies the holder (`NotCredentialed`, #2), `revoke` fails while it still does (`StillCredentialed`, #3). So an operator cannot invent a credential. Nor can they manufacture a freeze against an investor in good standing: `revoke` takes no key, acting only on the `Enrolment` recorded when the register approved that holder (`NotEnrolled`, #4, when there is none), and a note key already bound to one holder cannot be re-bound to another (`NoteKeyBound`, #7). That second half is a repair, not an original claim — the first version took the key as an argument and the guarantee did not hold; [the trade-offs section](#the-trade-offs-behind-those-rows) says how. Their own attempt to reach the lists directly is refused by the network:

```
error: Missing signing key for account CCCVU6BZA4JRPZNYGCEMFYNV2DN3RJ676EY25NGMKSAMS4PFCRHE6JID
```

That account is the contract. It has no private key, and its only entrypoints check the registry.

Also ours: the coupon service (accrual, payment cycle), the three-role demo interface, the holder wallet, the local signer, and the deployment scripts.

## Running the demo

> ⚠️ Built for the [Stellar Builder Summit SP 26](https://bounties.grantfox.xyz/events/stellar-summit-sp-2026). **Testnet only**, on unaudited alpha dependencies. Not for real value.

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
                                 #   holder's wallet: /app/wallet.html
```

The confidential payment pool also needs its own instance — the reference deployment's allow-list and blocklist are admin-gated by their deployer, so grant and revoke are not available on it. `deployments/scripts/deploy.sh` in `$SPP_REPO` deploys one; the web SDK embeds its deployment at compile time, so it must then be rebuilt against yours ([vendor/spp-sdk-web/README.md](vendor/spp-sdk-web/README.md) has the steps, including the macOS clang fix that upstream's guide omits).

**On macOS**, the SDK compiles SQLite to wasm and Apple clang has no wasm backend:

```bash
brew install llvm
export CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang
```

Demo configuration — local seed keys, the server-side admin key, and the single-page storage lock — is declared in [docs/DEMO.md](docs/DEMO.md#demo-configuration-declared).

## Built on

| | Commit | License |
|---|---|---|
| [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) | `461c1d0` | Apache-2.0 |
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) | `9b5ed96` | Apache-2.0 |
