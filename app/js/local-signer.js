// A signer backed by a local demo key, in place of a browser wallet.
//
// The rail's signer contract is duck-typed — three methods, checked by presence
// (sdk/web/src/signer.rs). Freighter is only the default; anything with the same
// shape works. For a recorded demo that is the difference between one click and
// five extension popups plus an account switch on camera.
//
// The message-signing scheme has to match the CLI's SEP-53 exactly, or the keys
// derived here address a different wallet than the one holding the coupons.
// tools/key-gate.mjs proves the two agree.

import { Keypair, hash, TransactionBuilder } from '@stellar/stellar-sdk';

const SEP53_PREFIX = new TextEncoder().encode('Stellar Signed Message:\n');

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class LocalSigner {
  /**
   * @param {string} secretKey  S… seed for this role
   * @param {string} networkPassphrase
   */
  constructor(secretKey, networkPassphrase) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = networkPassphrase;
  }

  get address() {
    return this.keypair.publicKey();
  }

  getPublicKey() {
    return this.keypair.publicKey();
  }

  /**
   * Signs the key-derivation message. Called once per address, the first time
   * an account is opened; the rail hashes the result into note and encryption
   * keys, so the bytes must be reproducible — never random.
   */
  async signMessage(message) {
    const payload = concat(SEP53_PREFIX, new TextEncoder().encode(message));
    const signature = this.keypair.sign(hash(payload));
    return { signedMessage: toBase64(new Uint8Array(signature)) };
  }

  /**
   * Signs a Soroban authorization entry: Ed25519 over the SHA-256 of the
   * HashIdPreimage XDR, matching sdk/stellar/src/signer.rs.
   */
  async signAuthEntry(preimageBase64) {
    const signature = this.keypair.sign(hash(fromBase64(preimageBase64)));
    return { signedAuthEntry: toBase64(new Uint8Array(signature)) };
  }

  /** Signs the assembled transaction envelope. */
  async signTransaction(xdr, opts = {}) {
    const passphrase = opts.networkPassphrase ?? this.networkPassphrase;
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(this.keypair);
    return { signedTxXdr: tx.toXDR() };
  }
}
