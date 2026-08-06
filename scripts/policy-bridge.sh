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

# The PolicyBridge contract owns the association sets. This script can no longer
# touch them: it proposes, and the contract decides, re-checking the register
# itself before it moves anything.
BRIDGE=$(jq -r '.policyBridge // empty' "$RWA_STATE")
[[ -n "$BRIDGE" ]] || die "no policyBridge in .demo-state/rwa.json — deploy it with scripts/deploy-bridge.sh"

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
# Answers yes / no / unreachable, because those are three different things and
# collapsing the last two is how a network blip became a revocation. A genuine
# refusal traps with a typed contract error; a flat RPC says "client error" and
# names no contract at all. Reading the second as "not credentialed" made status
# report holders as revoked while their claims sat untouched on-chain — and, worse,
# had sync propose a freeze against someone in good standing. The contract refuses
# that (StillCredentialed), so nothing was ever mis-frozen; the report lied anyway.
credential_state() {  # credential_state <alias> → yes | no | unreachable
  local out attempt=1
  while (( attempt <= 3 )); do
    if out=$(stellar contract invoke "${NET[@]}" --id "$VERIFIER" --source "$ADMIN" --send=no \
               -- verify_identity --account "$1" 2>&1); then
      echo yes; return 0
    fi
    # A typed contract error is the register answering. Anything else is noise.
    if grep -qE 'Error\(Contract, #[0-9]+\)' <<<"$out"; then
      echo no; return 0
    fi
    attempt=$((attempt + 1))
  done
  echo unreachable
}

is_credentialed() {  # is_credentialed <alias> — true only on a definite yes
  [[ "$(credential_state "$1")" == yes ]]
}


# Asks the contract to act.
#
# The contract owns the association sets, so this is the only way in — and it
# re-checks the register before touching anything. A wrong proposal here is
# refused on-chain rather than quietly applied, which is the difference between
# this script being trusted and being merely convenient.
#
# Sets BRIDGE_ERR to the contract's own words on failure. Swallowing that was a
# bug worth naming: the caller then recorded a freeze that never happened, and
# every layer above repeated it. A refusal here is information — #3
# StillCredentialed means the register disagrees, and that is the whole point.
bridge_call() {  # bridge_call <grant|revoke|restore> <args...>
  local action="$1"; shift
  local out
  if out=$(stellar contract invoke "${NET[@]}" --id "$BRIDGE" --source "$ADMIN" -- "$action" "$@" 2>&1); then
    BRIDGE_ERR=""
    return 0
  fi
  BRIDGE_ERR=$(sed -n 's/.*error: //p' <<<"$out" | head -1)
  [[ -n "$BRIDGE_ERR" ]] || BRIDGE_ERR=$(tail -1 <<<"$out")
  return 1
}

is_blocklisted() {  # is_blocklisted <note_key_decimal>
  local found
  found=$(stellar contract invoke "${NET[@]}" --id "$ASP_BLOCK" --source "$ADMIN" --send=no \
    -- find_key --key "$1" 2>/dev/null || echo "")
  [[ "$found" == *'"found":true'* || "$found" == *"Found"* ]]
}

