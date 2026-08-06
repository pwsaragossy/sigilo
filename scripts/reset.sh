#!/usr/bin/env bash
# Returns the demo to its opening state, so a take can be re-recorded.
#
# Three things drift over a run: credentials get revoked, the association sets
# follow them, and — the one that is easy to miss — coupons accumulate in
# investor wallets. A holder who was paid in three takes shows three payments in
# the fourth, while the narration says one. So the notes are swept back to the
# treasury rather than left to pile up.
#
# Order matters. Credentials are restored and synced *before* any note is moved,
# because the pool checks proofs against the current association roots: syncing
# after a proof is generated invalidates it.
#
# usage: ./scripts/reset.sh [--keep-notes]

set -euo pipefail

die() { echo "reset: $*" >&2; exit 1; }
step() { echo; echo "==> $*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.demo-state"
KEEP_NOTES=0
[[ "${1:-}" == "--keep-notes" ]] && KEEP_NOTES=1

: "${SPP_REPO:?set SPP_REPO to the stellar-private-payments clone}"
: "${OZ_REPO:?set OZ_REPO to the stellar-contracts clone (needed to re-issue claims)}"
[[ -f "$STATE/rwa.json" ]] || die "no deployment — run scripts/deploy-rwa.sh first"
command -v jq >/dev/null || die "missing 'jq'"

SPP_CLI="$SPP_REPO/target/release/spp"
CIRCUITS="$SPP_REPO/target/circuits-artifacts/release"
RAIL="$STATE/rail.json"
POOL=$(jq -r '.pools[0].poolContractId' "$RAIL")
TREASURY=$(jq -r '.treasury' "$STATE/rwa.json")

spp() {  # spp <data-dir> <account> <args...>
  local dir="$1" account="$2"; shift 2
  "$SPP_CLI" --deployment "$RAIL" --network testnet --circuits-dir "$CIRCUITS" \
    --data-dir "$dir" --account "$account" "$@" 2>&1
}

pool_balance() {  # pool_balance <data-dir> <account> → decimal, or empty
  spp "$1" "$2" overview "$POOL" | awk '/^ *balance:/ {print $2; exit}' | tr -d '\n'
}

# A wallet that has never been onboarded refuses every command. Note state is
# rebuilt from the chain, so doing this is cheap and safe to repeat.
ensure_onboarded() {  # ensure_onboarded <data-dir> <account>
  if spp "$1" "$2" overview "$POOL" | grep -q 'accept the disclaimer'; then
    # stdin is closed: onboarding prompts for an explorer URL and would otherwise
    # sit waiting for a keystroke that never comes.
    spp "$1" "$2" onboard --accept --register --no-bootnode </dev/null >/dev/null 2>&1 || true
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 1. Credentials — put every holder back in the register
# ---------------------------------------------------------------------------
step "restoring credentials"
restored=0
while read -r name credential _ _; do
  [[ "$name" == inv* ]] || continue
  if [[ "$credential" == "no" ]]; then
    echo "  re-issuing $name's claim"
    "$ROOT/scripts/credential.sh" "$name" grant >/dev/null
    restored=$((restored + 1))
  fi
done < <("$ROOT/scripts/policy-bridge.sh" status 2>/dev/null | sed -n 's/^ *\(inv[0-9]\) *\([a-z]*\) *\([a-z]*\) *\([a-z]*\)$/\1 \2 \3 \4/p')

(( restored > 0 )) && echo "  $restored credential(s) re-issued" || echo "  all credentials already valid"

# ---------------------------------------------------------------------------
# 2. Policy — before any proof is built against the old roots
# ---------------------------------------------------------------------------
step "syncing policy"
"$ROOT/scripts/policy-bridge.sh" sync 2>/dev/null | sed -n 's/^ *\(inv[0-9]:.*\)$/  \1/p' || true

# ---------------------------------------------------------------------------
# 3. Notes — sweep coupons back so the next take starts from nothing
# ---------------------------------------------------------------------------
if (( KEEP_NOTES )); then
  step "keeping investor notes (--keep-notes)"
else
  step "sweeping coupons back to the treasury"
  for name in $(jq -r '.holders[].name' "$STATE/rwa.json"); do
    dir="$STATE/rail-$name"
    [[ -d "$dir" ]] || continue

    balance=$(pool_balance "$dir" "sigilo-$name")
    if [[ -z "$balance" || "$balance" == "0" || "$balance" == "0.00" ]]; then
      echo "  $name: nothing held"
      continue
    fi

    printf '  %s: returning %s XLM… ' "$name" "$balance"
    if spp "$dir" "sigilo-$name" transfer "$POOL" "$balance" --to "$TREASURY" | grep -q tx_hash; then
      echo "done"
    else
      echo "failed (left in place)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 3b. Consolidate — a balance is not the same as a spendable balance
#
# The transfer circuit takes two input notes. A treasury holding 700 XLM across
# seven 100 XLM notes cannot pay inv4's 287.25625 coupon: the two largest notes
# it may spend reach 200, and the cycle dies on "no combination of notes reaches
# the goal amount". Deposits cap at 100 XLM, so funding alone never fixes it.
#
# Sweeping fragments the float every run — one note back from each holder — so
# this belongs after the sweep, not once at setup. Each self-transfer merges two
# notes into one, which is why it is a loop and not a single call: the bound is
# the number of holders plus the treasury's own change note.
# ---------------------------------------------------------------------------
if (( ! KEEP_NOTES )); then
  step "consolidating the treasury's notes"
  balance=$(pool_balance "$STATE/rail-treasury" sigilo-treasury)
  if [[ -z "$balance" || "$balance" == "0" ]]; then
    echo "  nothing to consolidate"
  else
    merges=$(( $(jq -r '.holders | length' "$STATE/rwa.json") + 1 ))
    printf '  %s XLM, up to %d merges… ' "$balance" "$merges"
    for _ in $(seq 1 "$merges"); do
      spp "$STATE/rail-treasury" sigilo-treasury \
        transfer "$POOL" "$balance" --to "$TREASURY" >/dev/null 2>&1 || break
    done
    echo "done"
    echo "  (one note now, so the largest coupon is payable from it alone)"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Report — the treasury must be able to fund the next cycle
# ---------------------------------------------------------------------------
step "state"
ensure_onboarded "$STATE/rail-treasury" sigilo-treasury
treasury_balance=$(pool_balance "$STATE/rail-treasury" sigilo-treasury)
echo "  treasury in pool: ${treasury_balance:-unknown} XLM"
echo "  (the issuer view lists what the next cycle owes; top up with"
echo "   'spp deposit' if the treasury falls short — 100 XLM per deposit,"
echo "   then re-run this script so the new notes are merged into one)"

cat <<'NEXT'

  One thing this script cannot do: the browser keeps its own copy of note state
  in OPFS, and a stale copy will show a balance that was just swept away. Before
  the next take, click "Reset demo cache" at the bottom of either page — it drops
  that copy and reloads. (DevTools → Application → Storage → Clear site data does
  the same thing by hand.)

  That clears the stale balance, not the history: note state is rebuilt from the
  chain, so earlier coupons come back marked spent. Sweeping spends them, and
  nothing erases them — an empty payment history needs a fresh deployment.
NEXT
