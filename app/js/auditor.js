// The auditor's view.
//
// Verification needs no wallet, no storage and no account — only an RPC endpoint
// and the receipt. That is the whole point of selective disclosure: an auditor
// holds no privileged position, just a document someone chose to hand over.
//
// The report is deliberately not one boolean. Cryptographic validity is
// proof ∧ context ∧ known-root; whether the note was later spent is a separate
// fact, and disclosing an already-spent payment is perfectly legitimate.

import { RPC_URL, fmt, short, contractUrl } from './demo-state.js';
import { verifyDisclosure } from './sdk-facade.js';
import { expectedVkHash } from './vk-hashes.js';
import * as flow from './flow.js';

const el = (id) => document.getElementById(id);

const yes = (ok) => ok
  ? '<span class="badge ok">yes</span>'
  : '<span class="badge bad">no</span>';

function renderReport(receipt, report) {
  const cryptographic =
    report.proofVerified && report.contextVerified && report.knownRootStatus;

  const amounts = receipt.publicInputs.amounts
    .map((a) => fmt(Number(a) / 1e7))
    .join(', ');

  el('verify-out').innerHTML = `
    <p style="font: 400 22px/1.2 var(--serif); margin:0 0 18px; color:${cryptographic ? 'var(--verified)' : 'var(--refused)'}">
      ${cryptographic ? 'Verified' : 'Refused'}
    </p>

    <table>
      <thead><tr><th>Check</th><th>Result</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><td>Proof</td><td>${yes(report.proofVerified)}</td>
            <td class="hint">the amount and possession are proven, not asserted</td></tr>
        <tr><td>Context</td><td>${yes(report.contextVerified)}</td>
            <td class="hint">the stated purpose is bound into the proof and unaltered</td></tr>
        <tr><td>Root</td><td>${yes(report.knownRootStatus)}</td>
            <td class="hint">the payment exists in this pool's history</td></tr>
        <tr><td>Unspent</td><td>${yes(report.nullifiersUnspent)}</td>
            <td class="hint">not part of validity — a spent payment can still be disclosed</td></tr>
      </tbody>
    </table>

    <h2 style="margin-top:26px">Disclosed</h2>
    <dl class="fields">
      <dt>Amount</dt>
      <dd><span class="revealed">${amounts}</span> XLM <span class="badge ok">proven</span></dd>

      <dt>Possession</dt>
      <dd>the party who produced this receipt holds the note <span class="badge ok">proven</span></dd>

      <dt>Pool</dt>
      <dd><a href="${contractUrl(receipt.context.poolAddress)}" target="_blank" rel="noopener">${short(receipt.context.poolAddress, 8, 6)}</a>
          <span class="badge ok">proven</span></dd>

      <dt>Reference</dt>
      <dd>${receipt.context.purpose} <span class="badge attested">attested</span></dd>

      <dt>Authority</dt>
      <dd>${receipt.context.authorityLabel} <span class="badge attested">attested</span></dd>

      <dt>Commitment</dt>
      <dd class="mono-sm">${receipt.publicInputs.noteCommitments.map((c) => short(c, 12, 8)).join(', ')}</dd>
    </dl>

    <p class="hint" style="margin-top:18px">
      <em>Proven</em> is checked against the circuit. <em>Attested</em> is declared by
      whoever produced the receipt — tamper-evident, since altering it breaks the
      context check, but its truth rests on their word, not on mathematics.
    </p>

    <p class="hint" style="margin-top:14px">
      This receipt says nothing about any other payment, this holder's balance,
      or who else was paid in the same cycle.
    </p>`;
}

async function verify() {
  const raw = el('receipt-input').value.trim();
  if (!raw) return;

  // Clear the previous verdict first. Verification takes ~10s, and leaving the
  // last answer on screen while a new receipt is checked reads as approval.
  el('verify-out').innerHTML = '<p class="hint">Checking the proof against the circuit…</p>';
  el('verify-progress').textContent = 'verifying…';
  el('btn-verify').disabled = true;

  try {
    const receipt = JSON.parse(raw);
    // Checked against our own copy of the key, never the one the receipt names.
    const expected = expectedVkHash(receipt.circuit?.name);

    const report = await verifyDisclosure(RPC_URL, JSON.stringify(receipt), expected);
    renderReport(receipt, report);
    flow.done('prove');
    el('verify-progress').textContent = '';
  } catch (error) {
    // A refusal is as informative as a pass — FR-15 wants this legible.
    el('verify-out').innerHTML = `
      <p style="font: 400 22px/1.2 var(--serif); margin:0 0 14px; color:var(--refused)">Refused</p>
      <p class="hint">${error?.message ?? error}</p>
      <p class="hint" style="margin-top:12px">
        A receipt that has been altered, or that describes a payment this pool never
        saw, does not verify. There is no partial credit.
      </p>`;
    el('verify-progress').textContent = '';
  } finally {
    el('btn-verify').disabled = false;
  }
}

/** Flips one digit of the proof, to show the check is real. */
function tamper() {
  const raw = el('receipt-input').value.trim();
  if (!raw) return;
  try {
    const receipt = JSON.parse(raw);
    const proof = receipt.proofCompressedHex;
    const i = proof.length - 3;
    const flipped = proof[i] === 'a' ? 'b' : 'a';
    receipt.proofCompressedHex = proof.slice(0, i) + flipped + proof.slice(i + 1);
    el('receipt-input').value = JSON.stringify(receipt, null, 2);
    el('verify-progress').textContent = 'one digit of the proof changed — verify again';
  } catch {
    el('verify-progress').textContent = 'paste a receipt first';
  }
}

export function mountAuditor() {
  el('btn-verify').addEventListener('click', verify);
  el('btn-tamper').addEventListener('click', tamper);
}
