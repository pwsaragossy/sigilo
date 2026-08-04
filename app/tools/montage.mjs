// Turns the captured frames into the submission video.
//
// The frames come from a real run — every proof in them was actually computed, at its
// real cost. Montage adds the captions, which carry the argument since there is no
// narration.
//
// Captions are rendered as images by the same browser that rendered the app, then
// composited with ffmpeg's overlay. This ffmpeg build has no drawtext (no freetype),
// and rendering them as HTML is better anyway: same typography as the interface.
//
// usage: node app/tools/montage.mjs

import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const FRAMES = `${ROOT}/.demo-state/frames`;
const CAPS = `${ROOT}/.demo-state/captions`;
const OUT = `${ROOT}/.demo-state/video`;

const W = 1280, H = 800, BAND = 168;
const PLAY_FPS = 30;

/**
 * Captions, anchored to beats the recorder marked.
 *
 * `[mark, offsetSeconds, durationSeconds, title, subtitle]` — the offset shifts a
 * caption relative to its beat, for the couple of cases where the text should land
 * slightly before or after the screen changes. Anchoring beats guessing: proving takes
 * as long as it takes, and a caption placed by elapsed time describes the wrong screen.
 */
const SCRIPT = [
  ['open',         0, 5, 'Sigilo', 'Confidential coupon payments for tokenized private credit'],
  ['open',         5, 5, 'On a public ledger, every coupon an issuer pays', 'is a published treasury statement'],

  ['act1',         0, 5, 'ACT 1 — The token refuses', 'A permissioned note. Five holders, each KYC-credentialed'],
  ['accepted',     0, 4, 'Issuing to a credentialed holder', 'Accepted'],
  ['act1_revoked', 0, 5, 'The issuer revokes that credential — register only', 'Credential revoked.  Rail still allowed.  Out of step.'],
  ['refused',      0, 6, 'The same issue, refused by the token itself', 'Nothing reached the ledger — refused during simulation'],

  ['act2',         0, 6, 'ACT 2 — The payment nobody can read', 'Five coupons, none proportional to the positions'],
  ['paying',       0, 6, 'Each payment carries its own zero-knowledge proof', 'Real computation — about nine seconds apiece'],
  ['paid',         0, 5, 'Paid. On the explorer: an invoke_host_function call', 'and no amount anywhere in it'],
  ['decrypted',    0, 7, 'The recipient decrypts the figure the issuer computed', 'The position was never secret. The payment always was.'],

  ['gap',          0, 7, 'THE GAP — the credential is gone', 'The rail has not been told. This holder can still spend.'],
  ['frozen',       0, 6, 'Sync — the association sets follow the register', 'Frozen, and retroactively: earlier coupons lock too'],

  ['act3',         0, 5, 'ACT 3 — Proving one payment, and nothing else', 'Hiding payments is easy. Proving one on demand is not.'],
  ['proving',      0, 5, 'The holder proves a single coupon', 'The circuit needs their note key — only they can produce this'],
  ['verified',     0, 7, 'Verified. No wallet, no stored keys, no privileged access', 'Amount proven · reference attested — the line is not blurred'],
  ['tampered',     0, 6, 'One digit of the proof changed', 'Refused — and only the proof check fails'],
  ['tampered',     6, 6, 'Permissioned asset · confidential payments · one policy', 'github.com/pwsaragossy/sigilo'],
];

const { frames: TOTAL, fps: CAPTURE_FPS, marks } = JSON.parse(await readFile(`${FRAMES}/manifest.json`, 'utf8'));
const DURATION = TOTAL / CAPTURE_FPS;

if (!marks) throw new Error('this recording has no beat marks — re-record with the current record.mjs');

await rm(CAPS, { recursive: true, force: true });
await mkdir(CAPS, { recursive: true });
await mkdir(OUT, { recursive: true });

// --- render each caption to a transparent PNG band -------------------------

const page = await (await puppeteer.launch({ headless: true })).newPage();
// Scale factor 1: the overlay composites at native size, and a 2x band would be
// drawn twice as wide as the frame and clipped.
await page.setViewport({ width: W, height: BAND, deviceScaleFactor: 1 });

const captions = SCRIPT.map(([markName, offset, secs, title, sub], i) => {
  const at = marks[markName];
  if (at === undefined) throw new Error(`recording has no mark "${markName}"`);
  const start = at / CAPTURE_FPS + offset;
  return { index: i, start, end: Math.min(start + secs, DURATION), title, sub };
}).filter((c) => c.start < DURATION);

for (const c of captions) {
  await page.setContent(`
    <style>
      @font-face { font-family: mono; src: local('SF Mono'), local('Menlo'); }
      body { margin:0; width:${W}px; height:${BAND}px; background:rgba(10,12,16,0.88);
             display:flex; flex-direction:column; justify-content:center; align-items:center;
             font-family: 'SF Mono', Menlo, ui-monospace, monospace; gap:14px; }
      .t { color:#E8E4DC; font-size:27px; letter-spacing:0.01em; text-align:center; }
      .s { color:#C8963E; font-size:21px; text-align:center; }
    </style>
    <div class="t">${c.title}</div><div class="s">${c.sub}</div>`);
  await page.screenshot({ path: `${CAPS}/${String(c.index).padStart(3, '0')}.png`, omitBackground: true });
}
await page.browser().close();
console.log(`${captions.length} caption bands rendered`);

// --- composite -------------------------------------------------------------

// Each caption is an input overlaid onto the footage for its own window only.
const inputs = ['-framerate', String(CAPTURE_FPS), '-i', `${FRAMES}/%05d.png`];
for (const c of captions) inputs.push('-i', `${CAPS}/${String(c.index).padStart(3, '0')}.png`);

const steps = [`[0:v]scale=${W}:${H},setsar=1[base]`];
captions.forEach((c, i) => {
  const from = i === 0 ? 'base' : `v${i - 1}`;
  const to = i === captions.length - 1 ? 'out' : `v${i}`;
  steps.push(
    `[${from}][${i + 1}:v]overlay=x=0:y=H-h:` +
    `enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[${to}]`,
  );
});

console.log(`compositing ${TOTAL} frames (${DURATION.toFixed(0)}s) with ${captions.length} captions…`);

await run('ffmpeg', [
  '-y', ...inputs,
  '-filter_complex', steps.join(';'),
  '-map', '[out]',
  '-r', String(PLAY_FPS),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
  '-movflags', '+faststart',
  `${OUT}/sigilo.mp4`,
], { maxBuffer: 64 * 1024 * 1024 });

const { stdout } = await run('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration,size',
  '-show_entries', 'stream=width,height', '-of', 'default=nw=1', `${OUT}/sigilo.mp4`,
]);
console.log(stdout.trim());
console.log(`→ ${OUT}/sigilo.mp4`);
