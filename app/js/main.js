// Page bootstrap and role switching.

import { loadDemoState, RPC_URL } from './demo-state.js';
import { initRuntime, isDbLocked, resetLocalDatabase } from './sdk-facade.js';
import { mountIssuer } from './issuer.js';
import { mountInvestor } from './investor.js';
import { mountAuditor } from './auditor.js';
import * as flow from './flow.js';

const fatal = document.getElementById('fatal');

function die(error) {
  fatal.hidden = false;
  fatal.textContent = isDbLocked(error)
    ? 'Another tab has this demo open. The confidential payment SDK keeps one exclusive local database, so close the other tab and reload.'
    : `Could not start: ${error?.message ?? error}`;
  console.error(error);
}

function wireTabs() {
  const tabs = [...document.querySelectorAll('.roles button')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        const active = other === tab;
        other.setAttribute('aria-selected', String(active));
        document.getElementById(`panel-${other.dataset.role}`).hidden = !active;
      }
    });
  }
}

async function start() {
  // Wired first and never disabled: the reason to reach for it is usually that
  // the page did not come up.
  document.getElementById('btn-reset-cache')
    .addEventListener('click', resetLocalDatabase);

  wireTabs();
  // The bar opens with a "you are here", not five dim words: the cycle starts
  // where every holder's story starts, at the credential.
  flow.at('credential');

  try {
    const demo = await loadDemoState();

    // The auditor needs no runtime at all — verification is walletless and
    // storageless — so it is mounted before the rail is even up.
    mountAuditor(demo);

    await initRuntime(RPC_URL);
    await Promise.all([mountIssuer(demo), mountInvestor(demo)]);
  } catch (error) {
    die(error);
  }
}

start();
