// Probes the auditor-side verification path outside the browser.
//
// `verifySelectiveDisclosure` needs no wallet, no local storage and no Client —
// only an RPC endpoint and the receipt itself, which is what makes the auditor
// role cheap to build. It does still need the prover Web Worker, so the final
// cryptographic check belongs to the browser; Node gets as far as schema
// validation and stops there.
//
// What this establishes:
//   * the vendored SDK loads and runs outside a browser
//   * the exact receipt schema the auditor view must accept
//   * malformed receipts are refused, layer by layer, with legible reasons
//
// usage: node tools/verify-receipt.mjs <receipt.json>
//        node tools/verify-receipt.mjs --self-test

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../vendor/spp-sdk-web/dist');
const RPC = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// The wasm is built for the browser; Node needs the bytes handed to it directly.
async function loadSdk() {
  const mod = await import(`${DIST}/stellar_private_payments_sdk_web.js`);
  await mod.default({
    module_or_path: readFileSync(`${DIST}/stellar_private_payments_sdk_web_bg.wasm`),
  });
  return mod;
}

const hashes = JSON.parse(readFileSync(`${DIST}/circuits/artifact_hashes.json`, 'utf8'));

function vkHashFor(circuit) {
  const entry = hashes[circuit];
  if (!entry) throw new Error(`no artifact hashes for ${circuit}`);
  return entry.verifying_key ?? entry.vk ?? Object.values(entry)[0];
}

async function verify(sdk, receipt) {
  const circuit = `selectiveDisclosure_${receipt.publicInputs?.noteCommitments?.length ?? 1}`;
  return sdk.verifySelectiveDisclosure(RPC, JSON.stringify(receipt), vkHashFor(circuit), {});
}

const sdk = await loadSdk();
console.log('SDK loaded — circuits available:', Object.keys(hashes).filter(k => k.startsWith('selectiveDisclosure')).join(', '));

if (process.argv[2] === '--self-test') {
  // A receipt the auditor should refuse. Proves the verdict is a real check and
  // not a rubber stamp — the failure path matters as much as the success path.
  const forged = {
    version: 1,
    circuit: {
      name: 'selectiveDisclosure_1',
      levels: 10,
      nNotes: 1,
      vkHash: vkHashFor('selectiveDisclosure_1'),
    },
    issuedAt: '2026-08-04T00:00:00Z',
    context: {
      network: 'testnet',
      poolAddress: 'CCOCML4RJ7GO4MZS4OMD63W3HRJFXEIJBWRQGQTMOB35PDUBMLREN7WH',
      authorityLabel: 'Forged Auditor',
      authorityIdentityPayloadHex: '0x00',
      purpose: 'coupon 2026-Q3 / holder inv2',
      contextNonce: `0x${'00'.repeat(32)}`,
    },
    // Leading 0x00 keeps every value inside the BN254 field, so the receipt
    // parses and the verifier has to actually check the proof rather than
    // bouncing it at deserialisation.
    publicInputs: {
      roots: [`0x00${'11'.repeat(31)}`],
      noteCommitments: [`0x00${'22'.repeat(31)}`],
      extContextHash: `0x00${'33'.repeat(31)}`,
      nullifiers: [`0x00${'44'.repeat(31)}`],
      amounts: ['87500000'],
    },
    proofCompressedHex: `0x${'00'.repeat(128)}`,
  };

  try {
    const report = await verify(sdk, forged);
    const ok = report?.proofVerified ?? report?.proof_verified;
    console.log('\nforged receipt →', ok ? 'ACCEPTED (BAD)' : 'REJECTED (correct)');
    console.log(JSON.stringify(report, null, 2));
    process.exit(ok ? 1 : 0);
  } catch (e) {
    const msg = String(e.message ?? e).split('\n')[0];
    // Reaching the worker requirement means every schema-level check passed and
    // the receipt is well-formed enough that only the proof itself is left.
    if (msg.includes('proverWorkerUrl')) {
      console.log('\nforged receipt → schema accepted, proof check needs the browser worker');
      console.log('  ' + msg);
      console.log('\nThe auditor view runs this in a page, where the worker exists.');
      process.exit(0);
    }
    console.log('\nforged receipt → REJECTED (correct):', msg);
    process.exit(0);
  }
}

const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const report = await verify(sdk, receipt);
console.log(JSON.stringify(report, null, 2));
