#!/usr/bin/env bash
# Grants or revokes a holder's KYC credential in the identity register.
#
# This touches the register and nothing else. The rail keeps enforcing whatever
# its association sets last said until policy-bridge.sh sync runs — and that gap
# is precisely what the bridge exists to close, so it is left visible rather
# than hidden behind a combined command.
#
# usage: ./scripts/credential.sh <holder> <grant|revoke>

set -euo pipefail

die() { echo "credential: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RWA_STATE="$ROOT/.demo-state/rwa.json"
KYC_TOPIC=1

[[ $# -eq 2 ]] || die "usage: credential.sh <holder> <grant|revoke>"
HOLDER="$1"; ACTION="$2"
[[ -f "$RWA_STATE" ]] || die "missing .demo-state/rwa.json — run deploy-rwa.sh first"
command -v jq >/dev/null || die "missing 'jq'"

export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

IDENTITY=$(jq -r --arg n "$HOLDER" '.holders[]|select(.name==$n)|.identity' "$RWA_STATE")
[[ -n "$IDENTITY" && "$IDENTITY" != "null" ]] || die "unknown holder: $HOLDER"
CLAIM_ISSUER=$(jq -r '.identity.claimIssuer' "$RWA_STATE")
ALIAS="sigilo-$HOLDER"

case "$ACTION" in
  revoke)
    CLAIM_ID=$(stellar contract invoke "${NET[@]}" --id "$IDENTITY" --source "$ALIAS" --send=no \
      -- get_claim_ids_by_topic --topic "$KYC_TOPIC" 2>/dev/null | jq -r '.[0] // empty')
    [[ -n "$CLAIM_ID" ]] || die "$HOLDER holds no KYC claim to revoke"

    HASH=$(stellar contract invoke "${NET[@]}" --id "$IDENTITY" --source "$ALIAS" \
      -- remove_claim --claim_id "$CLAIM_ID" 2>&1 \
      | grep -oE 'tx/[0-9a-f]{64}' | head -1 | cut -d/ -f2)
    echo "{\"holder\":\"$HOLDER\",\"action\":\"revoke\",\"hash\":\"${HASH:-}\"}"
    ;;

  grant)
    SIGN_CLAIM_DIR="${OZ_REPO:?set OZ_REPO to re-issue a claim}/examples/rwa/sign-claim"
    CLAIM_SECRET=$(cat "$ROOT/.demo-state/claim-signer.secret")

    read -r DATA SIG <<<"$( cd "$SIGN_CLAIM_DIR" && cargo run -q -- \
      --secret-key "$CLAIM_SECRET" --claim-issuer "$CLAIM_ISSUER" \
      --identity "$IDENTITY" --claim-topic "$KYC_TOPIC" 2>/dev/null \
      | awk '/^--data/ {d=$2} /^--signature/ {s=$2} END {print d, s}' )"
    [[ -n "$DATA" && -n "$SIG" ]] || die "could not sign a claim for $HOLDER"

    HASH=$(stellar contract invoke "${NET[@]}" --id "$IDENTITY" --source "$ALIAS" \
      -- add_claim --topic "$KYC_TOPIC" --scheme 101 --issuer "$CLAIM_ISSUER" \
      --signature "$SIG" --data "$DATA" \
      --uri "https://sigilo.example/claim/$HOLDER/$KYC_TOPIC" 2>&1 \
      | grep -oE 'tx/[0-9a-f]{64}' | head -1 | cut -d/ -f2)
    echo "{\"holder\":\"$HOLDER\",\"action\":\"grant\",\"hash\":\"${HASH:-}\"}"
    ;;

  *) die "action must be grant or revoke" ;;
esac
