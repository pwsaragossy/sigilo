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
  loadDemoState, fetchLiveState, NETWORK_PASSPHRASE, RPC_URL, COUPON,
  fromStroops, toStroops, fmt, short, contractUrl, txUrl,
} from './demo-state.js';
import {
  initRuntime, openAccount, pool as openPool, resolveRecipient,
  onProgress, describeResult, isDbLocked,
} from './sdk-facade.js';
import { LocalSigner } from './local-signer.js';
import { mountAuditor } from './auditor.js';

const el = (id) => document.getElementById(id);

let demo;
let current = null;      // { holder, account, pool, notes }
let selectedNote = null;
// Bumped on every switch, so a superseded open can be told from the current one.
let openGeneration = 0;
// The holder actually open, as opposed to the one the selector names mid-switch.
let openHolder = null;

function setProgress(id, text, stage) {
  el(id).innerHTML = stage ? `<span class="stage">${stage}</span> ${text}` : (text ?? '');
}

function die(error) {
  el('fatal').hidden = false;
  el('fatal').textContent = isDbLocked(error)
    ? 'Another tab has this app open. The confidential payment SDK keeps one exclusive local database — close the other tab and reload. Verification below still works: it needs no database at all.'
    : `Could not start: ${error?.message ?? error}`;

  // No wallet means no pool. Left live, these answer a click with a null dereference,
  // which reads as broken code rather than as the one condition the banner just named.
  // The verify panel is deliberately not among them — it never opened storage.
  for (const id of ['btn-send', 'btn-withdraw', 'btn-deposit', 'btn-disclose', 'btn-derive']) {
    el(id).disabled = true;
  }

  console.error(error);
}

/* ---------------------------------------------------------------- rendering */

