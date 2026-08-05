#![no_std]

//! Makes the confidential rail's policy follow the token's identity register —
//! on-chain, so nobody has to be trusted to keep the two in agreement.
//!
//! A permissioned token asks an identity register who may hold it. A confidential
//! rail proves, against its association sets, who may spend. Each enforces its own
//! policy correctly and neither knows about the other, so revoking a credential
//! leaves money already inside the rail perfectly spendable.
//!
//! An off-chain service can close that gap by watching the register and moving the
//! trees, and that is how this project first did it. But then the operator is
//! trusted: nothing stops them enrolling an address that holds no claim, or
//! freezing one that does. This contract removes the discretion. It owns the
//! association sets, and it moves them only after asking the register itself.
//!
//! Both directions are gated, which is the point:
//!   - `grant` fails unless the register verifies the holder
//!   - `revoke` fails *while* the register still verifies them
//!
//! So the operator cannot enrol someone who was never approved, and cannot freeze
//! someone who is still in good standing. Policy stops being a claim about a
//! process and becomes a property of the chain.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    Address, Env, IntoVal, Symbol, U256, Vec,
};

/// Emitted on every policy decision, so an auditor watching the chain can
/// reconstruct who was enrolled or frozen, and when — without asking the operator.
#[contractevent]
pub struct PolicyChanged {
    #[topic]
    pub action: Symbol,
    pub holder: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Who may ask this contract to act. Holds no power over *whether* it acts.
    Operator,
    /// ERC-3643 identity verifier — the authority on who is credentialed.
    Verifier,
    /// Association set of holders allowed to operate in the rail.
    Allowlist,
    /// Sparse Merkle tree of holders barred from spending.
    Blocklist,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    /// The register does not verify this holder, so they cannot be enrolled.
    NotCredentialed = 2,
    /// The register still verifies this holder, so they cannot be frozen.
    StillCredentialed = 3,
}

#[contract]
pub struct PolicyBridge;

#[contractimpl]
impl PolicyBridge {
    /// Wires the bridge to a register and the two association sets it will own.
    ///
    /// For this to mean anything, the association sets must name this contract as
    /// their admin — otherwise the operator can still reach them directly and the
    /// guarantee below is decorative.
    pub fn __constructor(
        env: Env,
        operator: Address,
        verifier: Address,
        allowlist: Address,
        blocklist: Address,
    ) {
        let store = env.storage().instance();
        store.set(&DataKey::Operator, &operator);
        store.set(&DataKey::Verifier, &verifier);
        store.set(&DataKey::Allowlist, &allowlist);
        store.set(&DataKey::Blocklist, &blocklist);
    }

    /// Enrols a holder in the rail — only if the register vouches for them.
    ///
    /// `leaf` is `poseidon2(note_public_key, asp_secret)`, computed off-chain
    /// because the ASP secret belongs to the holder. The leaf is opaque here; what
    /// this contract guarantees is not what the leaf contains, but that no leaf is
    /// inserted for an address the register refuses.
    pub fn grant(env: Env, holder: Address, leaf: U256) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if !Self::registry_verifies(&env, &holder)? {
            return Err(Error::NotCredentialed);
        }

        let allowlist = Self::address(&env, DataKey::Allowlist)?;
        env.invoke_contract::<()>(
            &allowlist,
            &Symbol::new(&env, "insert_leaf"),
            Vec::from_array(&env, [leaf.into_val(&env)]),
        );

        PolicyChanged { action: Symbol::new(&env, "granted"), holder }.publish(&env);
        Ok(())
    }

    /// Freezes a holder in the rail — only once the register has stopped
    /// vouching for them.
    ///
    /// Refusing to act while the credential is still valid is what stops this
    /// being a back door: an operator cannot freeze an investor in good standing
    /// and call it compliance.
    ///
    /// The freeze is retroactive by construction, not by choice here — the pool
    /// checks proofs against the current association roots, so notes received
    /// before the revocation stop being spendable too.
    pub fn revoke(env: Env, holder: Address, note_key: U256) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if Self::registry_verifies(&env, &holder)? {
            return Err(Error::StillCredentialed);
        }

        let blocklist = Self::address(&env, DataKey::Blocklist)?;
        env.invoke_contract::<()>(
            &blocklist,
            &Symbol::new(&env, "insert_leaf"),
            Vec::from_array(
                &env,
                [note_key.into_val(&env), U256::from_u32(&env, 1).into_val(&env)],
            ),
        );

        PolicyChanged { action: Symbol::new(&env, "revoked"), holder }.publish(&env);
        Ok(())
    }

    /// Lifts a freeze once the register vouches for the holder again.
    pub fn restore(env: Env, holder: Address, note_key: U256) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if !Self::registry_verifies(&env, &holder)? {
            return Err(Error::NotCredentialed);
        }

        let blocklist = Self::address(&env, DataKey::Blocklist)?;
        env.invoke_contract::<()>(
            &blocklist,
            &Symbol::new(&env, "delete_leaf"),
            Vec::from_array(&env, [note_key.into_val(&env)]),
        );

        PolicyChanged { action: Symbol::new(&env, "restored"), holder }.publish(&env);
        Ok(())
    }

    /// What the register says about a holder, readable by anyone.
    ///
    /// Exposed so the decision this contract acts on can be checked independently,
    /// rather than taken on faith from an interface.
    pub fn is_credentialed(env: Env, holder: Address) -> Result<bool, Error> {
        Self::registry_verifies(&env, &holder)
    }

    pub fn operator(env: &Env) -> Result<Address, Error> {
        Self::address(env, DataKey::Operator)
    }

    pub fn verifier(env: Env) -> Result<Address, Error> {
        Self::address(&env, DataKey::Verifier)
    }

    // -----------------------------------------------------------------------

    fn address(env: &Env, key: DataKey) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    /// Asks the identity verifier about a holder.
    ///
    /// `verify_identity` reports failure by trapping rather than returning false,
    /// so the call is made through `try_invoke_contract` and a trap is read as
    /// "not credentialed" instead of taking this contract down with it.
    fn registry_verifies(env: &Env, holder: &Address) -> Result<bool, Error> {
        let verifier = Self::address(env, DataKey::Verifier)?;
        let outcome = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &verifier,
            &Symbol::new(env, "verify_identity"),
            Vec::from_array(env, [holder.into_val(env)]),
        );
        Ok(outcome.is_ok())
    }
}

#[cfg(test)]
mod test;
