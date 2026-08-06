# Running the demo

Written to be followed by someone who did not build this. Every click is listed, with what to expect and how long it takes.

---

## First-time setup

Deploying your own instance, once. If the rail is already deployed, skip to [Before you start](#before-you-start).

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

The confidential payment pool also needs its own instance — the reference deployment's allow-list and blocklist are admin-gated by their deployer, so grant and revoke are not available on it. `deployments/scripts/deploy.sh` in `$SPP_REPO` deploys one; the web SDK embeds its deployment at compile time, so it must then be rebuilt against yours ([vendor/spp-sdk-web/README.md](../vendor/spp-sdk-web/README.md) has the steps, including the macOS clang fix that upstream's guide omits).

**On macOS**, the SDK compiles SQLite to wasm and Apple clang has no wasm backend:

```bash
brew install llvm
export CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang
```

Demo configuration — local seed keys, the server-side admin key, and the single-page storage lock — is declared [below](#demo-configuration-declared).

---

## Before you start

```bash
export OZ_REPO=/path/to/stellar-contracts
export SPP_REPO=/path/to/stellar-private-payments

./scripts/reset.sh          # ~2 min — puts everyone back to a clean state
node app/server.mjs         # leave this running
```

Open **http://localhost:8080/app/index.html**.

If you ran the demo before, also clear the browser's local data for `localhost:8080` (DevTools → Application → Storage → Clear site data), then reload. The browser keeps its own copy of the wallet, and a stale one shows a balance that was already swept away. It does not hide history: note state is rebuilt from the chain, so earlier coupons reappear — marked `spent`, which is what they are.

The page opens on the **Issuer** tab. Three tabs across the top — Issuer, Investor, Auditor — are three people looking at the same system. Nothing else is hidden; that is the whole app.

**Expect to wait.** Proving a confidential payment takes about 9 seconds of real computation, and verifying a disclosure about 13. Nothing is frozen. Every action shows what stage it is at.

---

## Act 1 — The token refuses

*The objection this answers: "a regulator will never accept a bearer asset."*

| # | Do this | What happens |
|---|---|---|
| 1 | Look at **Policy — one credential, two systems** | One row per investor, and two verdicts on each row: `valid` under *identity register*, `allowed` under *confidential rail*, linked by `───` in the middle |
| 2 | In **Issue tokens**, pick `inv3`, click **Issue** | ~5s → `accepted`. A transaction hash appears under Activity |
| 3 | Back in the policy table, click **Revoke** on `inv3` | ~8s → the credential turns `revoked`, but the rail still says `allowed`, the link between them breaks to `╳`, and **out of step — sync** appears under the rail verdict |
| 4 | Click **Issue** again, still on `inv3` | ~5s → **Refused by the token**, *"the registry knows this address, but its claims no longer verify (#304)"* |

**The point of step 4:** nothing reached the ledger. The contract itself refused, during simulation — this is not the interface declining on the token's behalf. A permissioned asset is one that cannot move to someone who is not allowed to hold it, and that is enforced where it counts.

Leave `inv3` revoked. Act 2 continues from here.

---

## Act 2 — The payment nobody can read, and the gap the bridge closes

*The objections: "every coupon we pay would be public" and "so what if you revoke someone."*

### 2a — Paying

| # | Do this | What happens |
|---|---|---|
| 1 | Click **Restore** on `inv3`, then **Sync policy** | ~8s + ~15s → everyone back to `valid` / `allowed`, every link `───` |
| 2 | Look at **Coupon cycle** | Five amounts, none proportional to the positions — each accrues from that holder's own entry date |
| 3 | Click **Pay coupon cycle** | **~75 seconds.** Five confidential payments, each with its own proof. Watch the status column turn `paid` one by one and the hashes stack up under Activity |
| 4 | Open any of those hashes on the explorer | An `invoke_host_function` call. **No amount anywhere in it.** Search the page for `119.34` or `287.25` — nothing |
| 5 | Switch to the **Investor** tab, pick `inv4` | ~10s → `287.25625 XLM — decrypted locally`. The exact number the issuer computed, recovered from the note's ciphertext with this holder's key |

**The contrast on that screen is the argument.** Left column: what anyone can see — the address, the position, the entry date, all public, because a securities register should be legible to a regulator. Right column: what only this holder can see. The position was never secret. The payment always was.

### 2b — Revoke, and watch the gap

| # | Do this | What happens |
|---|---|---|
| 1 | Issuer tab → **Revoke** on `inv5` | ~8s → `revoked` / `╳` / `allowed` + **out of step — sync** |
| 2 | Stop and read that row | The credential is gone from the register. **The rail has not been told.** Right now `inv5` can still spend the coupon they already hold |
| 3 | Click **Prove it — withdraw as the revoked holder** | ~20s → *"inv5 just took the money out."* The withdrawal is a real testnet transaction, by a holder whose credential is already revoked. This is the gap, spent rather than described |
| 4 | Click **Sync policy** | ~15s → the row turns `frozen`, the link closes to `───`, and the **Prove it** button disappears: there is no gap left to prove. Off screen, the same withdrawal is now refused — *"user note key exists in non-membership tree"*, recorded in the [reference run](ARCHITECTURE.md#reference-run) |

**Steps 2 and 3 are why this project exists.** A permissioned token and a confidential rail each enforce their own policy perfectly well, and neither knows about the other. Revoking a credential does nothing to money already inside the rail — an issuer who revokes a holder has revoked nothing where it matters. The bridge is what makes the second follow the first.

And the freeze reaches backwards: because the pool checks proofs against the current association roots, a blocklisted holder cannot spend *anything*, including coupons received before the revocation. Re-credentialing lifts it.

---

## Act 3 — Proving one payment, and nothing else

*The objection: "if we cannot see the payments, how does anyone audit this?"*

This is the part that makes confidentiality acceptable rather than suspicious. Hiding payments is easy; the hard part is being able to prove one when someone with the right to ask, asks.

| # | Do this | What happens |
|---|---|---|
| 1 | **Investor** tab, pick `inv2` | Their coupon appears, decrypted |
| 2 | Under **Disclose a payment to an auditor**, select the note | The button enables |
| 3 | Click **Generate receipt** | **~13s** — a zero-knowledge proof is being built. A receipt appears as JSON |
| 4 | Click **Send to the auditor tab** | Jumps to the Auditor tab with the receipt pasted in |
| 5 | Click **Verify** | **~13s** → **Verified**, four checks green |
| 6 | Read the Disclosed panel | Amount and possession marked **proven**; the coupon reference and authority marked **attested** |
| 7 | Click **Tamper with it**, then **Verify** again | ~13s → **Refused**, with `Proof: no` and the other three still `yes` |

**What the auditor is for.** They hold no special position — no key, no privileged access, no ability to look around. They can verify only what someone chose to hand them, and that receipt says nothing about any other payment, this holder's balance, or who else was paid in the same cycle. That is what makes the confidentiality legitimate: it is not opacity, it is disclosure the holder controls and an auditor can check.

**Why step 6 matters.** The interface distinguishes what mathematics proves from what a person asserts. The amount is proven. The label *"coupon 2026-H2"* is attested — tamper-evident, but true only because whoever wrote it says so. Overclaiming here is how a system loses a technical audience.

**Why step 7 matters.** The claimed amount was raised by one digit, and the verdict flips — while the other three checks still pass, so you can see exactly which guarantee broke. The proof binds the exact statement: a receipt cannot claim more than was paid. The refusal is as much the demonstration as the success.

---

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| *"failed to load prover: operation timed out"*, on the first load | Cold start: storage rebuilds note state from the chain while the prover compiles 21 MB of wasm, and together they exceed the SDK's 30s budget | **Reload.** The second load finds both warm and starts clean |
| *"Another tab has this demo open"* | The confidential payment SDK keeps one exclusive local database | Close the other tab, reload |
| The investor shows coupons from earlier runs | Note state is rebuilt from the chain, so `reset.sh` spends those coupons rather than erasing them — clearing site data brings them straight back | Expected, and they read `spent`. A genuinely empty history needs a fresh deployment |
| *"no combination of notes reaches the goal amount"* | The transfer circuit spends **two** input notes. A treasury holding 700 XLM as seven 100 XLM notes still cannot pay a 287 XLM coupon — the two largest it may spend reach 200. Deposits cap at 100 XLM, so funding alone never fixes it | Re-run `reset.sh`: it merges the float into one note after sweeping. If it is genuinely short, `spp deposit` first, then reset |
| A payment fails midway | Usually the treasury ran out of pool funding | Check the balance the reset prints; top up with `spp deposit` (100 XLM per deposit), then re-run `reset.sh` to merge the new notes |
| *"Not yet enrolled in the allow-list"* | The holder was never synced | Click **Sync policy** |
| Nothing happens for 15 seconds | Normal — a proof is being computed | Wait. The progress line names the stage |

## Resetting between runs

```bash
./scripts/reset.sh
```

Restores revoked credentials, syncs policy, and sweeps coupons back to the treasury — in that order, because syncing after a proof is built invalidates it. Then clear site data in the browser; the script cannot reach the browser's own copy of the wallet.

Sweeping spends the coupons, it does not erase them, and no browser-side reset will: they are on-chain history for that holder. A run that starts from an empty ledger of payments needs a fresh deployment, not a fresh browser.

## Demo configuration, declared

The browser signs with **local seed keys**, not a wallet extension — a recorded demo cannot afford an extension popup per payment and an account switch per role. The signer is a plain object satisfying the SDK's three-method interface ([app/js/local-signer.js](../app/js/local-signer.js)); `app/tools/key-gate.mjs` proves it derives the same keys the CLI does.

Editing the registry and moving the allow-list and blocklist need the issuer's admin key and the Stellar CLI, so they run in [app/server.mjs](../app/server.mjs) rather than the page. In a real deployment that is the securitiser's internal service.

The three roles share one page because they must: the payment SDK's storage holds an exclusive OPFS lock, and a second tab evicts the first. The wallet is a second page for the same reason it is not a second tab — [app/js/sdk-facade.js](../app/js/sdk-facade.js) claims a Web Lock before opening storage, so whichever page loads second says so in about two seconds rather than hanging for thirty with the cause visible only in the console. Verification is exempt by construction: it never opens storage, so the blocked page can still check a receipt produced by the other one.
