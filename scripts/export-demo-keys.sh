#!/usr/bin/env bash
# Exports the demo seed keys so the browser can sign without a wallet extension.
#
# These are throwaway testnet keys created by the seed, holding nothing of value.
# They land in .demo-state/, which is gitignored, and are declared as a demo
# configuration in the README — a real deployment signs with a real wallet.
#
# usage: ./scripts/export-demo-keys.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.demo-state/keys.json"

command -v jq >/dev/null || { echo "missing 'jq'" >&2; exit 1; }
[[ -f "$ROOT/.demo-state/rwa.json" ]] || { echo "run scripts/deploy-rwa.sh first" >&2; exit 1; }

secret_of() {
  stellar keys secret "$1" 2>/dev/null | grep '^S' | tr -d '[:space:]'
}

echo '{}' > "$OUT"
add() {  # add <role> <address> <secret>
  local tmp; tmp=$(mktemp)
  jq --arg r "$1" --arg a "$2" --arg s "$3" '.[$r] = {address: $a, secret: $s}' "$OUT" > "$tmp"
  mv "$tmp" "$OUT"
}

add issuer "$(jq -r '.admin' "$ROOT/.demo-state/rwa.json")" "$(secret_of sigilo-admin)"
add treasury "$(jq -r '.treasury' "$ROOT/.demo-state/rwa.json")" "$(secret_of sigilo-treasury)"

for name in $(jq -r '.holders[].name' "$ROOT/.demo-state/rwa.json"); do
  add "$name" "$(jq -r --arg n "$name" '.holders[]|select(.name==$n)|.address' "$ROOT/.demo-state/rwa.json")" \
      "$(secret_of "sigilo-$name")"
done

chmod 600 "$OUT"
echo "wrote $(jq -r 'keys|length' "$OUT") demo keys to .demo-state/keys.json (gitignored)"
