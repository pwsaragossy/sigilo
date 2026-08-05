// The rail runtime: wasm init, storage, client, per-role accounts.
//
// Ported from the reference app's wasm-facade, minus the parts a recorded demo
// does not need (wallet watcher, service worker, persistence prompts) and plus
// the one thing it does: several roles sharing a single page.
//
// That sharing is not a preference. The storage worker holds an exclusive OPFS
// lock, so a second tab of this app evicts the first. One page, one storage,
// accounts swapped underneath — anything else deadlocks.

import init, {
  Client,
  Storage,
  verifySelectiveDisclosure as sdkVerifyDisclosure,
  deriveAspUserLeaf as sdkDeriveAspUserLeaf,
} from 'stellar-private-payments';

export const TX_PROGRESS_EVENT = 'stellar-private-payments:tx-progress';

// A second tab is the only thing that realistically stops storage from opening, but
// the SDK reports it three ways depending on where the OPFS handle collides: its own
// friendly message, the raw DOMException, or a generic init failure. Matching only the
// friendly one leaves the other two telling the reader nothing they can act on.
const DB_LOCKED_SIGNATURES = [
  "Another tab or window is using this app's local database",
  'NoModificationAllowedError',
  'Failed to initialize local database storage',
];

let wasmReady = false;
let storageHandle = null;
let clientHandle = null;
const accounts = new Map(); // address → Account

async function ensureWasm() {
  if (!wasmReady) {
    await init();
    wasmReady = true;
  }
}

/** Opens the one storage worker this page gets. Cold start can take ~15s. */
export async function ensureStorage() {
  await ensureWasm();
  if (!storageHandle) storageHandle = await Storage.open();
  return storageHandle;
}

export async function initRuntime(rpcUrl) {
  if (clientHandle) return clientHandle;
  const storage = await ensureStorage();
  clientHandle = await Client.new({ storage, rpcUrl });
  return clientHandle;
}

export function client() {
  if (!clientHandle) throw new Error('Rail runtime not started.');
  return clientHandle;
}

/**
 * Binds a role's account, deriving its keys on first use.
 *
 * Cached per address: re-binding would re-run key derivation and, worse, hand
 * back a second account object over the same storage.
 */
export async function openAccount(address, signer, networkPassphrase) {
  if (accounts.has(address)) return accounts.get(address);
  const account = await client().account(
    { networkPassphrase, userAddress: address },
    signer,
  );
  accounts.set(address, account);
  return account;
}

export async function pool(account, poolContract) {
  return account.pool({ poolContract });
}

/**
 * Resolves a recipient's rail keys before paying them.
 *
 * Paying by address alone fails quietly when the local registry index lags, so
 * the reference app looks the keys up first and transfers to those. We do the same.
 */
export async function resolveRecipient(address) {
  const lookup = await client().recipientLookup(address);
  if (!lookup?.entry) {
    throw new Error(`${address.slice(0, 8)}… has not registered rail keys yet`);
  }
  return lookup.entry;
}

export const deriveAspUserLeaf = async (noteKeyHex, aspSecretHex) => {
  await ensureWasm();
  return sdkDeriveAspUserLeaf(noteKeyHex, aspSecretHex);
};

/** Auditor path: no wallet, no storage, no client — just an RPC URL. */
export const verifyDisclosure = async (rpcUrl, receiptJson, expectedVkHash) => {
  await ensureWasm();
  return sdkVerifyDisclosure(rpcUrl, receiptJson, expectedVkHash);
};

/**
 * Subscribes to progress for one flow. The rail reports building → proving →
 * submitting as it goes; proving alone is ~9s, and sync_wait legitimately
 * waits up to ~10s for the indexer, so never layer a shorter timeout on top.
 */
export function onProgress(flow, handler) {
  const listener = (event) => {
    const d = event.detail;
    if (d?.flow === flow && d?.message) handler(d);
  };
  window.addEventListener(TX_PROGRESS_EVENT, listener);
  return () => window.removeEventListener(TX_PROGRESS_EVENT, listener);
}

/** Pool operations answer with a tagged union rather than throwing. */
export function describeResult(result) {
  if (result?.status === 'ok') return { ok: true, hashes: result.hashes ?? [] };
  if (result?.status === 'aspNotReady') {
    return { ok: false, hashes: [], message: 'Not yet enrolled in the association set.' };
  }
  return {
    ok: false,
    hashes: result?.hashes ?? [], // a mid-plan failure still returns what landed
    message: result?.message ?? 'Unknown failure',
    code: result?.code,
  };
}

export function isDbLocked(error) {
  const text = String(error?.message ?? error);
  return DB_LOCKED_SIGNATURES.some((s) => text.includes(s));
}
