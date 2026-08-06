// Everything the views need about this deployment, loaded from the seed's output.
//
// The seed is the single source of truth: contract IDs, the holder cast, their
// positions and entry dates, and the throwaway signing keys. Nothing here is
// hardcoded, so a fresh seed reshapes the demo without touching the UI.

const STATE = '../.demo-state';

export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const EXPLORER = 'https://stellar.expert/explorer/testnet';

// Coupon terms. Declared here rather than derived, and published with the repo —
// which is why the demo's amounts are recomputable. In a real deployment the
// rate is the issuer's private data, and that is the thing the rail protects.
export const COUPON = {
  annualRatePct: 14.25,
  dayCountBasis: 360,
  paymentDate: '2026-08-04',
  reference: '2026-H2',
};

async function loadJson(name) {
  const res = await fetch(`${STATE}/${name}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`cannot read ${name} — has the seed been run?`);
  return res.json();
}

let cache = null;

export async function loadDemoState() {
  if (cache) return cache;

  const [rwa, rail, keys, policy] = await Promise.all([
    loadJson('rwa.json'),
    loadJson('rail.json'),
    loadJson('keys.json'),
    loadJson('policy.json').catch(() => ({})), // absent until the bridge has run
  ]);

  const pool = rail.pools[0];

  cache = {
    token: rwa.token,
    identity: rwa.identity,
    compliance: rwa.compliance,
    // The contract that owns the association sets. Its presence is what makes the
    // policy a rule rather than a promise, so the interface says which one is in force.
    policyBridge: rwa.policyBridge ?? null,
    issuer: { address: rwa.admin, secret: keys.issuer?.secret },
    treasury: { address: rwa.treasury, secret: keys.treasury?.secret },
    rail: {
      pool: pool.poolContractId,
      asset: pool.asset,
      aspMembership: rail.asp_membership,
      aspNonMembership: rail.asp_non_membership,
      registry: rail.public_key_registry,
    },
    // Two states, deliberately kept apart: the credential lives in the identity
    // register, the freeze lives in the rail's association sets. They agree only
    // after a sync, and the gap between them is the whole point of the bridge —
    // collapsing them into one field would make the UI claim a freeze that has
    // not happened yet.
    holders: rwa.holders.map((h) => ({
      ...h,
      secret: keys[h.name]?.secret,
      // The credential lives in the identity register and nothing here has read it.
      // It used to be inferred from `blocked`, which is the *rail's* verdict — so a
      // holder revoked through the interface came back `valid` on the next reload,
      // with no claim on-chain. null means unknown; only fetchLiveState() knows.
      credentialValid: null,
      railBlocked: policy[h.name]?.blocked === 'true',
      allowlisted: policy[h.name]?.allowlisted === 'true',
      noteKey: policy[h.name]?.note_key,
      // The allow-list leaf the policy gate enrolled under this holder's name.
      // Kept so the holder can re-derive it from their own key and check that
      // what was enrolled on their behalf is actually theirs.
      enrolledLeaf: policy[h.name]?.leaf,
    })),
  };

  return cache;
}

/**
 * Reads both systems from the chain and merges them into the loaded state.
 *
 * The seed knows the deployment; only the chain knows who is credentialed right
 * now. Every page that shows a credential has to ask, or it shows the state of
 * whenever the seed was written. Returns whether the read succeeded — a caller
 * that gets `false` still has `credentialValid: null` and must say so rather
 * than pick a side.
 */
let liveRead = null;

export function fetchLiveState(state) {
  // Shared, not repeated: /api/status simulates two contract calls per holder and
  // takes tens of seconds. Three panels asking at once used to mean three runs.
  liveRead ??= (async () => {
    try {
      const res = await fetch('/api/status');
      const out = await res.json();
      if (!res.ok) return null;
      return out.holders ?? null;
    } catch {
      return null;
    }
  })();

  return liveRead.then((holders) => {
    if (!holders) return false;
    for (const holder of state.holders) {
      if (holders[holder.name]) Object.assign(holder, holders[holder.name]);
    }
    return true;
  });
}

/** Forces the next fetchLiveState to ask again — after a sync has moved things. */
export const invalidateLiveState = () => { liveRead = null; };

/**
 * Coupon owed to a holder, accrued from the date they entered.
 *
 * Deliberately not pro-rata: with positions public on the ledger, proportional
 * coupons would be recoverable from a single disclosed payment. Accrual by
 * entry date breaks that ratio.
 */
export function accruedCoupon(holder, paymentDate = COUPON.paymentDate) {
  const days = Math.round(
    (new Date(paymentDate) - new Date(holder.entryDate)) / 86_400_000,
  );
  const amount =
    (holder.position * (COUPON.annualRatePct / 100) * days) / COUPON.dayCountBasis;
  return { days, amount: Math.round(amount * 1e7) / 1e7 };
}

export const toStroops = (amount) => BigInt(Math.round(amount * 1e7));
export const fromStroops = (stroops) => Number(stroops) / 1e7;

export const fmt = (n, dp = 7) =>
  Number(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, dp),
    maximumFractionDigits: dp,
  });

export const short = (id, head = 6, tail = 4) =>
  !id ? '—' : `${id.slice(0, head)}…${id.slice(-tail)}`;

export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const contractUrl = (c) => `${EXPLORER}/contract/${c}`;
