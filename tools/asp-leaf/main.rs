//! Derive the association-set leaf for a rail participant.
//!
//! The leaf is `poseidon2(note_public_key, asp_secret, domain=1)` — the same
//! computation the pool's policy circuits perform on the spender's key. The
//! policy bridge needs it to enrol a holder into the allowlist.
//!
//! Built as an example inside the stellar-private-payments workspace because it
//! needs that crate's Poseidon2 implementation; `scripts/policy-bridge.sh` stages
//! it there. Prints a decimal U256, ready for `stellar contract invoke`.
//!
//! usage: asp-leaf <note_public_key_hex> <asp_secret_hex>

use std::str::FromStr;

use prover::crypto::asp_membership_leaf;
use types::{Field, NotePublicKey};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: asp-leaf <note_public_key_hex> <asp_secret_hex>");
        std::process::exit(2);
    }

    let leaf = asp_membership_leaf(
        &NotePublicKey::parse(&args[1])?,
        &Field::from_str(&args[2])?,
    )?;

    // Field renders as big-endian hex, but the contracts read U256 keys as
    // little-endian — a big-endian value overflows the BN254 prime and traps.
    let le = leaf.to_le_bytes();
    println!("{}", u256_decimal(&le));
    Ok(())
}

/// Decimal representation of a little-endian 32-byte value.
fn u256_decimal(le: &[u8; 32]) -> String {
    let mut digits = vec![0u32]; // base 1e9, least significant first
    for byte in le.iter().rev() {
        let mut carry = *byte as u64;
        for d in digits.iter_mut() {
            let v = (*d as u64) * 256 + carry;
            *d = (v % 1_000_000_000) as u32;
            carry = v / 1_000_000_000;
        }
        while carry > 0 {
            digits.push((carry % 1_000_000_000) as u32);
            carry /= 1_000_000_000;
        }
    }
    let mut out = digits.pop().unwrap().to_string();
    while let Some(d) = digits.pop() {
        out.push_str(&format!("{d:09}"));
    }
    out
}
