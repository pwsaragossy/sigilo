# Sigilo

**Confidential coupon rail for tokenized private credit on Stellar.**

An issuer tokenizes a receivable as a permissioned asset (ERC-3643 / T-REX standard), pays investor coupons through a confidential rail where payment transactions do not expose amounts, and auditors receive cryptographic selective disclosure of specific payments. One identity policy governs both sides: the same KYC credential that authorizes holding the token authorizes operating in the confidential rail.

> ⚠️ **Work in progress** — built for the [Stellar Builder Summit SP 26](https://bounties.grantfox.xyz/events/stellar-summit-sp-2026) (Enterprise, Compliance & RWA sub-lane), Aug 3–6 2026. Testnet only. Built on unaudited alpha dependencies. Do not use with real value.

## Status

- [ ] D1 — Stack gate (own privacy-pool instance on testnet) + permissioned token contracts
- [ ] D2 — Confidential coupon cycle + selective disclosure
- [ ] D3 — Demo UI (Issuer / Investor / Auditor) + reference run
- [ ] D4 — Video + submission

Architecture, threat model, and reproduction instructions land here as the build progresses.

## Built on

| Dependency | Commit | License |
|---|---|---|
| [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) (privacy pool, Groth16/BN254, selective disclosure) | `461c1d0` | Apache-2.0 |
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) (RWA / ERC-3643 suite) | `9b5ed96` | Apache-2.0 |

What is original here: the policy bridge between the ERC-3643 identity registry and the privacy pool's association sets (grant → allowlist, revoke → blocklist ⇒ retroactive on-chain spend freeze with re-credentialing as the exit path), the coupon cycle service, and the three-role demo application. See NOTICE.
