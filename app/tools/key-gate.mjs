// Does a browser-side signer derive the same rail keys the CLI already derived?
//
// The rail derives a holder's note key and ASP secret from an Ed25519 signature
// over a fixed message. If our local signer reproduces the CLI's SEP-53 scheme
// byte for byte, the browser sees the coupons the CLI already paid — and the
// allowlist leaf we inserted still refers to the same holder. If it does not,
// the investor view opens on an empty wallet and nothing downstream works.
//
// Rather than trust the reading, this recomputes the ASP secret from the
// signature and compares it against what `policy-bridge.sh enroll` recorded.
//
// usage: node tools/key-gate.mjs

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, '../../.demo-state/policy.json');

// sdk/prover/src/encryption.rs
const KEY_DERIVATION_MESSAGE = 'Privacy Pool Key Derivation [v1]';
const ASP_SECRET_DOMAIN = 'privacy-pool/asp-secret/v1';
const NETWORK_CONTEXT = 'testnet'; // deployment_config().network
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// SEP-53: prefix, SHA-256, then sign the digest. cli/src/stellar_cli.rs:101-104
function signMessageSep53(keypair, message) {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  return keypair.sign(createHash('sha256').update(payload).digest());
}

// hash_signature_with_domain_and_context: domain ‖ 0x00 ‖ context ‖ 0x00 ‖ sig
function hashWithDomainAndContext(signature, domain, context) {
  return createHash('sha256')
    .update(Buffer.from(domain, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(context, 'utf8'))
    .update(Buffer.from([0]))
    .update(signature)
    .digest();
}

// Fr::from_le_bytes_mod_order, rendered the way Field displays itself (big-endian hex).
function toFieldHexBe(digest) {
  const reduced = Buffer.from(digest).reverse().reduce((acc, b) => (acc << 8n) | BigInt(b), 0n) % BN254_R;
  return '0x' + reduced.toString(16).padStart(64, '0');
}

function deriveAspSecret(secretKey) {
  const sig = signMessageSep53(Keypair.fromSecret(secretKey), KEY_DERIVATION_MESSAGE);
  if (sig.length !== 64) throw new Error(`signature must be 64 bytes, got ${sig.length}`);
  return toFieldHexBe(hashWithDomainAndContext(sig, ASP_SECRET_DOMAIN, NETWORK_CONTEXT));
}

const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
let mismatches = 0;

console.log('comparing browser-side derivation against what the CLI recorded\n');
for (const [name, entry] of Object.entries(policy)) {
  const secret = execFileSync('stellar', ['keys', 'secret', `sigilo-${name}`], { encoding: 'utf8' })
    .split('\n').find(l => l.startsWith('S'))?.trim();
  if (!secret) {
    console.log(`  ${name}: no local secret key — skipped`);
    continue;
  }

  const derived = deriveAspSecret(secret);
  const recorded = entry.asp_secret;
  const match = derived === recorded;
  if (!match) mismatches++;

  console.log(`  ${name}: ${match ? 'match' : 'MISMATCH'}`);
  if (!match) {
    console.log(`    recorded ${recorded}`);
    console.log(`    derived  ${derived}`);
  }
}

console.log(
  mismatches === 0
    ? '\nThe browser will derive the same keys. Coupons already paid will be visible.'
    : `\n${mismatches} holder(s) diverge — the browser would open on an empty wallet.`
);
process.exit(mismatches === 0 ? 0 : 1);
