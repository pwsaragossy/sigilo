// Drives the demo and captures it, frame by frame.
//
// The three acts run against the live testnet — the proofs in the recording are
// real proofs, taking their real ~9 and ~13 seconds. Frames are captured
// continuously while that happens, so the montage can either show the wait or
// cut it, without ever faking a result.
//
// usage: node app/tools/record.mjs [act1|act2|act3|all]

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = resolve(HERE, '../../.demo-state/frames');
const URL = 'http://localhost:8080/app/index.html';
const FPS = 4;

let frame = 0;
const marks = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Records which frame a beat starts on.
 *
 * Captions are anchored to these rather than to elapsed time. Proving takes as long
 * as it takes, and a caption placed by guesswork ends up describing the wrong screen —
 * which is worse than no caption at all.
 */
function mark(name) {
  marks[name] = frame;
}

async function shoot(page) {
  await page.screenshot({ path: `${FRAMES}/${String(frame++).padStart(5, '0')}.png` });
}

// Screenshots and evaluations share one CDP session, so they are interleaved in
// a single loop rather than run concurrently — overlapping them detaches the frame.

/** Holds the current state on screen for `seconds`, so a beat can be read. */
async function hold(page, seconds) {
  for (let i = 0; i < seconds * FPS; i++) {
    await shoot(page);
    await sleep(1000 / FPS);
  }
}

const $ = (page, sel) => page.waitForSelector(sel, { timeout: 60_000 });

async function click(page, sel) {
  const el = await $(page, sel);
  await el.click();
}

/**
 * Picks a holder and confirms it stuck.
 *
 * The issuer view re-renders its dropdowns when live policy state arrives, which
 * silently resets a selection made too early. A take where the wrong holder is
 * selected records the opposite of what the caption says, so this asserts.
 */
async function selectHolder(page, sel, name) {
  await page.evaluate((s, n) => {
    const el = document.querySelector(s);
    el.value = n;
    el.dispatchEvent(new Event('change'));
  }, sel, name);

  const got = await page.$eval(sel, (el) => el.value);
  if (got !== name) throw new Error(`selection did not stick: wanted ${name}, got ${got}`);
}

/** Fails the take rather than recording a scene that contradicts its caption. */
async function assertScene(page, description, predicate) {
  const ok = await page.evaluate(predicate);
  if (!ok) throw new Error(`scene check failed — ${description}`);
}

/** Waits for a condition, capturing frames throughout the wait. */
async function waitCapturing(page, predicate, timeoutMs = 180_000) {
  const started = Date.now();
  let consecutiveFailures = 0;

  while (Date.now() - started < timeoutMs) {
    let done = false;
    try {
      done = await page.evaluate(predicate);
      consecutiveFailures = 0;
    } catch (error) {
      // One transient failure is noise. A run of them means the page is gone,
      // and continuing would silently record a frozen screen for three minutes.
      if (++consecutiveFailures >= 5) {
        throw new Error(`page stopped responding: ${error.message}`);
      }
    }
    if (done) return true;
    await shoot(page).catch(() => {});
    await sleep(1000 / FPS);
  }
  throw new Error('timed out waiting for the page to reach the expected state');
}

// ---------------------------------------------------------------------------

