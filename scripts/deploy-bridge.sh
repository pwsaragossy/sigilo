#!/usr/bin/env bash
# Deploys the PolicyBridge and hands it the association sets.
#
# The second half is what gives the contract its meaning. Until the trees name the
# bridge as their admin, the operator can still reach them directly and every
# guarantee the contract makes is decorative — it would be a suggestion, not a rule.
#
# After this runs, the operator has no way into the association sets except through
# the contract, and the contract asks the register first. That is the whole point:
# a key that can no longer be misused, because the chain will not let it.
#
# usage: ./scripts/deploy-bridge.sh

set -euo pipefail

die() { echo "deploy-bridge: $*" >&2; exit 1; }
step() { echo; echo "==> $*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.demo-state"

command -v stellar >/dev/null || die "missing the stellar CLI"
command -v jq >/dev/null || die "missing 'jq'"
[[ -f "$STATE/rwa.json" ]]  || die "run scripts/deploy-rwa.sh first"
[[ -f "$STATE/rail.json" ]] || die "the confidential rail must be deployed first"

export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

OPERATOR=$(stellar keys address sigilo-admin)
VERIFIER=$(jq -r '.identity.verifier' "$STATE/rwa.json")
ALLOWLIST=$(jq -r '.asp_membership' "$STATE/rail.json")
BLOCKLIST=$(jq -r '.asp_non_membership' "$STATE/rail.json")

step "building the contract"
( cd "$ROOT/contracts/policy-bridge" && stellar contract build --out-dir "$STATE/wasm" >/dev/null 2>&1 )
WASM="$STATE/wasm/policy_bridge.wasm"
[[ -f "$WASM" ]] || die "build produced no wasm"
echo "  $(du -h "$WASM" | cut -f1)"

step "deploying"
BRIDGE=$(stellar contract deploy "${NET[@]}" --source sigilo-admin --wasm "$WASM" \
  -- --operator "$OPERATOR" --verifier "$VERIFIER" \
     --allowlist "$ALLOWLIST" --blocklist "$BLOCKLIST" 2>&1 \
  | grep -oE '^C[A-Z0-9]{55}' | tail -1)
[[ -n "$BRIDGE" ]] || die "deployment produced no contract id"
echo "  $BRIDGE"

step "handing over the association sets"
for tree in "$ALLOWLIST" "$BLOCKLIST"; do
  printf '  %s… ' "${tree:0:12}"
  if stellar contract invoke "${NET[@]}" --id "$tree" --source sigilo-admin \
       -- update_admin --new_admin "$BRIDGE" >/dev/null 2>&1; then
    echo "done"
  else
    echo "failed — the operator may already have handed it over"
  fi
done

tmp=$(mktemp)
jq --arg b "$BRIDGE" '.policyBridge = $b' "$STATE/rwa.json" > "$tmp" && mv "$tmp" "$STATE/rwa.json"

step "checking the operator is locked out"
if stellar contract invoke "${NET[@]}" --id "$ALLOWLIST" --source sigilo-admin \
     -- insert_leaf --leaf 1 >/dev/null 2>&1; then
  echo "  ⚠ the operator can still write to the allowlist directly — the handover did not take"
else
  echo "  the operator cannot reach the trees; only the contract can"
fi

echo
echo "PolicyBridge: $BRIDGE"
