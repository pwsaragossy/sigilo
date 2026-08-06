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

// Claimed for the lifetime of whichever page opens storage first. The SDK's own
// collision is a ~30s timeout deep inside a worker that never settles the promise
// we awaited, so the page sits on "opening…" forever with the real cause only in
// the console. Asking the browser first turns that into an immediate, legible
// refusal — and it is the platform's own primitive, not a lock of our own making.
const STORAGE_LOCK = 'sigilo:spp-storage';

// Long enough that a reload's own teardown is not mistaken for a second tab,
// short enough that a real collision is named before anyone starts waiting.
const LOCK_GRACE_MS = 1500;

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

/**
 * Takes the storage lock, or reports that another page holds it.
 *
 * Held until this document goes away — the browser releases it on unload, which is
 * why the callback never returns. Anything unexpected (no Web Locks, a rejection
 * that is not our own abort) resolves true: a guard that blocks a working page is
 * worse than the bug it guards against.
 */
function claimStorageLock() {
  if (!navigator.locks) return Promise.resolve(true);

  return new Promise((settle) => {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), LOCK_GRACE_MS);

    navigator.locks
      .request(STORAGE_LOCK, { mode: 'exclusive', signal: giveUp.signal }, () => {
        clearTimeout(timer);
        settle(true);
        return new Promise(() => {});   // never resolves: the lock is ours until unload
      })
      .catch((error) => {
        clearTimeout(timer);
        settle(error?.name !== 'AbortError');
      });
  });
}

/**
 * Opens the one storage worker this page gets. Cold start can take ~15s.
 *
 * Verification does not come through here — `verifyDisclosure` needs only wasm — so
 * a second tab can still check a receipt while the first holds the database.
 */
export async function ensureStorage() {
  await ensureWasm();
  if (!storageHandle) {
    if (!(await claimStorageLock())) {
      throw new Error(
        "Another tab or window is using this app's local database. "
        + 'The confidential payment SDK keeps exactly one — close the other tab and reload.',
      );
    }
    storageHandle = await Storage.open();
  }
  return storageHandle;
}

export async function initRuntime(rpcUrl) {
  if (clientHandle) return clientHandle;
  const storage = await ensureStorage();
  clientHandle = await Client.new({ storage, rpcUrl });
  return clientHandle;
}

export function client() {
  if (!clientHandle) throw new Error('Confidential payment runtime not started.');
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
    throw new Error(`${address.slice(0, 8)}… has not registered payment keys yet`);
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
    return { ok: false, hashes: [], message: 'Not yet enrolled in the allow-list.' };
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