async function act1(page) {
  console.log('act 1 — the token refuses');
  mark('open');
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(page, 3);

  mark('act1');
  await assertScene(page, 'inv3 starts credentialed', () =>
    document.querySelector('[data-holder="inv3"]').cells[3].textContent.includes('valid'));

  // Issue to a credentialed holder: accepted.
  await selectHolder(page, '#mint-to', 'inv3');
  await page.evaluate(() => document.getElementById('mint-to').scrollIntoView({ block: 'center' }));
  await hold(page, 2);
  await click(page, '#btn-mint');
  await waitCapturing(page, () => document.getElementById('mint-out').textContent.trim().length > 0);
  mark('accepted');
  await assertScene(page, 'the issue was accepted', () =>
    document.getElementById('mint-out').textContent.includes('accepted'));
  await hold(page, 3);

  // Revoke that holder's credential — register only.
  await page.evaluate(() => document.querySelector('[data-holder="inv3"]').scrollIntoView({ block: 'center' }));
  await hold(page, 2);
  await click(page, '[data-revoke="inv3"]');
  await waitCapturing(page, () =>
    /register updated|failed/.test(document.getElementById('sync-progress').textContent));
  mark('act1_revoked');
  await assertScene(page, 'inv3 is revoked in the register but still allowed on the rail', () => {
    const row = document.querySelector('[data-holder="inv3"]');
    return row.cells[3].textContent.includes('revoked') && row.cells[4].textContent.includes('allowed');
  });
  await hold(page, 4);   // the "out of step — sync" row is the point

  // Same issue, now refused by the contract.
  await page.evaluate(() => { document.getElementById('mint-out').innerHTML = ''; });
  await selectHolder(page, '#mint-to', 'inv3');
  await page.evaluate(() => document.getElementById('mint-to').scrollIntoView({ block: 'center' }));
  await hold(page, 2);
  await click(page, '#btn-mint');
  await waitCapturing(page, () => document.getElementById('mint-out').textContent.trim().length > 0);
  mark('refused');
  await assertScene(page, 'the issue was refused by the token', () =>
    document.getElementById('mint-out').textContent.includes('Refused by the token'));
  await hold(page, 5);
}

async function act2(page) {
  console.log('act 2 — the payment nobody can read');

  // Restore and sync, so the cycle pays everyone.
  await page.evaluate(() => document.querySelector('[data-holder="inv3"]').scrollIntoView({ block: 'center' }));
  await click(page, '[data-revoke="inv3"]');
  await waitCapturing(page, () =>
    /register updated|failed/.test(document.getElementById('sync-progress').textContent));
  await click(page, '#btn-sync');
  await waitCapturing(page, () =>
    /applied|already match|failed/.test(document.getElementById('sync-progress').textContent));
  await hold(page, 3);

  // The coupon table: amounts that are not proportional to positions.
  mark('act2');
  await page.evaluate(() => document.getElementById('coupon-table').scrollIntoView({ block: 'center' }));
  await hold(page, 5);

  // Pay all five. ~75s of real proving.
  mark('paying');
  await click(page, '#btn-pay');
  await waitCapturing(page, () =>
    /paid — no amount readable|failed/.test(document.getElementById('pay-progress').textContent), 300_000);
  mark('paid');
  await assertScene(page, 'all five coupons were paid', () =>
    [...document.querySelectorAll('#coupon-table tbody tr')]
      .every((r) => r.cells[4].textContent.includes('paid')));
  await hold(page, 4);

  // The recipient's side: same number, decrypted locally.
  await click(page, '.roles button[data-role=investor]');
  await hold(page, 2);
  await selectHolder(page, '#investor-pick', 'inv4');
  await waitCapturing(page, () =>
    !document.getElementById('investor-private').textContent.includes('Opening'));
  mark('decrypted');
  await assertScene(page, 'inv4 decrypted their coupon', () =>
    /\d/.test(document.getElementById('investor-private').textContent) &&
    document.getElementById('investor-private').textContent.includes('decrypted locally'));
  await hold(page, 6);   // the public-vs-private contrast

  // The bridge beat: revoke, and watch the rail lag behind.
  await click(page, '.roles button[data-role=issuer]');
  await page.evaluate(() => document.querySelector('[data-holder="inv5"]').scrollIntoView({ block: 'center' }));
  await hold(page, 2);
  await click(page, '[data-revoke="inv5"]');
  await waitCapturing(page, () =>
    /register updated|failed/.test(document.getElementById('sync-progress').textContent));
  mark('gap');
  await assertScene(page, 'the register and the rail disagree', () => {
    const row = document.querySelector('[data-holder="inv5"]');
    return row.cells[3].textContent.includes('revoked') &&
           row.cells[4].textContent.includes('allowed') &&
           row.cells[4].textContent.includes('out of step');
  });
  await hold(page, 6);   // REVOKED / ALLOWED / out of step — the gap

  await click(page, '#btn-sync');
  await waitCapturing(page, () =>
    /applied|already match|failed/.test(document.getElementById('sync-progress').textContent));
  mark('frozen');
  await assertScene(page, 'the rail now agrees — inv5 is frozen', () =>
    document.querySelector('[data-holder="inv5"]').cells[4].textContent.includes('frozen'));
  await hold(page, 5);   // now FROZEN
}

