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
import { mint, PolicyRefusal } from './token.js';
import * as flow from './flow.js';

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

/** A holder is out of step when the register and the rail disagree about them. */
const outOfStep = (h) => h.credentialValid === h.railBlocked;

/**
 * One row per holder, carrying both verdicts.
 *
 * The credential cell answers the register's question, the spend cell answers the
 * rail's, and the cell between them is the link. When they disagree the row says so
 * where the eye already is — the revoke button is on the same line.
 *
 * The two verdict cells are marked with data attributes rather than left to be found
 * by column index: a layout change once moved them silently, and the recorder went on
 * asserting against the old positions.
 */
function renderHolders() {
  el('issuer-holders').querySelector('tbody').innerHTML = demo.holders.map((h) => `
    <tr data-holder="${h.name}">
      <td>${h.name}<div class="mono-sm">${short(h.address, 8, 6)}</div></td>
      <td class="num">${fmt(h.position, 0)}</td>
      <td>${h.entryDate}</td>
      <td data-credential>${h.credentialValid
        ? '<span class="badge ok">valid</span>'
        : '<span class="badge bad">revoked</span>'}</td>
      <td class="link-cell" ${outOfStep(h) ? 'data-broken' : ''}>${outOfStep(h) ? '╳' : '───'}</td>
      <td data-spend>${h.railBlocked
        ? '<span class="badge bad">frozen</span>'
        : (h.allowlisted ? '<span class="badge ok">allowed</span>' : '<span class="badge public">pending</span>')}
        ${outOfStep(h) ? '<div class="mono-sm out-of-step">out of step — sync</div>' : ''}</td>
      <td><button class="ghost" data-revoke="${h.name}">${h.credentialValid ? 'Revoke' : 'Restore'}</button></td>
    </tr>`).join('');

  el('issuer-holders').querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCredential(btn.dataset.revoke));
  });
}

/**
 * The header link, and who is enforcing any of this.
 *
 * A disagreement is not a cosmetic warning — while it lasts, a revoked holder can
 * still spend money already inside the rail. The rows above say which holders; this
 * says whether the two systems agree at all.
 */
function renderBridge() {
  const broken = demo.holders.filter(outOfStep);

  // Who enforces this matters more than the table below it. A contract owning the
  // trees means the operator cannot enrol or freeze anyone against the register;
  // without one, the same rules hold only because a script behaves.
  el('bridge-enforcer').innerHTML = demo.policyBridge
    ? `Enforced on-chain by
       <a href="${contractUrl(demo.policyBridge)}" target="_blank" rel="noopener">${short(demo.policyBridge, 8, 6)}</a>,
       which owns both the allow-list and the blocklist and consults the identity registry
       before moving either. The issuer cannot reach them directly —
       <em>the contract has no private key</em>.`
    : `Kept in step by an off-chain service. Nothing on-chain compels it to mirror the
       registry faithfully — deploy the PolicyBridge contract to remove that trust.`;

  el('bridge-link').toggleAttribute('data-broken', broken.length > 0);

  el('btn-prove').hidden = broken.length === 0;
  el('btn-prove').dataset.holder = broken[0]?.name ?? '';

  flow.reflectPolicy(demo.holders);
}

