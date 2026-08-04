// Issuing the permissioned token, and being refused by it.
//
// The token asks an identity verifier before it moves. An address with no valid
// KYC claim cannot receive it — not by convention, but because the contract
// refuses. That refusal surfaces during simulation, before a transaction is ever
// built, so there is no failed transaction to point at on an explorer. What
// there is instead is the contract's own error, which is what we show.

import { contract, TransactionBuilder } from '@stellar/stellar-sdk';
import { RPC_URL, NETWORK_PASSPHRASE } from './demo-state.js';

// The token distinguishes two ways of not being credentialed, and the difference
// is worth showing: one address is a stranger, the other is known and no longer
// vouched for. Codes from OpenZeppelin's rwa module.
const REFUSALS = {
  304: 'the registry knows this address, but its claims no longer verify',
  321: 'the registry has no identity on file for this address',
};

export class PolicyRefusal extends Error {
  constructor(address, code) {
    super(REFUSALS[code] ?? 'the identity registry does not vouch for this address');
    this.name = 'PolicyRefusal';
    this.address = address;
    this.code = code;
  }
}

/** Builds a contract client that signs with a demo key rather than a wallet. */
async function tokenClient(contractId, signer) {
  return contract.Client.from({
    contractId,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    publicKey: signer.address,
    signTransaction: (xdr, opts) => signer.signTransaction(xdr, opts),
    signAuthEntry: (entry, opts) => signer.signAuthEntry(entry, opts),
  });
}

/** Returns the refusal code the contract raised, or null for any other failure. */
function refusalCode(error) {
  const text = String(error?.message ?? error);
  for (const code of Object.keys(REFUSALS)) {
    if (text.includes(`Error(Contract, #${code})`)) return Number(code);
  }
  return null;
}

/**
 * Issues tokens to a holder.
 *
 * Resolves with the transaction hash, or throws PolicyRefusal when the recipient
 * holds no valid credential — which is the interesting outcome.
 */
export async function mint({ tokenContract, to, amount, decimals, signer, operator }) {
  const client = await tokenClient(tokenContract, signer);
  const units = BigInt(Math.round(amount * 10 ** decimals));

  try {
    // The refusal can surface either when the call is assembled or when it is
    // sent, depending on where simulation is forced — so both are guarded.
    const tx = await client.mint({ to, amount: units, operator: operator ?? signer.address });
    const sent = await tx.signAndSend();
    return sent?.sendTransactionResponse?.hash ?? sent?.getTransactionResponse?.txHash ?? null;
  } catch (error) {
    const code = refusalCode(error);
    if (code) throw new PolicyRefusal(to, code);
    throw error;
  }
}

export async function balanceOf({ tokenContract, account, signer }) {
  const client = await tokenClient(tokenContract, signer);
  const tx = await client.balance({ account });
  return tx.result;
}

export { TransactionBuilder };
