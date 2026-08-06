# Vendored: stellar-private-payments web SDK

This is a **rebuild from source**, not the published npm package.

## Why it is vendored

The SDK embeds its deployment configuration at compile time — `sdk/web/src/lib.rs`
does `include_str!(".../deployments/testnet/deployments.json")`, and `Client.new`
accepts no deployment override. The published
[`stellar-private-payments@0.1.0-alpha.1`](https://www.npmjs.com/package/stellar-private-payments)
package therefore points at Nethermind's own testnet contracts, whose association-set
registries are admin-gated by their deployer and cannot be operated by anyone else.

Sigilo needs to grant and revoke credentials on its *own* association sets, so it runs
its own instance — which means the SDK has to be rebuilt against it.

Verified: `stellar_private_payments_sdk_web_bg.wasm` contains our pool
(`CCSA2A6HIDEZKR5LND5JD3AYF4ER6YL43H4VNOCWQ6MJGHSIRGK7VWQH`) and no reference to the
reference deployment. Check it with `strings … | grep -oE 'C[A-Z0-9]{55}'` — a text
grep of the directory will not find these, which is how a stale build went unnoticed
once already: the SDK proved against the previous association roots while the pool
checked the current ones, and every spend failed with `InvalidProof`.

## Provenance

| | |
|---|---|
| Source | [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) @ `461c1d0` |
| License | Apache-2.0 (see `dist/LICENSE.txt` and `dist/licenses/`) |
| Built with | `wasm-bindgen-cli` 0.2.126, binaryen 131, Rust 1.97.1 |
| Deployment | Sigilo testnet instance, ledger 4003050 |

## Rebuilding

```bash
git clone https://github.com/NethermindEth/stellar-private-payments
cd stellar-private-payments && git checkout 461c1d0

# Point deployments/testnet/deployments.json at your own instance
# (deployments/scripts/deploy.sh writes it for you)

cargo install wasm-bindgen-cli --version 0.2.126 --locked

# macOS: Apple clang has no wasm backend, and the SDK compiles SQLite to wasm.
# Not mentioned in their contributing guide — this is the fix:
brew install llvm
export CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang
export AR_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/llvm-ar

bash sdk/web/scripts/build.sh   # → sdk/web/dist/
```

## Size

68 MB, dominated by the prover worker (21 MB) and the Groth16 circuit artifacts
(43 MB: r1cs, witness wasm, proving keys). Only the `AB` policy variant and the
selective-disclosure circuits are actually exercised by Sigilo; the rest could be
pruned, but the SDK hashes its artifact set at build time, so pruning is left alone
rather than risking a silent runtime mismatch.