function renderCoupons() {
  el('coupon-terms').innerHTML = `
    ${COUPON.annualRatePct}% per annum, actual/${COUPON.dayCountBasis}, accrued from each
    holder's entry date to ${COUPON.paymentDate}. Reference <strong>${COUPON.reference}</strong>.
    Not proportional to positions — deliberately, since positions are public.`;

  el('coupon-table').querySelector('tbody').innerHTML = demo.holders.map((h) => {
    const { days, amount } = accruedCoupon(h);
    return `<tr data-coupon="${h.name}">
      <td>${h.name}</td>
      <td class="num">${fmt(h.position, 0)}</td>
      <td class="num">${days}</td>
      <td class="num">${fmt(amount)}</td>
      <td>${h.credentialValid
        ? '<span class="badge public">due</span>'
        : '<span class="badge bad">held back</span>'}</td>
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
  const revoking = holder.credentialValid;
  setProgress('sync-progress', `${revoking ? 'revoking' : 'restoring'} ${name}'s credential…`, 'register');

  try {
    const res = await fetch('/api/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: name, action: revoking ? 'revoke' : 'grant' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? 'failed');

    // Only the register changed. The rail keeps enforcing whatever its
    // association sets last said, which is why railBlocked is untouched here.
    holder.credentialValid = !revoking;
    renderHolders();
    renderBridge();
    renderCoupons();
    renderMintTargets();
    if (out.hash) pushFeed(`${revoking ? 'revoked' : 'restored'} ${name}`, out.hash);

    setProgress('sync-progress', revoking
      ? 'register updated — the payment side still lets this holder spend until you sync'
      : 'register updated — sync to lift the freeze');
  } catch (error) {
    setProgress('sync-progress', `failed: ${error?.message ?? error}`);
  }
}

/** Pushes the register's decisions into the rail's association sets. */
async function syncPolicy() {
  el('btn-sync').disabled = true;
  setProgress('sync-progress', 'reading the registry and moving the allow-list and blocklist…', 'sync');

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? 'failed');

    // The rail now agrees with the register.
    for (const h of demo.holders) h.railBlocked = !h.credentialValid;
    renderHolders();
    renderBridge();

    for (const line of out.changes ?? []) pushFeed(line, out.hash ?? '');
    setProgress('sync-progress', out.changes?.length
      ? `${out.changes.length} change(s) applied — proofs built against the old roots are now void`
      : 'allow-list and blocklist already match the registry');
  } catch (error) {
    setProgress('sync-progress', `failed: ${error?.message ?? error}`);
  } finally {
    el('btn-sync').disabled = false;
  }
}

function renderMintTargets() {
  el('mint-to').innerHTML = demo.holders
    .map((h) => `<option value="${h.name}">${h.name}${h.credentialValid ? '' : ' — revoked'}</option>`)
    .join('');
}

/**
 * Issues tokens, and shows the refusal as clearly as the success.
 *
 * A revoked recipient is turned away by the contract itself. Since that happens
 * in simulation, there is no failed transaction to link to — the honest thing to
 * show is the contract's refusal, and to say why nothing reached the ledger.
 */
async function issueTokens() {
  const name = el('mint-to').value;
  const holder = demo.holders.find((h) => h.name === name);
  const amount = Number(el('mint-amount').value);

  el('btn-mint').disabled = true;
  el('mint-out').innerHTML = '';
  setProgress('mint-progress', `issuing ${fmt(amount, 0)} ${demo.token.symbol} to ${name}…`, 'simulate');

  try {
    const hash = await mint({
      tokenContract: demo.token.contract,
      to: holder.address,
      amount,
      decimals: demo.token.decimals,
      signer: new LocalSigner(demo.issuer.secret, NETWORK_PASSPHRASE),
    });

    holder.position += amount;
    renderHolders();
    renderBridge();
    renderCoupons();
    if (hash) pushFeed(`issued ${fmt(amount, 0)} ${demo.token.symbol} → ${name}`, hash);

    el('mint-out').innerHTML = `<p class="hint">
      <span class="badge ok">accepted</span> ${name} holds a valid credential, so the
      token moved.</p>`;
    setProgress('mint-progress', '', 'done');
  } catch (error) {
    if (error instanceof PolicyRefusal) {
      el('mint-out').innerHTML = `
        <p style="font: 400 20px/1.2 var(--serif); margin:0 0 10px; color:var(--refused)">Refused by the token</p>
        <p class="hint">${error.message} <span class="mono-sm">(contract error #${error.code})</span></p>
        <p class="hint" style="margin-top:10px">
          Refused during simulation — no transaction was ever built.
        </p>`;
      setProgress('mint-progress', '');
    } else {
      setProgress('mint-progress', `failed: ${error?.message ?? error}`);
      console.error(error);
    }
  } finally {
    el('btn-mint').disabled = false;
  }
}

/**
 * Withdraws as the revoked holder, to show the gap rather than assert it.
 *
 * Before syncing this succeeds: the register says revoked, the rail never heard, and
 * the money leaves. After syncing the same attempt is refused. Two clicks, and the
 * argument needs no explaining.
 */
async function proveTheGap() {
  const name = el('btn-prove').dataset.holder;
  const holder = demo.holders.find((h) => h.name === name);
  if (!holder) return;

  el('btn-prove').disabled = true;
  el('prove-out').innerHTML = '';
  setProgress('sync-progress', `attempting a withdrawal as ${name}…`, 'proving');

  try {
    const signer = new LocalSigner(holder.secret, NETWORK_PASSPHRASE);
    const account = await openAccount(holder.address, signer, NETWORK_PASSPHRASE);
    const pool = await openPool(account, demo.rail.pool);

    const balance = await pool.balance();
    if (!balance || balance <= 0n) {
      el('prove-out').innerHTML = `<p class="hint">${name} holds nothing in the pool right
        now — run a coupon cycle first and the gap becomes spendable money.</p>`;
      return;
    }

    const amount = balance < 50_000_000n ? balance : 50_000_000n;   // up to 5 XLM
    const outcome = describeResult(await pool.withdraw(amount));

    for (const hash of outcome.hashes) pushFeed(`${name} withdrew from the pool`, hash);

    el('prove-out').innerHTML = outcome.ok
      ? `<p style="font:400 19px/1.3 var(--serif); color:var(--refused); margin:0 0 8px">
           ${name} just took the money out.</p>
         <p class="hint">Revoked in the register, never told to the payment side. Sync and try again.</p>`
      : `<p class="hint"><span class="badge ok">refused</span> ${outcome.message}</p>
         <p class="hint" style="margin-top:8px">The freeze reaches back over coupons
           received before the revocation.</p>`;

    setProgress('sync-progress', '');
  } catch (error) {
    // A refusal arrives as a thrown error on the client, before a transaction exists.
    const message = String(error?.message ?? error);
    el('prove-out').innerHTML = `
      <p class="hint"><span class="badge ok">refused</span> ${message.split('\n')[0]}</p>
      <p class="hint" style="margin-top:8px">The freeze reaches back over coupons
        received before the revocation.</p>`;
    setProgress('sync-progress', '');
  } finally {
    el('btn-prove').disabled = false;
  }
}

/** Pays every eligible holder from the treasury's pre-funded pool position. */
async function payCycle() {
  el('btn-pay').disabled = true;
  flow.at('pay');
  const stop = onProgress('transfer', (d) => setProgress('pay-progress', d.message, d.stage));

  try {
    const signer = new LocalSigner(demo.treasury.secret, NETWORK_PASSPHRASE);
    const account = await openAccount(demo.treasury.address, signer, NETWORK_PASSPHRASE);
    const pool = await openPool(account, demo.rail.pool);

    // Eligibility follows the register: an uncredentialed holder is skipped by
    // the issuer's own policy. The rail would let the payment through — it only
    // gates spending — so this exclusion is a service decision, not enforcement.
    const due = demo.holders.filter((h) => h.credentialValid);
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
    flow.done('pay');
  } catch (error) {
    setProgress('pay-progress', `failed: ${error?.message ?? error}`);
    console.error(error);
  } finally {
    stop();
    el('btn-pay').disabled = false;
  }
}

/**
 * Reads both systems from the chain rather than trusting local files, so a
 * divergence between the register and the rail shows up instead of being
 * papered over.
 */
async function refreshPolicyState() {
  try {
    const res = await fetch('/api/status');
    const out = await res.json();
    if (!res.ok) return;
    for (const holder of demo.holders) {
      const live = out.holders?.[holder.name];
      if (live) Object.assign(holder, live);
    }
  } catch {
    // Falls back to the seed's view; the badges stay honest either way.
  }
}

export async function mountIssuer(state) {
  demo = state ?? (await loadDemoState());
  renderSummary();
  renderHolders();
  renderBridge();
  renderCoupons();

  renderMintTargets();

  await refreshPolicyState();
  renderHolders();
  renderBridge();
  renderCoupons();
  renderMintTargets();
  el('btn-sync').addEventListener('click', syncPolicy);
  el('btn-pay').addEventListener('click', payCycle);
  el('btn-mint').addEventListener('click', issueTokens);
  el('btn-prove').addEventListener('click', proveTheGap);
}
