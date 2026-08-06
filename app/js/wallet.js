// The holder's wallet, alone on a page.
//
// The demo page tells the issuer's story and the holder appears in it as a tab.
// This is the same rail told from the wallet end: a balance nobody else can read,
// a send that publishes no amount, a withdrawal the policy gate can refuse, and a
// receipt that proves one payment to someone holding no keys at all.
//
// Everything here runs against the same testnet deployment as index.html. It shares
// the runtime facade, the local signer and the seed state, and reuses the auditor
// module verbatim for the verification panel — which is the honest way to show that
// verification needs nothing from the wallet.

import {
  loadDemoState, NETWORK_PASSPHRASE, RPC_URL, COUPON,
  fromStroops, toStroops, fmt, short, contractUrl, txUrl,
} from './demo-state.js';
import {
  initRuntime, openAccount, pool as openPool, resolveRecipient,
  onProgress, describeResult, isDbLocked, client,
} from './sdk-facade.js';
import { LocalSigner } from './local-signer.js';
import { mountAuditor } from './auditor.js';

const el = (id) => document.getElementById(id);

let demo;
let current = null;      // { holder, account, pool, notes }
let selectedNote = null;

function setProgress(id, text, stage) {
  el(id).innerHTML = stage ? `<span class="stage">${stage}</span> ${text}` : (text ?? '');
}

function die(error) {
  el('fatal').hidden = false;
  el('fatal').textContent = isDbLocked(error)
    ? 'Another tab has this app open. The confidential payment SDK keeps one exclusive local database — close the other tab and reload.'
    : `Could not start: ${error?.message ?? error}`;
  console.error(error);
}

/* ---------------------------------------------------------------- rendering */

function renderPublic(holder) {
  el('wallet-public').innerHTML = `
    <dt>Address</dt><dd class="mono-sm">${holder.address}</dd>
    <dt>Token</dt>
    <dd><a href="${contractUrl(demo.token.contract)}" target="_blank" rel="noopener">${demo.token.symbol}</a></dd>
    <dt>Position</dt><dd>${fmt(holder.position, 0)} <span class="badge public">public</span></dd>
    <dt>Credential</dt><dd>${holder.credentialValid
      ? '<span class="badge ok">valid</span>'
      : '<span class="badge bad">revoked</span>'}</dd>
    <dt>Pool</dt>
    <dd class="mono-sm"><a href="${contractUrl(demo.rail.pool)}" target="_blank" rel="noopener">${short(demo.rail.pool, 8, 6)}</a></dd>
    <dt>Coupon</dt>
    <dd><span class="sealed">—————</span> <span class="hint">amount not readable on-chain</span></dd>
  `;
}

function renderActivity(notes) {
  if (!notes.length) {
    el('activity').innerHTML = `<p class="empty">Nothing yet. A payment addressed to this
      wallet lands here the moment it is decrypted — no explorer will show it.</p>`;
    return;
  }

  el('activity').innerHTML = `
    <table>
      <thead><tr><th>Commitment</th><th class="num">Amount</th><th>State</th></tr></thead>
      <tbody>${notes.map((n) => `
        <tr>
          <td class="mono-sm">${short(n.id, 12, 8)}</td>
          <td class="num revealed">${fmt(fromStroops(n.amount))}</td>
          <td>${n.spent
            ? '<span class="badge public">spent</span>'
            : '<span class="badge ok">held</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderNoteChoices(notes) {
  selectedNote = null;
  el('btn-disclose').disabled = true;

  const spendable = notes.filter((n) => !n.spent);
  if (!spendable.length) {
    el('disclose-notes').innerHTML = '<p class="hint">No payment held right now to disclose.</p>';
    return;
  }

  el('disclose-notes').innerHTML = spendable.map((n, i) => `
    <label style="display:flex; gap:10px; align-items:center; padding:7px 0">
      <input type="radio" name="note" value="${i}">
      <span class="mono-sm">${short(n.id, 12, 8)}</span>
      <span class="revealed">${fmt(fromStroops(n.amount))} XLM</span>
    </label>`).join('');

  el('disclose-notes').querySelectorAll('input[name=note]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedNote = spendable[Number(input.value)];
      el('btn-disclose').disabled = false;
    });
  });
}

