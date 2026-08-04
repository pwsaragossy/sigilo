// Verifying-key hashes the auditor checks a receipt against.
//
// These are pinned deliberately. A receipt carries its own `circuit.vkHash`, but
// trusting that would make the check circular — a forged receipt would simply
// name the key that verifies it. The auditor must hold its own copy of what the
// legitimate circuits hash to, and compare.
//
// Provenance: the verifying keys in the rail repository at commit 461c1d0
// (deployments/testnet/circuit_keys/selectiveDisclosure_N_vk.json), which are
// the keys baked into the circuits vendored under vendor/spp-sdk-web/dist.
// Identical to the values the reference app pins, since neither of us re-ran the
// trusted setup — that is a property of the circuits, not of a deployment.

export const CANONICAL_VK_HASHES = {
  selectiveDisclosure_1: '0xdd3c59093d4d75ff72dc63cdc8385d35db8f90f0b66c98c533084bd60c3e456e',
  selectiveDisclosure_2: '0x5b53adca376d68cd3dc83a02ab9113b3f52cffffe329fdb788d6fe983153584d',
  selectiveDisclosure_3: '0x46c216ed017af23d5cdd17ce825ebf3180aa3e26481cd2314720f6bac5a49c62',
  selectiveDisclosure_4: '0xf1346d412fcf9943ccf6774b8648d248918055c68a4d7d9c2a4e417bac5b7cc9',
};

export function expectedVkHash(circuitName) {
  const hash = CANONICAL_VK_HASHES[circuitName];
  if (!hash) throw new Error(`no verifying key on file for circuit ${circuitName}`);
  return hash;
}
