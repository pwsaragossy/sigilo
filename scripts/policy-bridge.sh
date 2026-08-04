#!/usr/bin/env bash
# Sigilo policy bridge — derives confidential-rail policy from the token's identity registry.
#
# The permissioned token and the confidential rail each enforce policy, but they
# do not share a source of truth on their own: the token asks an ERC-3643 identity
# verifier, while the rail proves membership against association-set trees whose
# leaves someone has to insert. This bridge makes the second follow the first.
#
#   verify_identity(holder) passes  →  holder is in the allowlist, absent from the blocklist
#   verify_identity(holder) fails   →  holder is in the blocklist  (spending freezes)
#
# Revocation is retroactive: the pool checks proofs against the *current* association
# roots, so a blocklisted holder cannot spend notes they already received. Re-granting
# the credential lifts the freeze.
#
# usage:
#   ./scripts/policy-bridge.sh enroll   # onboard holders onto the rail, record their keys
#   ./scripts/policy-bridge.sh sync     # reconcile association sets against the registry
#   ./scripts/policy-bridge.sh status   # what the bridge believes, per holder

set -euo pipefail

die() { echo "policy-bridge: $*" >&2; exit 1; }
step() { echo; echo "==> $*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.demo-state"
RWA_STATE="$STATE_DIR/rwa.json"
RAIL_STATE="$STATE_DIR/rail.json"
POLICY_STATE="$STATE_DIR/policy.json"

: "${SPP_REPO:?set SPP_REPO to a clone of NethermindEth/stellar-private-payments (pinned at 461c1d0)}"
[[ -f "$RWA_STATE" ]]  || die "missing $RWA_STATE — run scripts/deploy-rwa.sh first"
[[ -f "$RAIL_STATE" ]] || die "missing $RAIL_STATE — deploy the confidential rail first"

command -v jq >/dev/null || die "missing 'jq'"

export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

VERIFIER=$(jq -r '.identity.verifier' "$RWA_STATE")
ADMIN=sigilo-admin
ASP_ALLOW=$(jq -r '.asp_membership' "$RAIL_STATE")
ASP_BLOCK=$(jq -r '.asp_non_membership' "$RAIL_STATE")
POOL=$(jq -r '.pools[0].poolContractId' "$RAIL_STATE")

SPP_CLI="$SPP_REPO/target/release/spp"
CIRCUITS="$SPP_REPO/target/circuits-artifacts/release"
[[ -x "$SPP_CLI" ]] || die "build the rail CLI first: cargo build --release -p stellar-private-payments-cli"

[[ -f "$POLICY_STATE" ]] || echo '{}' > "$POLICY_STATE"

# ---------------------------------------------------------------------------
# Leaf derivation. Staged into the rail workspace because it needs that crate's
# Poseidon2; see tools/asp-leaf/main.rs.
# ---------------------------------------------------------------------------
asp_leaf() {  # asp_leaf <note_pubkey_hex> <asp_secret_hex>
  local ex="$SPP_REPO/sdk/prover/examples/sigilo_asp_leaf.rs"
  [[ -f "$ex" ]] || cp "$ROOT/tools/asp-leaf/main.rs" "$ex"
  ( cd "$SPP_REPO" && cargo run -q -p prover --release --example sigilo_asp_leaf -- "$1" "$2" 2>/dev/null )
}

# A note public key is little-endian; read big-endian it exceeds the BN254 prime
# and the contract traps with UnreachableCodeReached rather than a typed error.
note_key_decimal() {
  python3 -c "import sys;print(int.from_bytes(bytes.fromhex(sys.argv[1].removeprefix('0x')),'little'))" "$1"
}

# ---------------------------------------------------------------------------
# The registry is the authority. `verify_identity` traps unless the account has
# every required claim from a trusted issuer, so simulating it is the question
# "does this holder still hold a valid credential?".
# ---------------------------------------------------------------------------
is_credentialed() {  # is_credentialed <stellar account alias>
  stellar contract invoke "${NET[@]}" --id "$VERIFIER" --source "$ADMIN" --send=no \
    -- verify_identity --account "$1" >/dev/null 2>&1
}

is_blocklisted() {  # is_blocklisted <note_key_decimal>
  local found
  found=$(stellar contract invoke "${NET[@]}" --id "$ASP_BLOCK" --source "$ADMIN" --send=no \
    -- find_key --key "$1" 2>/dev/null || echo "")
  [[ "$found" == *'"found":true'* || "$found" == *"Found"* ]]
}

policy_get() { jq -r --arg k "$1" --arg f "$2" '.[$k][$f] // empty' "$POLICY_STATE"; }
policy_set() {  # policy_set <holder> <field> <value>
  local tmp; tmp=$(mktemp)
  jq --arg k "$1" --arg f "$2" --arg v "$3" '.[$k] = ((.[$k] // {}) + {($f): $v})' "$POLICY_STATE" > "$tmp"
  mv "$tmp" "$POLICY_STATE"
}

# ---------------------------------------------------------------------------
# enroll — put each holder on the rail and record the keys the bridge needs.
#
# The allowlist leaf commits to the holder's ASP secret, which is theirs, not the
# issuer's. Handing it over is what enrolment *means*: the holder consents to being
# identifiable to the policy operator. Done here through the CLI's local state
# because this is a demo; a real deployment collects it during onboarding.
# ---------------------------------------------------------------------------
cmd_enroll() {
  step "enrolling holders onto the confidential rail"
  for name in $(jq -r '.holders[].name' "$RWA_STATE"); do
    local alias="sigilo-$name" data_dir="$STATE_DIR/rail-$name"

    if [[ -z "$(policy_get "$name" note_key)" ]]; then
      "$SPP_CLI" --deployment "$RAIL_STATE" --network testnet --circuits-dir "$CIRCUITS" \
        --data-dir "$data_dir" --account "$alias" onboard --accept --register --no-bootnode \
        >/dev/null 2>&1 || die "rail onboarding failed for $name"

      local keys note secret
      keys=$("$SPP_CLI" --deployment "$RAIL_STATE" --network testnet --data-dir "$data_dir" \
        --account "$alias" keys --json 2>/dev/null)
      note=$(jq -r '.note_public_key' <<<"$keys")
      secret=$("$SPP_CLI" --deployment "$RAIL_STATE" --network testnet --data-dir "$data_dir" \
        --account "$alias" asp-secret --json 2>/dev/null | jq -r '.asp_secret')

      policy_set "$name" note_key "$note"
      policy_set "$name" asp_secret "$secret"
      policy_set "$name" leaf "$(asp_leaf "$note" "$secret")"
      policy_set "$name" allowlisted false
    fi
    echo "  $name enrolled"
  done
}

# ---------------------------------------------------------------------------
# sync — the bridge proper. Ask the registry, then move the association sets.
# ---------------------------------------------------------------------------
cmd_sync() {
  step "syncing association sets against the identity registry"
  local changes=0

  for name in $(jq -r '.holders[].name' "$RWA_STATE"); do
    local alias="sigilo-$name"
    local leaf note_dec
    leaf=$(policy_get "$name" leaf)
    [[ -n "$leaf" ]] || die "$name is not enrolled — run 'enroll' first"
    note_dec=$(note_key_decimal "$(policy_get "$name" note_key)")

    if is_credentialed "$alias"; then
      # Credential is valid: ensure allowlisted, and lift any freeze.
      if [[ "$(policy_get "$name" allowlisted)" != "true" ]]; then
        # The allowlist tree is append-only and offers no membership query, so a
        # re-insert is the only way to find out it was already there. Treat that
        # as success: the invariant we want is "leaf is present", not "we put it
        # there this run".
        if stellar contract invoke "${NET[@]}" --id "$ASP_ALLOW" --source "$ADMIN" \
             -- insert_leaf --leaf "$leaf" >/dev/null 2>&1; then
          echo "  $name: credential valid → added to allowlist"
        else
          echo "  $name: credential valid → already in allowlist"
        fi
        policy_set "$name" allowlisted true
        changes=$((changes + 1))
      fi
      if is_blocklisted "$note_dec"; then
        stellar contract invoke "${NET[@]}" --id "$ASP_BLOCK" --source "$ADMIN" \
          -- delete_leaf --key "$note_dec" >/dev/null 2>&1
        policy_set "$name" blocked false
        echo "  $name: credential restored → unfrozen"
        changes=$((changes + 1))
      fi
    else
      # No valid credential: freeze. The allowlist tree is append-only, so the
      # blocklist is the only lever — and it is the stronger one, since the pool
      # rejects proofs against a stale root.
      if ! is_blocklisted "$note_dec"; then
        stellar contract invoke "${NET[@]}" --id "$ASP_BLOCK" --source "$ADMIN" \
          -- insert_leaf --key "$note_dec" --value 1 >/dev/null 2>&1
        policy_set "$name" blocked true
        echo "  $name: credential absent → blocklisted (pool balance frozen)"
        changes=$((changes + 1))
      fi
    fi
  done

  if (( changes == 0 )); then
    echo "  association sets already match the registry"
  else
    echo
    echo "  $changes change(s) applied — in-flight proofs built against the previous"
    echo "  roots are now invalid and must be regenerated."
  fi
}

cmd_status() {
  step "policy state"
  printf '  %-6s %-12s %-11s %s\n' HOLDER CREDENTIAL ALLOWLIST BLOCKLIST
  for name in $(jq -r '.holders[].name' "$RWA_STATE"); do
    local cred="no" block="no"
    is_credentialed "sigilo-$name" && cred="yes"
    is_blocklisted "$(note_key_decimal "$(policy_get "$name" note_key)")" && block="yes"
    printf '  %-6s %-12s %-11s %s\n' "$name" "$cred" \
      "$(policy_get "$name" allowlisted)" "$block"
  done
  echo
  echo "  pool: $POOL"
}

case "${1:-}" in
  enroll) cmd_enroll ;;
  sync)   cmd_sync ;;
  status) cmd_status ;;
  *) die "usage: policy-bridge.sh {enroll|sync|status}" ;;
esac
