// The issuer's view: the register, the policy, and the coupon run.
//
// Two things happen here that look similar and are not. Granting or revoking a
// credential edits the register. Syncing pushes that decision into the rail's
// association sets. Between those two steps the systems disagree — a revoked
// holder can still spend — which is exactly what the bridge exists to close.

import {
  loadDemoState, NETWORK_PASSPHRASE, COUPON,
  accruedCoupon, toStroops, fromStroops, fmt, short, txUrl, contractUrl,
} from './demo-state.js';
import {
  openAccount, pool as openPool, onProgress, describeResult, resolveRecipient, client,
} from './sdk-facade.js';
import { LocalSigner } from './local-signer.js';

const el = (id) => document.getElementById(id);
let demo;
const feed = [];

function setProgress(id, text, stage) {
  el(id).innerHTML = stage ? `<span class="stage">${stage}</span> ${text}` : (text ?? '');
}

function pushFeed(label, hash) {
  feed.unshift({ label, hash });
  el('issuer-feed').innerHTML = feed
    .map((f) => `<div style="padding:5px 0">${f.label} —
        <a href="${txUrl(f.hash)}" target="_blank" rel="noopener">${short(f.hash, 10, 6)}</a></div>`)
    .join('');
}

function renderSummary() {
  el('issuer-summary').innerHTML = `
    <strong>${demo.token.symbol}</strong> — permissioned receivable note,
    <a href="${contractUrl(demo.token.contract)}" target="_blank" rel="noopener">${short(demo.token.contract, 8, 6)}</a>.
    Transfers are gated by an identity registry
    (<a href="${contractUrl(demo.identity.registry)}" target="_blank" rel="noopener">${short(demo.identity.registry, 8, 6)}</a>);
    coupons are paid through a confidential pool
    (<a href="${contractUrl(demo.rail.pool)}" target="_blank" rel="noopener">${short(demo.rail.pool, 8, 6)}</a>).`;
}

function renderHolders() {
  el('issuer-holders').querySelector('tbody').innerHTML = demo.holders.map((h) => `
    <tr data-holder="${h.name}">
      <td>${h.name}<div class="mono-sm">${short(h.address, 8, 6)}</div></td>
      <td class="num">${fmt(h.position, 0)}</td>
      <td>${h.entryDate}</td>
      <td>${h.blocked
        ? '<span class="badge bad">revoked</span>'
        : '<span class="badge ok">valid</span>'}</td>
      <td>${h.blocked
        ? '<span class="badge bad">frozen</span>'
        : (h.allowlisted ? '<span class="badge ok">allowed</span>' : '<span class="badge public">pending</span>')}</td>
      <td><button class="ghost" data-revoke="${h.name}">${h.blocked ? 'Restore' : 'Revoke'}</button></td>
    </tr>`).join('');

  el('issuer-holders').querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCredential(btn.dataset.revoke));
  });
}

function renderCoupons() {
  el('coupon-terms').innerHTML = `
    ${COUPON.annualRatePct}% per annum, actual/${COUPON.dayCountBasis}, accrued from each
    holder's entry date to ${COUPON.paymentDate}. Reference <strong>${COUPON.reference}</strong>.
    Amounts are not proportional to positions — that is deliberate, since positions are public.`;

  el('coupon-table').querySelector('tbody').innerHTML = demo.holders.map((h) => {
    const { days, amount } = accruedCoupon(h);
    return `<tr data-coupon="${h.name}">
      <td>${h.name}</td>
      <td class="num">${fmt(h.position, 0)}</td>
      <td class="num">${days}</td>
      <td class="num">${fmt(amount)}</td>
      <td>${h.blocked
        ? '<span class="badge bad">held back</span>'
        : '<span class="badge public">due</span>'}</td>
    </tr>`;
  }).join('');
}

/**
 * Revokes or restores a KYC claim — in the register only.
 *
 * Nothing about the rail changes here. That gap is the demonstration: until
 * policy is synced, a revoked holder can still spend what they already hold.
 */
async function toggleCredential(name) {
  const holder = demo.holders.find((h) => h.name === name);
  setProgress('sync-progress', `${holder.blocked ? 'restoring' : 'revoking'} ${name}'s credential…`, 'register');

  try {
    const res = await fetch('/api/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: name, action: holder.blocked ? 'grant' : 'revoke' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? 'failed');

    holder.blocked = !holder.blocked;
    renderHolders();
    renderCoupons();
    if (out.hash) pushFeed(`${holder.blocked ? 'revoked' : 'restored'} ${name}`, out.hash);

    setProgress('sync-progress',
      holder.blocked
        ? 'register updated — the rail still allows this holder to spend until you sync'
        : 'register updated — sync to lift the freeze');
  } catch (error) {
    setProgress('sync-progress', `failed: ${error?.message ?? error}`);
  }
}

/** Pushes the register's decisions into the rail's association sets. */
async function syncPolicy() {
  el('btn-sync').disabled = true;
  setProgress('sync-progress', 'reading the registry and moving the association sets…', 'sync');

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? 'failed');

    for (const line of out.changes ?? []) pushFeed(line, out.hash ?? '');
    setProgress('sync-progress', out.changes?.length
      ? `${out.changes.length} change(s) applied — proofs built against the old roots are now void`
      : 'association sets already match the registry');
  } catch (error) {
    setProgress('sync-progress', `failed: ${error?.message ?? error}`);
  } finally {
    el('btn-sync').disabled = false;
  }
}

/** Pays every eligible holder from the treasury's pre-funded pool position. */
async function payCycle() {
  el('btn-pay').disabled = true;
  const stop = onProgress('transfer', (d) => setProgress('pay-progress', d.message, d.stage));

  try {
    const signer = new LocalSigner(demo.treasury.secret, NETWORK_PASSPHRASE);
    const account = await openAccount(demo.treasury.address, signer, NETWORK_PASSPHRASE);
    const pool = await openPool(account, demo.rail.pool);

    const due = demo.holders.filter((h) => !h.blocked);
    let paid = 0;

    for (const holder of due) {
      const { amount } = accruedCoupon(holder);
      setProgress('pay-progress', `paying ${holder.name} (${paid + 1}/${due.length})…`, 'cycle');

      // Resolve rail keys first: paying by address alone fails quietly when the
      // local registry index is behind.
      const entry = await resolveRecipient(holder.address);
      const result = await pool.transferToKeys(
        entry.noteKey, entry.encryptionKey, toStroops(amount),
      );

      const outcome = describeResult(result);
      for (const hash of outcome.hashes) pushFeed(`coupon → ${holder.name}`, hash);
      if (!outcome.ok) throw new Error(`${holder.name}: ${outcome.message}`);

      paid++;
      const row = document.querySelector(`[data-coupon="${holder.name}"] td:last-child`);
      if (row) row.innerHTML = '<span class="badge ok">paid</span>';
    }

    setProgress('pay-progress', `${paid} coupon(s) paid — no amount readable on-chain`, 'done');
  } catch (error) {
    setProgress('pay-progress', `failed: ${error?.message ?? error}`);
    console.error(error);
  } finally {
    stop();
    el('btn-pay').disabled = false;
  }
}

export async function mountIssuer(state) {
  demo = state ?? (await loadDemoState());
  renderSummary();
  renderHolders();
  renderCoupons();
  el('btn-sync').addEventListener('click', syncPolicy);
  el('btn-pay').addEventListener('click', payCycle);
}
