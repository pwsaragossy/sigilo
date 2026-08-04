# Video captions

The video has no narration, so these carry the explanation. Each one says what is on
screen and, more importantly, **why the step matters** — a judge watching without sound
needs the argument, not a description.

Timings are filled in from the actual frame counts at montage time; this file is the
text, kept separate so a sentence can be fixed without re-recording anything.

---

## Opening

> **Sigilo** — confidential coupon payments for tokenized private credit.

> On a public ledger, every coupon an issuer pays is a published treasury statement.
> Who was paid, when, how much. Institutions raise this first.

---

## Act 1 — The token refuses

> **Act 1.** A permissioned receivable note. Five investors, each with a KYC credential
> in an identity register.

> The issuer issues 100 tokens to a credentialed holder. Accepted.

> Now the issuer revokes that holder's credential — in the register only.

> Note what the row says: credential **revoked**, rail still **allowed**.
> *Out of step.* Hold that thought; Act 2 returns to it.

> The same issue, to the same holder. **Refused by the token** — the registry knows this
> address, but its claims no longer verify.

> Nothing reached the ledger. The contract refused during simulation. This is the token
> enforcing its own policy, not an interface declining on its behalf.

---

## Act 2 — The payment nobody can read

> **Act 2.** A coupon cycle. Five holders, five amounts — none proportional to the
> positions, because each accrues from that holder's own entry date.

> Positions are public. If coupons were proportional, one disclosed payment would give
> away all the others.

> Paying. Five confidential payments, each with its own zero-knowledge proof.
> This is real computation — about nine seconds per payment.

> Paid. Now look at any of these transactions on the explorer: an `invoke_host_function`
> call, and no amount anywhere in it.

> The recipient's side. The same number the issuer computed, recovered from the note's
> ciphertext with this holder's key.

> Left: what anyone can see — address, position, entry date. A securities register should
> be legible to a regulator. Right: what only this holder can see.
> **The position was never secret. The payment always was.**

### The bridge

> Back to the issuer. Revoke another holder's credential.

> **Here is the gap.** The credential is gone from the register. The rail has not been
> told. Right now this holder can still spend the coupon they already hold.

> A permissioned token and a confidential rail each enforce policy correctly, and neither
> knows about the other. Revoking a credential does nothing to money already inside the rail.

> **Sync compliance policy.** The association sets now follow the register.

> Frozen — and retroactively: the pool checks proofs against current roots, so coupons
> received *before* the revocation are locked too. Re-credentialing lifts it.

> That bridge is what this project adds. The pool and the token are open source, from
> Nethermind and OpenZeppelin. Making one follow the other is not.

---

## Act 3 — Proving one payment, and nothing else

> **Act 3.** Hiding payments is easy. The hard part is proving one when someone with the
> right to ask, asks.

> The holder selects a single coupon and generates a zero-knowledge proof of it.

> The auditor verifies. No wallet, no stored keys, no privileged access — only the receipt
> they were handed.

> **Verified.** Four checks: the proof itself, the context binding, the payment's presence
> in the pool, and whether the note was later spent.

> Amount and possession are **proven**. The coupon reference is **attested** —
> tamper-evident, but true because the prover says so. The interface does not blur that line.

> This receipt says nothing about any other payment, this holder's balance, or who else was
> paid in the same cycle.

> Now change one digit of the proof.

> **Refused** — and only the proof check fails. The other three still pass, so you can see
> exactly which guarantee broke.

---

## Close

> Permissioned asset. Confidential payments. One identity policy governing both.
> Selective disclosure the holder controls and an auditor can check.

> Everything shown ran against Stellar testnet. Transaction hashes are in the repository.

> **github.com/pwsaragossy/sigilo**