# Does the bridge hold an enrolment for this holder?
#
# Asked of the chain, never of policy.json. The local `allowlisted` flag outlives
# a redeploy and the contract's storage does not, so a fresh bridge starts with no
# enrolments while every holder still reads as allowlisted locally. Gating the
# grant on the flag would then skip the one call that writes the binding, and
# every later freeze would fail with NotEnrolled (#4) against a bridge that had
# never heard of the holder. The flag is a display cache; this is the truth.
#
# A transient RPC failure answers "no" here, which costs a redundant grant — and
# re-granting the same pair is defined to be harmless, so that is the safe way to
# be wrong.
is_enrolled() {  # is_enrolled <holder_address>
  stellar contract invoke "${NET[@]}" --id "$BRIDGE" --source "$ADMIN" --send=no \
    -- enrolment --holder "$1" >/dev/null 2>&1
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
  local changes=0 failures=0

  for name in $(jq -r '.holders[].name' "$RWA_STATE"); do
    local alias="sigilo-$name"
    local leaf note_dec
    leaf=$(policy_get "$name" leaf)
    [[ -n "$leaf" ]] || die "$name is not enrolled — run 'enroll' first"
    note_dec=$(note_key_decimal "$(policy_get "$name" note_key)")

    local holder
    holder=$(jq -r --arg n "$name" '.holders[]|select(.name==$n)|.address' "$RWA_STATE")

    local state
    state=$(credential_state "$alias")
    if [[ "$state" == unreachable ]]; then
      # Never propose a freeze on a register we could not reach. The contract
      # would refuse it anyway; proposing it at all is the bug.
      echo "  $name: SKIPPED — could not read the identity register"
      failures=$((failures + 1))
      continue
    fi

    if [[ "$state" == yes ]]; then
      # Credential is valid: ensure enrolled, and lift any freeze.
      #
      # `grant` records the leaf *and* the note key, and that binding is what
      # `revoke` later acts on — so this is no longer only "put the leaf in the
      # tree", it is the step that decides which key a freeze may ever touch.
      if ! is_enrolled "$holder"; then
        if bridge_call grant --holder "$holder" --leaf "$leaf" --note_key "$note_dec"; then
          policy_set "$name" allowlisted true
          echo "  $name: credential valid → enrolled, added to allowlist"
          changes=$((changes + 1))
        else
          # Previously any failure here was reported as "already in allowlist",
          # which turned an RPC blip into a false record of success.
          policy_set "$name" allowlisted false
          echo "  $name: FAILED to enrol — $BRIDGE_ERR"
          failures=$((failures + 1))
        fi
      elif [[ "$(policy_get "$name" allowlisted)" != "true" ]]; then
        policy_set "$name" allowlisted true
      fi
      if is_blocklisted "$note_dec"; then
        if bridge_call restore --holder "$holder"; then
          policy_set "$name" blocked false
          echo "  $name: credential restored → unfrozen"
          changes=$((changes + 1))
        else
          echo "  $name: FAILED to unfreeze — $BRIDGE_ERR"
          failures=$((failures + 1))
        fi
      fi
    else
      # No valid credential: freeze. The allowlist tree is append-only, so the
      # blocklist is the only lever — and it is the stronger one, since the pool
      # rejects proofs against a stale root.
      if ! is_blocklisted "$note_dec"; then
        if bridge_call revoke --holder "$holder"; then
          policy_set "$name" blocked true
          echo "  $name: credential absent → blocklisted (pool balance frozen)"
          changes=$((changes + 1))
        else
          echo "  $name: FAILED to freeze — $BRIDGE_ERR"
          failures=$((failures + 1))
        fi
      fi
    fi
  done

  if (( failures > 0 )); then
    echo
    echo "  $failures holder(s) did NOT sync — the association sets still disagree"
    echo "  with the registry for them. Re-run sync; the lines above say why."
  fi

  if (( changes == 0 && failures == 0 )); then
    echo "  association sets already match the registry"
  elif (( changes > 0 )); then
    echo
    echo "  $changes change(s) applied — in-flight proofs built against the previous"
    echo "  roots are now invalid and must be regenerated."
  fi
}

cmd_status() {
  step "policy state"
  printf '  %-6s %-12s %-11s %s\n' HOLDER CREDENTIAL ENROLLED BLOCKLIST
  for name in $(jq -r '.holders[].name' "$RWA_STATE"); do
    # Every column is read from the chain. The one that used to come from
    # policy.json reported holders as enrolled on a bridge that had never
    # heard of them, because the local flag outlives the contract's storage.
    # `true`/`false` rather than yes/no: app/server.mjs parses this column with
    # a fixed regex, and this is the shape it already expected.
    local cred block="no" enrolled="false" holder
    holder=$(jq -r --arg n "$name" '.holders[]|select(.name==$n)|.address' "$RWA_STATE")
    cred=$(credential_state "sigilo-$name")
    [[ "$cred" == unreachable ]] && cred="?"
    is_enrolled "$holder" && enrolled="true"
    is_blocklisted "$(note_key_decimal "$(policy_get "$name" note_key)")" && block="yes"
    printf '  %-6s %-12s %-11s %s\n' "$name" "$cred" "$enrolled" "$block"
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
