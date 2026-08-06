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

# Who administers a tree, read from the chain.
#
# The trees expose no `admin()` getter, so this reads `DataKey::Admin` out of
# persistent storage directly. A unit variant of a `#[contracttype]` enum encodes
# as a one-element vec rather than a bare symbol, which is why the key is built
# with `xdr encode` instead of passed to `--key`.
ADMIN_KEY=$(printf '{"vec":[{"symbol":"Admin"}]}' | stellar xdr encode --type ScVal --output single-base64)

# The trailing `|| true` is load-bearing: under `pipefail` a grep that matches
# nothing fails the pipeline, and the caller's `current=$(tree_admin …)` would
# then abort the script through `set -e` before it could say why.
# `[CG]`, not `C`: before the handover the admin is the operator's *account*
# (G…), and only afterwards a contract (C…). Matching contracts alone made this
# return empty on a freshly deployed tree, which the caller then reported as
# "cannot read the admin" — right refusal, wrong reason.
tree_admin() {  # tree_admin <tree_id> → C… / G… , or empty if unreadable
  stellar contract read "${NET[@]}" --id "$1" --durability persistent \
    --key-xdr "$ADMIN_KEY" 2>/dev/null | grep -oE '[CG][A-Z0-9]{55}' | head -1 || true
}

# Checked before anything is deployed, because handing the trees over is the only
# step that cannot be retried. Once a bridge owns them nothing can take them back:
# the contract has no `update_admin` passthrough, and that missing door is exactly
# what makes the gate non-circumventable. The price is that replacing the bridge
# means replacing the trees.
step "checking the association sets can still be handed over"
for tree in "$ALLOWLIST" "$BLOCKLIST"; do
  current=$(tree_admin "$tree")
  printf '  %s… admin %s\n' "${tree:0:12}" "${current:-unreadable}"
  [[ -n "$current" ]] || die "cannot read the admin of $tree — refusing to deploy blind"
  [[ "$current" == "$OPERATOR" ]] || die "$tree is administered by $current, not the operator.
  A previous bridge already owns it and cannot give it back. Deploy new association
  sets and re-run this script against them; deploying another bridge now would
  produce one that administers nothing."
done

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
    # Fatal, and it did not used to be. This printed "the operator may already
    # have handed it over" and carried on, which left rwa.json pointing at a
    # bridge that administers nothing and every grant trapping on insert_leaf.
    echo "FAILED"
    die "could not hand $tree to $BRIDGE. That bridge is now deployed but powerless;
  do not record it. The trees still answer to their previous admin."
  fi
done

step "verifying the handover"
for tree in "$ALLOWLIST" "$BLOCKLIST"; do
  current=$(tree_admin "$tree")
  printf '  %s… admin %s\n' "${tree:0:12}" "${current:-unreadable}"
  [[ "$current" == "$BRIDGE" ]] || die "$tree names $current as admin, not the bridge just deployed."
done
# Asserting *who* the admin is, rather than that the operator is refused. The old
# check invoked insert_leaf as the operator and read a refusal as proof — but a
# refusal is equally consistent with some earlier bridge owning the trees, so it
# passed in exactly the case it existed to catch. It also wrote a junk leaf into
# the allowlist whenever the handover had in fact failed.
echo "  the operator cannot reach the trees; only this bridge can"

tmp=$(mktemp)
jq --arg b "$BRIDGE" '.policyBridge = $b' "$STATE/rwa.json" > "$tmp" && mv "$tmp" "$STATE/rwa.json"

echo
echo "PolicyBridge: $BRIDGE"