async function act3(page) {
  console.log('act 3 — proving one payment');
  mark('act3');

  await click(page, '.roles button[data-role=investor]');
  await selectHolder(page, '#investor-pick', 'inv2');
  await waitCapturing(page, () => !!document.querySelector('#disclose-notes input[name=note]'));
  await page.evaluate(() => document.getElementById('disclose-notes').scrollIntoView({ block: 'center' }));
  await hold(page, 3);

  await click(page, '#disclose-notes input[name=note]');
  await hold(page, 2);
  mark('proving');
  await click(page, '#btn-disclose');
  await waitCapturing(page, () => !!document.getElementById('receipt-out'));
  await hold(page, 4);

  await click(page, '#btn-to-auditor');
  await hold(page, 3);
  await click(page, '#btn-verify');
  await waitCapturing(page, () =>
    /^\s*(Verified|Refused)/.test(document.getElementById('verify-out').textContent.trim()));
  mark('verified');
  await assertScene(page, 'the genuine receipt verified', () =>
    /^\s*Verified/.test(document.getElementById('verify-out').textContent.trim()));
  await page.evaluate(() => document.getElementById('verify-out').scrollIntoView({ block: 'start' }));
  await hold(page, 7);   // the verdict and the proven/attested labels

  // The refusal is as much the demonstration as the pass.
  await page.evaluate(() => document.getElementById('btn-tamper').scrollIntoView({ block: 'center' }));
  await click(page, '#btn-tamper');
  await hold(page, 3);
  await click(page, '#btn-verify');
  await waitCapturing(page, () =>
    /^\s*Refused/.test(document.getElementById('verify-out').textContent.trim()));
  mark('tampered');
  await assertScene(page, 'the tampered receipt was refused, and only the proof check failed', () => {
    const t = document.getElementById('verify-out').textContent;
    return /^\s*Refused/.test(t.trim()) && t.includes('no');
  });
  await page.evaluate(() => document.getElementById('verify-out').scrollIntoView({ block: 'start' }));
  await hold(page, 6);
}

// ---------------------------------------------------------------------------

const which = process.argv[2] ?? 'all';

await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,             // OPFS and the workers want a real browser profile
  defaultViewport: { width: 1280, height: 800 },
  args: [
    '--window-size=1300,900',
    '--hide-scrollbars',
    // A recording runs for minutes with the window unattended in the background.
    // Chrome would otherwise throttle or discard the renderer partway through,
    // which detaches the frame and takes the take with it.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});

const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  page error:', m.text()); });

await page.goto(URL, { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => document.querySelectorAll('#issuer-holders tbody tr').length === 5,
  { timeout: 60_000 },
);
await sleep(2000);

const acts = { act1, act2, act3 };
for (const [name, fn] of Object.entries(acts)) {
  if (which === 'all' || which === name) await fn(page);
}

await browser.close();
await writeFile(
  `${FRAMES}/manifest.json`,
  JSON.stringify({ frames: frame, fps: FPS, marks }, null, 2),
);
console.log(`\n${frame} frames at ${FPS}fps → ${FRAMES}`);
console.log('marks:', Object.entries(marks).map(([k, v]) => `${k}@${v}`).join(' '));
