// The investor's view: the same holding, seen from outside and from inside.
//
// The left column is what any observer reads off the ledger. The right column is
// what this holder decrypts locally. Putting them side by side is the argument —
// the position was never secret, the payment always was.

import {
  loadDemoState, NETWORK_PASSPHRASE, COUPON,
  fromStroops, fmt, short, contractUrl, accruedCoupon,
} from './demo-state.js';
import { openAccount, pool as openPool, onProgress } from './sdk-facade.js';
import { LocalSigner } from './local-signer.js';
import * as flow from './flow.js';

const el = (id) => document.getElementById(id);
const pick = () => el('investor-pick');
const progress = () => el('investor-progress');

let demo;
let current = null;    // { holder, account, pool, notes }
let selectedNote = null;

function setProgress(text, stage) {
  progress().innerHTML = stage
    ? `<span class="stage">${stage}</span> ${text}`
    : (text ?? '');
}

function renderPublic(holder) {
  const { days, amount } = accruedCoupon(holder);
  el('investor-public').innerHTML = `
    <dt>Address</dt><dd class="mono-sm">${holder.address}</dd>
    <dt>Token</dt><dd><a href="${contractUrl(demo.token.contract)}" target="_blank" rel="noopener">${demo.token.symbol}</a></dd>
    <dt>Position</dt><dd>${fmt(holder.position, 0)} <span class="badge public">public</span></dd>
    <dt>Entered</dt><dd>${holder.entryDate} <span class="badge public">public</span></dd>
    <dt>Credential</dt><dd>${holder.credentialValid
      ? '<span class="badge ok">valid</span>'
      : '<span class="badge bad">revoked</span>'}</dd>
    <dt>Coupon paid</dt><dd><span class="sealed">—————</span> <span class="hint">not readable on-chain</span></dd>
    <dt title="what an observer could still infer">Accrual</dt>
    <dd class="hint">${days} days at ${COUPON.annualRatePct}% — computable only if the rate is known</dd>
  `;
}

function renderPrivate(notes) {
  const box = el('investor-private');

  if (!notes.length) {
    box.innerHTML = `<p class="empty">No coupon received yet. When the issuer runs a
      cycle, the payment lands here and nowhere else.</p>`;
    return;
  }

  const total = notes.reduce((sum, n) => sum + fromStroops(n.amount), 0);
  box.innerHTML = `
    <dl class="fields">
      <dt>Received</dt>
      <dd><strong class="revealed">${fmt(total)}</strong> XLM
          <span class="badge ok">decrypted locally</span></dd>
      <dt>Payments</dt><dd>${notes.length}</dd>
    </dl>
    <table style="margin-top:16px">
      <thead><tr><th>Commitment</th><th class="num">Amount</th><th>State</th></tr></thead>
      <tbody>${notes.map((n) => `
        <tr>
          <td class="mono-sm">${short(n.id, 10, 6)}</td>
          <td class="num revealed">${fmt(fromStroops(n.amount))}</td>
          <td>${n.spent ? '<span class="badge public">spent</span>' : '<span class="badge ok">held</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="hint" style="margin-top:14px">
      Recovered from the note ciphertexts with this holder's key.
    </p>`;
}

function renderNoteChoices(notes) {
  const box = el('disclose-notes');
  selectedNote = null;
  el('btn-disclose').disabled = true;

  if (!notes.length) {
    box.innerHTML = '<p class="hint">Nothing to disclose yet.</p>';
    return;
  }

  box.innerHTML = notes.map((n, i) => `
    <label style="display:flex; gap:10px; align-items:center; padding:7px 0">
      <input type="radio" name="note" value="${i}">
      <span class="mono-sm">${short(n.id, 12, 6)}</span>
      <span class="revealed">${fmt(fromStroops(n.amount))} XLM</span>
    </label>`).join('');

  box.querySelectorAll('input[name=note]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedNote = notes[Number(input.value)];
      el('btn-disclose').disabled = false;
    });
  });
}

/**
 * Opens a holder's wallet.
 *
 * `announce` moves the lifecycle marker to this step, and the initial mount passes
 * false: warming the panel on page load is not the holder doing anything, and a bar
 * that opens on "Holder decrypts" claims a place in the cycle nobody reached.
 */
async function selectHolder(name, { announce = true } = {}) {
  const holder = demo.holders.find((h) => h.name === name);
  renderPublic(holder);
  el('investor-private').innerHTML = '<p class="hint">Opening wallet…</p>';
  setProgress('deriving keys and syncing notes…', 'opening');

  const signer = new LocalSigner(holder.secret, NETWORK_PASSPHRASE);
  const account = await openAccount(holder.address, signer, NETWORK_PASSPHRASE);
  const pool = await openPool(account, demo.rail.pool);
  const notes = await pool.notes();

  current = { holder, account, pool, notes };
  // Only a decrypted note proves the holder actually received one.
  if (notes.length) flow.done('receive');
  if (announce) flow.at('receive');
  renderPrivate(notes);
  renderNoteChoices(notes);
  setProgress('');
}

async function generateReceipt() {
  if (!current || !selectedNote) return;

  flow.at('prove');
  const stop = onProgress('disclose', (d) => setProgress(
    d.stage === 'proving' ? `${d.message} · ~13s of real proof, not simulated` : d.message,
    d.stage));
  el('btn-disclose').disabled = true;

  try {
    // A nonce keeps a receipt from being replayed into a different audit.
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    nonce[0] = 0; // keep it inside the BN254 field
    const nonceHex = '0x' + [...nonce].map((b) => b.toString(16).padStart(2, '0')).join('');

    const receipt = await current.pool.disclose({
      selectedCommitments: [selectedNote.id],
      authorityLabel: 'Independent Auditor',
      authorityIdentityPayloadHex: '0x00',
      purpose: `coupon ${COUPON.reference} / holder ${current.holder.name}`,
      contextNonce: nonceHex,
    });

    // Returns null rather than throwing when the holder is not in the association set.
    if (!receipt) {
      el('disclose-out').innerHTML = `<p class="hint">This holder is not currently
        enrolled in the allow-list, so no proof can be produced.</p>`;
      return;
    }

    const json = JSON.stringify(receipt, null, 2);
    el('disclose-out').innerHTML = `
      <p class="hint">Hand this to the auditor. It proves this one payment and nothing else.</p>
      <textarea readonly id="receipt-out">${json}</textarea>
      <button class="ghost" id="btn-to-auditor" style="margin-top:10px">Send to the auditor tab</button>`;

    el('btn-to-auditor').addEventListener('click', () => {
      document.getElementById('receipt-input').value = json;
      document.querySelector('.roles button[data-role=auditor]').click();
    });

    setProgress('receipt ready', 'done');
  } catch (error) {
    setProgress(`failed: ${error?.message ?? error}`);
    console.error(error);
  } finally {
    stop();
    el('btn-disclose').disabled = false;
  }
}

export async function mountInvestor(state) {
  demo = state ?? (await loadDemoState());

  pick().innerHTML = demo.holders
    .map((h) => `<option value="${h.name}">${h.name} — ${fmt(h.position, 0)} ${demo.token.symbol}</option>`)
    .join('');

  pick().addEventListener('change', (e) => {
    selectHolder(e.target.value).catch((error) => {
      setProgress(`failed: ${error?.message ?? error}`);
      console.error(error);
    });
  });

  el('btn-disclose').addEventListener('click', generateReceipt);

  await selectHolder(demo.holders[0].name, { announce: false });
}