/**
 * The keys a payer resolves before paying this wallet.
 *
 * Absent until the account has registered them on-chain, which is a real state and
 * not an error: an unregistered wallet can hold nothing, and saying so is more use
 * than an empty field.
 */
async function renderReceiveKeys(address) {
  try {
    const entry = await resolveRecipient(address);
    el('recv-keys').innerHTML = `
      <dt>Note key</dt><dd class="mono-sm">${entry.noteKey}</dd>
      <dt>Encryption key</dt><dd class="mono-sm">${entry.encryptionKey}</dd>`;
  } catch (error) {
    el('recv-keys').innerHTML = `<dt>Keys</dt><dd class="hint">${error?.message ?? error}
      — nobody can pay this wallet privately until they are registered.</dd>`;
  }
}

/* ---------------------------------------------------------------- actions */

/**
 * One shape for every pool operation.
 *
 * All four take ~9–13s of proving in a worker and can fail two different ways:
 * a tagged refusal from the pool, or a thrown error raised client-side before a
 * transaction exists — which is how the policy freeze arrives, since the
 * association-set check runs while the proof context is assembled.
 */
async function act({ button, progressId, outId, flow, label, run }) {
  el(button).disabled = true;
  el(outId).innerHTML = '';

  const stop = onProgress(flow, (d) => setProgress(
    progressId,
    d.stage === 'proving' ? `${d.message} · real proof, not simulated` : d.message,
    d.stage,
  ));

  try {
    const outcome = describeResult(await run());

    el(outId).innerHTML = outcome.ok
      ? `<p class="hint"><span class="badge ok">${label}</span>
           ${outcome.hashes.map((h) =>
             `<a href="${txUrl(h)}" target="_blank" rel="noopener">${short(h, 8, 6)}</a>`).join(' ')}
         </p>`
      : `<p class="hint"><span class="badge bad">refused</span> ${outcome.message}</p>`;

    setProgress(progressId, '');
    if (outcome.ok) await refresh();
  } catch (error) {
    // The policy gate arrives here rather than as a tagged refusal: the pool requires
    // the proof's association roots to equal the current ones, so a blocklisted holder
    // is stopped client-side, before a transaction is ever built.
    //
    // Which is why the freeze is only named when the rail actually said so. An empty
    // balance refuses through the same path, and captioning that as a revocation would
    // claim an enforcement that did not happen.
    const message = String(error?.message ?? error).split('\n')[0];
    const frozen = /non-membership|association|not in the allow|asp/i.test(message);

    el(outId).innerHTML = `
      <p class="hint"><span class="badge bad">refused</span> ${message}</p>
      ${frozen ? `<p class="hint" style="margin-top:8px">This is the policy gate. The freeze
        reaches back over payments received before the credential was revoked.</p>` : ''}`;
    setProgress(progressId, '');
    console.error(error);
  } finally {
    stop();
    el(button).disabled = false;
  }
}

function amountOf(id) {
  const value = Number(el(id).value);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount above zero.');
  return toStroops(value);
}

async function send() {
  const typed = el('send-address').value.trim();
  const address = typed || el('send-to').value;

  let amount;
  try { amount = amountOf('send-amount'); }
  catch (error) { setProgress('send-progress', error.message); return; }

  await act({
    button: 'btn-send', progressId: 'send-progress', outId: 'send-out',
    flow: 'transfer', label: 'sent',
    run: async () => {
      // Resolve keys first: paying by address alone fails quietly when the local
      // registry index lags behind the chain.
      const entry = await resolveRecipient(address);
      return current.pool.transferToKeys(entry.noteKey, entry.encryptionKey, amount);
    },
  });
}

async function withdraw() {
  let amount;
  try { amount = amountOf('wd-amount'); }
  catch (error) { setProgress('wd-progress', error.message); return; }

  await act({
    button: 'btn-withdraw', progressId: 'wd-progress', outId: 'wd-out',
    flow: 'withdraw', label: 'withdrawn',
    run: () => current.pool.withdraw(amount),
  });
}

