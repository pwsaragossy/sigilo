#!/usr/bin/env bash
# Bundles the one dependency the browser cannot resolve on its own.
#
# The rail SDK is already ESM and self-resolving, so it is imported straight from
# vendor/ via the import map. @stellar/stellar-sdk is CommonJS-flavoured and needs
# bundling — the local signer uses it for Ed25519 and XDR. Resolving it by package
# name (not by file) lets esbuild honour the package's own browser mapping, which
# is what swaps the Node-only bits for browser equivalents.

set -euo pipefail
cd "$(dirname "$0")"

[[ -d node_modules ]] || npm install

mkdir -p vendor

# The package is CommonJS underneath, so `export *` yields nothing importable by
# name. Pull the namespace apart explicitly and re-export only what we use.
cat > vendor/.stellar-entry.js <<'ENTRY'
import * as sdk from '@stellar/stellar-sdk';
const api = sdk.default ?? sdk;
export const Keypair = api.Keypair;
export const hash = api.hash;
export const TransactionBuilder = api.TransactionBuilder;
ENTRY

npx esbuild vendor/.stellar-entry.js \
  --bundle --format=esm --platform=browser \
  --define:global=globalThis \
  --outfile=vendor/stellar-sdk.js

rm -f vendor/.stellar-entry.js
echo "bundled vendor/stellar-sdk.js ($(du -h vendor/stellar-sdk.js | cut -f1))"