function renderPublic(holder) {
  el('wallet-public').innerHTML = `
    <dt>Address</dt><dd class="mono-sm">${holder.address}</dd>
    <dt>Token</dt>
    <dd><a href="${contractUrl(demo.token.contract)}" target="_blank" rel="noopener">${demo.token.symbol}</a></dd>
    <dt>Position</dt><dd>${fmt(holder.position, 0)} <span class="badge public">public</span></dd>
    <dt>Credential</dt><dd>${holder.credentialValid === null
      ? '<span class="badge public">checking…</span>'
      : (holder.credentialValid
        ? '<span class="badge ok">valid</span>'
        : '<span class="badge bad">revoked</span>')}</dd>
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

// The CLI records the leaf in decimal, the SDK answers in hex. Comparing as
// numbers is correct — but showing them in different bases would put two
// unlike strings under a "matches" badge, which reads as a contradiction.
const asBigInt = (v) => BigInt(/^0x/i.test(String(v)) ? String(v) : String(v).trim());
const asHex = (v) => `0x${asBigInt(v).toString(16).padStart(64, '0')}`;

/**
 * What the policy operator was given, and what this wallet can check.
 *
 * The note key is public. The membership secret behind the leaf is not — it is
 * derived from this holder's key and the page never sees it, which is the point:
 * only their wallet can reproduce the leaf enrolled on their behalf.
 */
function renderEnrolment(holder) {
  el('derive-out').innerHTML = '';
  el('derive-progress').textContent = '';
  el('btn-derive').disabled = !holder.enrolledLeaf;

  el('enrol-fields').innerHTML = `
    <dt>Note key</dt>
    <dd class="mono-sm">${holder.noteKey ?? '—'} <span class="badge public">public</span></dd>

    <dt>Membership secret</dt>
    <dd class="hint">held by this wallet — never sent to the page, never held by the issuer</dd>

    <dt>Leaf on record</dt>
    <dd class="mono-sm">${holder.enrolledLeaf
      ? short(asHex(holder.enrolledLeaf), 14, 10)
      : 'not enrolled yet'}<div class="hint">what the policy gate inserted under this name</div></dd>
  `;
}

/** Re-derives the allow-list leaf from this wallet's own keys, and compares. */
async function deriveLeaf() {
  const holder = current?.holder;
  if (!holder?.enrolledLeaf) return;

  el('btn-derive').disabled = true;
  el('derive-progress').textContent = 'deriving from this wallet…';

  try {
    // The account owns the secret; the page only ever sees the resulting leaf.
    const derived = await current.account.deriveAspUserLeaf();
    const match = asBigInt(derived) === asBigInt(holder.enrolledLeaf);

    el('derive-out').innerHTML = `
      <dl class="fields">
        <dt>Derived here</dt>
        <dd class="mono-sm ${match ? 'revealed' : ''}">${short(asHex(derived), 14, 10)}</dd>
        <dt>Verdict</dt>
        <dd>${match
          ? '<span class="badge ok">matches the leaf on record</span>'
          : '<span class="badge bad">does not match</span>'}</dd>
      </dl>
      <p class="hint" style="margin-top:12px">${match
        ? `The enrolment standing in the allow-list under ${holder.name} was derived from
           this wallet's own key. Nobody could have enrolled a stranger in their place without
           this check failing. It does not claim the allow-list holds nothing else — the policy
           gate's guarantee is that no leaf is inserted for an address the identity register refuses.`
        : `The leaf on record was not derived from this wallet's key. Either the wallet is
           opened on different keys than the ones enrolled, or the enrolment does not belong
           to this holder — the check exists so the difference is visible.`}</p>`;
    el('derive-progress').textContent = '';
  } catch (error) {
    el('derive-progress').textContent = `failed: ${error?.message ?? error}`;
    console.error(error);
  } finally {
    el('btn-derive').disabled = false;
  }
}

function renderNoteChoices(notes) {
  selectedNote = null;
  el('btn-disclose').disabled = true;

  if (!notes.length) {
    el('disclose-notes').innerHTML = '<p class="hint">No payment to disclose yet.</p>';
    return;
  }

  // Spent notes stay selectable. Disclosing a payment already spent is legitimate —
  // it is why the auditor reports Unspent as a separate fact rather than as validity —
  // and hiding them here contradicted that panel two sections down.
  el('disclose-notes').innerHTML = notes.map((n, i) => `
    <label style="display:flex; gap:10px; align-items:center; padding:7px 0">
      <input type="radio" name="note" value="${i}">
      <span class="mono-sm">${short(n.id, 12, 8)}</span>
      <span class="revealed">${fmt(fromStroops(n.amount))} XLM</span>
      ${n.spent ? '<span class="badge public">spent</span>' : ''}
    </label>`).join('');

  el('disclose-notes').querySelectorAll('input[name=note]').forEach((input) => {
    input.addEventListener('change', () => {
      selectedNote = notes[Number(input.value)];
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
      : `<p class="hint"><span class="badge bad">refused</span> ${explainRefusal(outcome.message)}</p>`;

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
      <p class="hint"><span class="badge bad">refused</span> ${explainRefusal(message)}</p>
      ${frozen ? `<p class="hint" style="margin-top:8px">This is the policy gate. The freeze
        reaches back over payments received before the credential was revoked.</p>` : ''}`;
    setProgress(progressId, '');
    console.error(error);
  } finally {
    stop();
    el(button).disabled = false;
  }
}

/**
 * Validates the stroop value, not the decimal one.
 *
 * `0.00000001` is above zero and rounds to zero stroops, so checking the decimal
 * let it through to the pool, which answered with its own lower-level complaint.
 * The smallest thing this rail can move is one stroop; say so here.
 */
function amountOf(id) {
  const value = Number(el(id).value);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount above zero.');
  const stroops = toStroops(value);
  if (stroops <= 0n) throw new Error('Too small to move — one stroop (0.0000001 XLM) is the minimum.');
  return stroops;
}

