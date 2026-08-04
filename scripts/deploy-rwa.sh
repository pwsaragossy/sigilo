#!/usr/bin/env bash
# Deploy Sigilo's permissioned receivable token (ERC-3643 / T-REX) to Stellar testnet.
#
# Deploys the seven-contract OpenZeppelin RWA stack, issues signed KYC/AML claims for
# each demo investor, and mints deliberately uneven positions with distinct entry dates
# so coupon amounts are not a fixed ratio of the holdings.
#
# Idempotent per-run only: each run deploys a fresh stack and overwrites the state file.
#
# usage: OZ_REPO=/path/to/stellar-contracts ./scripts/deploy-rwa.sh

set -euo pipefail

die() { echo "deploy-rwa: $*" >&2; exit 1; }
step() { echo; echo "==> $*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/.demo-state"
STATE="$OUT_DIR/rwa.json"

: "${OZ_REPO:?set OZ_REPO to a clone of OpenZeppelin/stellar-contracts (pinned at 9b5ed96)}"
[[ -d "$OZ_REPO" ]] || die "OZ_REPO not found: $OZ_REPO"

export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

WASM="$OZ_REPO/target/wasm32v1-none/release"
[[ -d "$WASM" ]] || die "contracts not built — run 'stellar contract build' in $OZ_REPO"

command -v stellar >/dev/null || die "missing 'stellar' CLI"
command -v jq >/dev/null || die "missing 'jq'"

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# Demo cast. Positions are uneven and entry dates differ, so that coupons
# accrued per day are not derivable as a fixed fraction of a public balance.
# ---------------------------------------------------------------------------
INVESTORS=(inv1 inv2 inv3 inv4 inv5)
#                       units      entry date   country (ISO 3166-1 numeric)
INV_POSITION=(1500 3200 875 4100 2350)
INV_ENTRY=("2026-01-15" "2026-03-03" "2026-05-22" "2026-02-08" "2026-06-17")
INV_COUNTRY=(76 76 76 840 76)   # 76 = Brazil, 840 = United States
DECIMALS=7

TOKEN_NAME="${TOKEN_NAME:-Sigilo Receivable Note}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-RDXN}"

# ---------------------------------------------------------------------------
# 1. Keys
# ---------------------------------------------------------------------------
step "provisioning keys"

fund() {  # `stellar keys generate --fund` is unreliable when a stale ~/.stellar exists
  local addr; addr="$(stellar keys address "$1")"
  curl -s "https://friendbot.stellar.org/?addr=$addr" -o /dev/null || true
}

for who in sigilo-admin sigilo-treasury "${INVESTORS[@]/#/sigilo-}"; do
  if ! stellar keys address "$who" >/dev/null 2>&1; then
    stellar keys generate "$who" >/dev/null 2>&1 || true
  fi
  fund "$who"
  echo "  $who = $(stellar keys address "$who")"
done

ADMIN_ADDR="$(stellar keys address sigilo-admin)"

# Ed25519 keypair that signs identity claims. Generated per deployment — the
# OpenZeppelin example ships an all-zero key that is publicly known.
CLAIM_KEY_FILE="$OUT_DIR/claim-signer.secret"
if [[ ! -f "$CLAIM_KEY_FILE" ]]; then
  openssl rand -hex 32 > "$CLAIM_KEY_FILE"
  chmod 600 "$CLAIM_KEY_FILE"
fi
CLAIM_SECRET="$(cat "$CLAIM_KEY_FILE")"

# `examples/rwa/sign-claim` sits in the workspace's `exclude` list yet declares
# `authors.workspace = true`, so the `--manifest-path` invocation the RWA README
# documents fails with "failed to find a workspace root". Patch it into a
# standalone crate so the tool can actually run.
SIGN_CLAIM_DIR="$OZ_REPO/examples/rwa/sign-claim"
if grep -q 'authors.workspace' "$SIGN_CLAIM_DIR/Cargo.toml" 2>/dev/null; then
  step "patching sign-claim manifest (upstream: excluded crate inheriting from workspace)"
  sed -i.bak 's/authors.workspace = true/authors = ["OpenZeppelin"]/' "$SIGN_CLAIM_DIR/Cargo.toml"
  grep -q '^\[workspace\]' "$SIGN_CLAIM_DIR/Cargo.toml" || printf '\n[workspace]\n' >> "$SIGN_CLAIM_DIR/Cargo.toml"
fi

sign_claim() {  # sign_claim <issuer> <identity> <topic> → prints "<data> <signature>"
  ( cd "$SIGN_CLAIM_DIR" && cargo run -q -- \
      --secret-key "$CLAIM_SECRET" --claim-issuer "$1" --identity "$2" --claim-topic "$3" 2>/dev/null ) \
    | awk '/^--data/ {d=$2} /^--signature/ {s=$2} END {print d, s}'
}

# The signature is pubkey(32B) ‖ ed25519_sig(64B), so the signing key's public
# half is simply its first 64 hex characters — no separate derivation needed.
CLAIM_PUBLIC="$(sign_claim "$ADMIN_ADDR" "$ADMIN_ADDR" 1 | awk '{print substr($2, 1, 64)}')"
[[ ${#CLAIM_PUBLIC} -eq 64 ]] || die "could not derive claim signer public key"
echo "  claim signer pubkey = $CLAIM_PUBLIC"

# ---------------------------------------------------------------------------
# 2-3. Claim topics registry + claim issuer
# ---------------------------------------------------------------------------
deploy() {  # deploy <wasm-name> <alias> [constructor args...]
  local wasm="$1" alias="$2"; shift 2
  stellar contract deploy "${NET[@]}" --source sigilo-admin \
    --wasm "$WASM/$wasm" -- "$@" 2>/dev/null | tail -n 1
}

step "deploying claim topics + issuers registry"
CTI=$(deploy rwa_claim_topics_and_issuers_example.wasm claim-topics-and-issuers \
  --admin sigilo-admin --manager sigilo-admin)
echo "  $CTI"

for topic in 1 2; do   # 1 = KYC, 2 = AML
  stellar contract invoke "${NET[@]}" --id "$CTI" --source sigilo-admin \
    -- add_claim_topic --claim_topic $topic --operator sigilo-admin >/dev/null 2>&1
done

step "deploying claim issuer"
ISSUER=$(deploy rwa_claim_issuer_example.wasm claim-issuer --owner sigilo-admin)
echo "  $ISSUER"

stellar contract invoke "${NET[@]}" --id "$CTI" --source sigilo-admin \
  -- add_trusted_issuer --trusted_issuer "$ISSUER" --claim_topics '[1, 2]' \
  --operator sigilo-admin >/dev/null 2>&1

for topic in 1 2; do
  stellar contract invoke "${NET[@]}" --id "$ISSUER" --source sigilo-admin \
    -- allow_key --public_key "$CLAIM_PUBLIC" --registry "$CTI" --claim_topic $topic >/dev/null 2>&1
done

# ---------------------------------------------------------------------------
# 4. Per-investor identity contracts with signed KYC + AML claims
# ---------------------------------------------------------------------------
step "deploying investor identities and issuing claims"
declare -a IDENTITIES=()

for i in "${!INVESTORS[@]}"; do
  who="sigilo-${INVESTORS[$i]}"
  id_addr=$(deploy rwa_identity_example.wasm "identity-${INVESTORS[$i]}" --owner "$who")
  IDENTITIES+=("$id_addr")
  echo "  ${INVESTORS[$i]}: $id_addr"

  for topic in 1 2; do
    read -r data sig <<<"$(sign_claim "$ISSUER" "$id_addr" "$topic")"
    [[ -n "$data" && -n "$sig" ]] || die "sign-claim produced no output for ${INVESTORS[$i]} topic $topic"

    stellar contract invoke "${NET[@]}" --id "$id_addr" --source "$who" \
      -- add_claim --topic $topic --scheme 101 --issuer "$ISSUER" \
      --signature "$sig" --data "$data" \
      --uri "https://sigilo.example/claim/${INVESTORS[$i]}/$topic" >/dev/null 2>&1
  done
done

# ---------------------------------------------------------------------------
# 5-7. Identity registry, verifier, compliance
# ---------------------------------------------------------------------------
step "deploying identity registry"
REGISTRY=$(deploy rwa_identity_registry_example.wasm identity-registry \
  --admin sigilo-admin --manager sigilo-admin)
echo "  $REGISTRY"

# `add_identity` takes Vec<Val>, which erases the CountryData schema, so the CLI
# only accepts raw XDR-JSON here. (The RWA README's shorthand is rejected.)
# CountryData { country: CountryRelation::Individual(Residence(u32)), metadata: None }
country_profile() {
  printf '[{"map":[{"key":{"symbol":"country"},"val":{"vec":[{"symbol":"Individual"},{"vec":[{"symbol":"Residence"},{"u32":%s}]}]}},{"key":{"symbol":"metadata"},"val":"void"}]}]' "$1"
}

for i in "${!INVESTORS[@]}"; do
  stellar contract invoke "${NET[@]}" --id "$REGISTRY" --source sigilo-admin \
    -- add_identity --account "sigilo-${INVESTORS[$i]}" --identity "${IDENTITIES[$i]}" \
    --initial_profiles "$(country_profile "${INV_COUNTRY[$i]}")" \
    --operator sigilo-admin >/dev/null 2>&1
done

step "deploying identity verifier"
VERIFIER=$(deploy rwa_identity_verifier_example.wasm identity-verifier \
  --admin sigilo-admin --manager sigilo-admin \
  --identity_registry_storage "$REGISTRY" --claim_topics_and_issuers "$CTI")
echo "  $VERIFIER"

step "deploying compliance"
COMPLIANCE=$(deploy rwa_compliance_example.wasm compliance \
  --admin sigilo-admin --manager sigilo-admin)
echo "  $COMPLIANCE"

# ---------------------------------------------------------------------------
# 8-9. Token, bindings, and the initial book
# ---------------------------------------------------------------------------
step "deploying RWA token"
TOKEN=$(deploy rwa_token_example.wasm rwa-token \
  --name "$TOKEN_NAME" --symbol "$TOKEN_SYMBOL" \
  --admin sigilo-admin --manager sigilo-admin \
  --compliance "$COMPLIANCE" --identity_verifier "$VERIFIER")
echo "  $TOKEN"

for periphery in "$REGISTRY" "$COMPLIANCE"; do
  stellar contract invoke "${NET[@]}" --id "$periphery" --source sigilo-admin \
    -- bind_token --token "$TOKEN" --operator sigilo-admin >/dev/null 2>&1
done

step "minting positions"
SCALE=$((10 ** DECIMALS))
for i in "${!INVESTORS[@]}"; do
  amount=$(( ${INV_POSITION[$i]} * SCALE ))
  stellar contract invoke "${NET[@]}" --id "$TOKEN" --source sigilo-admin \
    -- mint --to "sigilo-${INVESTORS[$i]}" --amount "$amount" --operator sigilo-admin >/dev/null 2>&1
  echo "  ${INVESTORS[$i]}: ${INV_POSITION[$i]} $TOKEN_SYMBOL (entered ${INV_ENTRY[$i]})"
done

# ---------------------------------------------------------------------------
# State file — consumed by the coupon service and the demo UI
# ---------------------------------------------------------------------------
holders_json="[]"
for i in "${!INVESTORS[@]}"; do
  holders_json=$(jq --arg n "${INVESTORS[$i]}" \
    --arg a "$(stellar keys address "sigilo-${INVESTORS[$i]}")" \
    --arg id "${IDENTITIES[$i]}" --arg e "${INV_ENTRY[$i]}" \
    --argjson p "${INV_POSITION[$i]}" --argjson c "${INV_COUNTRY[$i]}" \
    '. + [{name:$n, address:$a, identity:$id, position:$p, entryDate:$e, country:$c}]' \
    <<<"$holders_json")
done

jq -n --arg net testnet --arg token "$TOKEN" --arg sym "$TOKEN_SYMBOL" \
  --arg cti "$CTI" --arg issuer "$ISSUER" --arg registry "$REGISTRY" \
  --arg verifier "$VERIFIER" --arg compliance "$COMPLIANCE" \
  --arg admin "$ADMIN_ADDR" --arg treasury "$(stellar keys address sigilo-treasury)" \
  --arg signer "$CLAIM_PUBLIC" --argjson decimals "$DECIMALS" --argjson holders "$holders_json" \
  '{network:$net, token:{contract:$token, symbol:$sym, decimals:$decimals},
    identity:{claimTopicsAndIssuers:$cti, claimIssuer:$issuer, registry:$registry,
              verifier:$verifier, claimSignerPublicKey:$signer},
    compliance:$compliance, admin:$admin, treasury:$treasury, holders:$holders}' > "$STATE"

step "done — state written to ${STATE#$ROOT/}"
jq -r '"  token      \(.token.contract)\n  registry   \(.identity.registry)\n  compliance \(.compliance)"' "$STATE"
