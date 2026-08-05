// The lifecycle bar: where a coupon is, and which system is answering.
//
// The bar exists because the interesting thing about this system is invisible in a
// table — that two separate systems are being asked two different questions, and
// that they can disagree. Step 2 is the bridge, and it is the only one that can be
// lit and broken at the same time.

const STEPS = ['credential', 'policy', 'pay', 'receive', 'prove'];

const li = (step) => document.querySelector(`.flow li[data-step="${step}"]`);

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
  if (broken) el.removeAttribute('data-done');
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