/** The pool refuses a single deposit above roughly 100 XLM; #6 is how it says so. */
const explainRefusal = (message) => /Error\(Contract, #6\)/.test(message)
  ? `${message} — the pool caps a single deposit; amounts above ~100 XLM are refused.`
  : message;

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

/**
 * Locks the actions while there is no wallet behind them.
 *
 * Between `current = null` and the account opening there is a live window — a
 * cold start makes it seconds long — where every button is clickable and every
 * handler dereferences null. Derive was the visible symptom: it answered a click
 * with silence, which reads as a dead button rather than as "not ready yet".
 */
function lockActions(locked) {
  for (const id of ['btn-send', 'btn-withdraw', 'btn-deposit', 'btn-derive', 'btn-disclose']) {
    el(id).disabled = locked;
  }
}

async function openWallet(name) {
  // Only the newest switch may publish its result. Opening takes seconds, so two
  // selections overlap easily — and without this the slower one lands last and
  // installs its account behind a selector naming the faster one, which means the
  // next Send signs from a wallet the page is not showing.
  const generation = ++openGeneration;
  const superseded = () => generation !== openGeneration;

  const holder = demo.holders.find((h) => h.name === name);
  el('wallet-pick').value = name;   // the selector names what is opening, from the first statement
  current = null;
  selectedNote = null;

  renderPublic(holder);
  renderEnrolment(holder);
  lockActions(true);          // after renderEnrolment, which re-enables Derive
  el('bal-private').textContent = '—';
  el('activity').innerHTML = '<p class="hint">Opening wallet…</p>';
  setProgress('wallet-progress', 'deriving keys and syncing notes…', 'opening');

  const signer = new LocalSigner(holder.secret, NETWORK_PASSPHRASE);
  const account = await openAccount(holder.address, signer, NETWORK_PASSPHRASE);
  const pool = await openPool(account, demo.rail.pool);
  if (superseded()) return;
  current = { holder, account, pool, notes: [] };
  openHolder = name;

  // Recipients are the rest of the cast; a free-text address still overrides it.
  el('send-to').innerHTML = demo.holders
    .filter((h) => h.name !== name)
    .map((h) => `<option value="${h.address}">${h.name} — ${short(h.address, 6, 4)}</option>`)
    .join('');

  await Promise.all([refresh(), renderReceiveKeys(holder.address)]);
  if (superseded()) return;   // a newer switch owns the buttons and the progress line
  // renderNoteChoices, inside refresh(), owns btn-disclose from here on.
  lockActions(false);
  el('btn-derive').disabled = !holder.enrolledLeaf;
  if (!selectedNote) el('btn-disclose').disabled = true;
  setProgress('wallet-progress', '');
}

async function start() {
  // The runtime takes seconds to come up on a cold start; nothing is clickable
  // until there is a wallet behind it.
  lockActions(true);
  try {
    demo = await loadDemoState();

    // Verification needs no runtime at all, so it is live before the rail is up.
    mountAuditor(demo);

    el('wallet-pick').innerHTML = demo.holders
      .map((h) => `<option value="${h.name}">${h.name}</option>`)
      .join('');

    el('wallet-pick').addEventListener('change', (e) => {
      openWallet(e.target.value).catch((error) => {
        setProgress('wallet-progress', `failed: ${error?.message ?? error}`);
        // Put the selector back on the wallet that is actually open. Leaving it on
        // the one that failed would have the page name a holder it never loaded.
        if (openHolder) el('wallet-pick').value = openHolder;
      });
    });

    el('btn-send').addEventListener('click', send);
    el('btn-withdraw').addEventListener('click', withdraw);
    el('btn-deposit').addEventListener('click', deposit);
    el('btn-disclose').addEventListener('click', generateReceipt);
    el('btn-derive').addEventListener('click', deriveLeaf);

    // The register is read in the background: this page never asked before, so a
    // holder revoked elsewhere kept reading "valid" here for the whole session.
    // Slow enough to not block the wallet, so it repaints when it lands.
    fetchLiveState(demo).then((live) => {
      if (live && current) renderPublic(current.holder);
    });

    await initRuntime(RPC_URL);
    await openWallet(demo.holders[0].name);
  } catch (error) {
    die(error);
  }
}

start();
