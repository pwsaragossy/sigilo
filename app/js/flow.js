// The lifecycle bar: where a coupon is, and which system is answering.
//
// The bar exists because the interesting thing about this system is invisible in a
// table — that two separate systems are being asked two different questions, and
// that they can disagree. Step 2 is the bridge, and it is the only one that can be
// lit and broken at the same time.

const STEPS = ['credential', 'policy', 'pay', 'receive', 'prove'];

const li = (step) => document.querySelector(`.flow li[data-step="${step}"]`);
const say = () => document.getElementById('flow-say');

/**
 * One sentence per step, in the vocabulary the docs use: identity register,
 * confidential pool, policy gate. Not decoration — a demo where nobody is
 * narrating still has to say what just happened, and the `broken` line is the
 * whole argument of this project arriving at the moment the eye sees red.
 */
const NARRATION = {
  credential: 'The issuer decides who may hold this asset. That decision lives in the identity register.',
  policy: 'The policy gate reads the register and moves the allow-list to match it.',
  pay: 'Coupons paid into the confidential pool. Each carries its own proof — no amount is readable on-chain.',
  receive: "Only this holder's key opens the payment addressed to them.",
  prove: 'The holder proves one payment to an auditor, and nothing else.',
  broken: 'The identity register revoked this holder. The confidential pool has not been told — coupons already inside are still spendable.',
};

/** The broken state outranks any step: while it holds, it is the only thing worth reading. */
function narrate(key) {
  const el = say();
  if (!el || !NARRATION[key]) return;
  if (el.dataset.locked === 'true' && key !== 'broken') return;
  el.textContent = NARRATION[key];
  el.toggleAttribute('data-broken', key === 'broken');
  el.dataset.locked = String(key === 'broken');
}

/**
 * Marks the step happening now.
 *
 * Deliberately does *not* infer that earlier steps are done. Reaching step 4 does not
 * prove step 3 happened — the holder may be opening a wallet that was funded in a
 * previous run. Only the code that actually completes a step calls `done()`, so the
 * bar never claims something the system has not observed.
 */
export function at(step) {
  STEPS.forEach((s) => li(s)?.toggleAttribute('data-active', s === step));
  narrate(step);
}

export function done(step) {
  li(step)?.setAttribute('data-done', '');
}

/**
 * The bridge step turns red when the register and the rail disagree — the one
 * state in this app worth interrupting the eye for.
 */
export function bridgeOutOfStep(broken) {
  const el = li('policy');
  if (!el) return;
  el.toggleAttribute('data-broken', broken);
  if (broken) {
    el.removeAttribute('data-done');
    narrate('broken');
  } else if (say()?.dataset.locked === 'true') {
    // The disagreement is over; release the line back to whatever step is lit.
    say().dataset.locked = 'false';
    narrate(STEPS.find((s) => li(s)?.hasAttribute('data-active')) ?? 'policy');
  }
}

/**
 * Reflects live policy state, which is read from the chain rather than assumed.
 *
 * Credentials existing and the two systems agreeing are both observable facts, so
 * these two steps can be marked from state. The rest are marked by the code that
 * performs them.
 */
export function reflectPolicy(holders) {
  const everyoneCredentialed = holders.every((h) => h.credentialValid);
  const outOfStep = holders.some((h) => h.credentialValid === h.railBlocked);

  bridgeOutOfStep(outOfStep);
  if (everyoneCredentialed) done('credential');
  if (!outOfStep) done('policy');
}