async function deposit() {
  let amount;
  try { amount = amountOf('dep-amount'); }
  catch (error) { setProgress('dep-progress', error.message); return; }

  await act({
    button: 'btn-deposit', progressId: 'dep-progress', outId: 'dep-out',
    flow: 'deposit', label: 'deposited',
    run: () => current.pool.deposit(amount),
  });
}

async function generateReceipt() {
  if (!current || !selectedNote) return;

  const stop = onProgress('disclose', (d) => setProgress(
    'disclose-progress',
    d.stage === 'proving' ? `${d.message} · ~13s of real proof, not simulated` : d.message,
    d.stage,
  ));
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

    // Returns null rather than throwing when the account is not in the association set.
    if (!receipt) {
      el('disclose-out').innerHTML = `<p class="hint">This wallet is not currently enrolled
        in the allow-list, so no proof can be produced.</p>`;
      return;
    }

    const json = JSON.stringify(receipt, null, 2);
    el('disclose-out').innerHTML = `
      <p class="hint">Hand this over. It proves this one payment and nothing else.</p>
      <textarea readonly>${json}</textarea>
      <button class="ghost" id="btn-to-verify" style="margin-top:10px">Verify it below</button>`;

    el('btn-to-verify').addEventListener('click', () => {
      el('receipt-input').value = json;
      el('receipt-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    setProgress('disclose-progress', 'receipt ready', 'done');
  } catch (error) {
    setProgress('disclose-progress', `failed: ${error?.message ?? error}`);
    console.error(error);
  } finally {
    stop();
    el('btn-disclose').disabled = false;
  }
}

/* ---------------------------------------------------------------- lifecycle */

/** Re-reads the balance and notes after anything that moves money. */
async function refresh() {
  const balance = await current.pool.balance();
  const notes = await current.pool.notes();
  current.notes = notes;

  el('bal-private').textContent = fmt(fromStroops(balance));
  el('bal-note').textContent = notes.length
    ? `${notes.length} payment(s), decrypted in this page from ciphertexts nobody else can read`
    : 'decrypted in this page, from note ciphertexts nobody else can read';

  renderActivity(notes);
  renderNoteChoices(notes);
}

async function openWallet(name) {
  const holder = demo.holders.find((h) => h.name === name);
  current = null;
  selectedNote = null;

  renderPublic(holder);
  el('bal-private').textContent = '—';
  el('activity').innerHTML = '<p class="hint">Opening wallet…</p>';
  setProgress('wallet-progress', 'deriving keys and syncing notes…', 'opening');

  const signer = new LocalSigner(holder.secret, NETWORK_PASSPHRASE);
  const account = await openAccount(holder.address, signer, NETWORK_PASSPHRASE);
  const pool = await openPool(account, demo.rail.pool);
  current = { holder, account, pool, notes: [] };

  // Recipients are the rest of the cast; a free-text address still overrides it.
  el('send-to').innerHTML = demo.holders
    .filter((h) => h.name !== name)
    .map((h) => `<option value="${h.address}">${h.name} — ${short(h.address, 6, 4)}</option>`)
    .join('');

  await Promise.all([refresh(), renderReceiveKeys(holder.address)]);
  setProgress('wallet-progress', '');
}

async function start() {
  try {
    demo = await loadDemoState();

    // Verification needs no runtime at all, so it is live before the rail is up.
    mountAuditor(demo);

    el('wallet-pick').innerHTML = demo.holders
      .map((h) => `<option value="${h.name}">${h.name}</option>`)
      .join('');

    el('wallet-pick').addEventListener('change', (e) => {
      openWallet(e.target.value).catch((error) =>
        setProgress('wallet-progress', `failed: ${error?.message ?? error}`));
    });

    el('btn-send').addEventListener('click', send);
    el('btn-withdraw').addEventListener('click', withdraw);
    el('btn-deposit').addEventListener('click', deposit);
    el('btn-disclose').addEventListener('click', generateReceipt);

    await initRuntime(RPC_URL);
    await openWallet(demo.holders[0].name);
  } catch (error) {
    die(error);
  }
}

start();
