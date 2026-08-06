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
//! The gate alone is not enough, and the first version of this contract learned
//! that the hard way. `revoke` took the note key to freeze as an argument, so an
//! operator could satisfy the gate with an uncredentialed decoy address and hand
//! it a *credentialed* holder's key. The gate was checked against one party and
//! the tree moved against another. What closes it is [`Enrolment`]: the key a
//! holder is frozen by is the key recorded when the register approved them, it is
//! read from storage rather than accepted from the caller, and no two holders can
//! claim the same one. So an operator cannot enrol someone who was never approved,
//! and cannot freeze someone still in good standing — `revoke` has no argument
//! with which to name them.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    xdr::ScErrorType, Address, Env, IntoVal, Symbol, U256, Vec,
};

/// Emitted on every policy decision, so an auditor watching the chain can
/// reconstruct who was enrolled or frozen, and when — without asking the operator.
///
/// The keys are named, not just the holder. Without them an auditor sees *that*
/// someone was frozen but not *which key moved*, which is precisely the
/// substitution this contract now prevents — and a guarantee nobody can check
/// from the chain is a guarantee nobody has.
#[contractevent]
pub struct PolicyChanged {
    #[topic]
    pub action: Symbol,
    #[topic]
    pub holder: Address,
    pub leaf: U256,
    pub note_key: U256,
}

/// What the register approved for a holder, recorded at `grant`.
///
/// `leaf` goes into the allowlist; `note_key` is what the blocklist is keyed by.
/// They are different values in different keyspaces — the leaf is
/// `poseidon2(note_public_key, asp_secret)`, the note key is the note public key
/// itself — and conflating them is a mistake this contract used to make possible.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Enrolment {
    pub leaf: U256,
    pub note_key: U256,
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
    /// What the register approved for this holder. Persistent, not instance:
    /// instance storage is a single blob and holders are unbounded.
    Enrolment(Address),
    /// Which holder a note key belongs to.
    ///
    /// Binding the holder to the key is not enough on its own — the binding has
    /// to be exclusive. Without this index an operator could bind a victim's
    /// (public) note key to a decoy address they credential themselves, drop the
    /// decoy's claim, and revoke the decoy: every register check passes and the
    /// victim freezes. First binder wins, and a second claimant is refused.
    NoteKeyOwner(U256),
}

/// Roughly 30 and 90 days at five-second ledgers. An archived enrolment is a
/// freeze that cannot be applied or lifted, so every entrypoint that touches one
/// bumps it.
const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND: u32 = 1_555_200;

/// The codes the register uses to say "no": this holder's claims do not verify
/// (`IdentityVerificationFailed`), or the register holds no identity for them at
/// all (`IdentityNotFound`).
///
/// Every other trap is not an answer. A verifier whose storage was never set
/// (#310–#312), an archived sub-contract, a budget blowout — reading any of those
/// as "not credentialed" is a second way to manufacture a freeze, and it is the
/// same rule `scripts/policy-bridge.sh` already applies off-chain.
const REFUSALS: [u32; 2] = [304, 321];

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    /// The register does not verify this holder, so they cannot be enrolled.
    NotCredentialed = 2,
    /// The register still verifies this holder, so they cannot be frozen.
    StillCredentialed = 3,
    /// No enrolment on record, so there is no key this contract may move.
    NotEnrolled = 4,
    /// Already enrolled under different keys. Enrolment is write-once.
    AlreadyEnrolled = 5,
    /// The register did not answer. Refused in both directions rather than
    /// guessed at, because a silent register is not a compliance decision.
    VerifierUnavailable = 6,
    /// That note key already belongs to another holder.
    NoteKeyBound = 7,
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
    ///
    /// `note_key` is recorded rather than acted on. It is the key `revoke` will
    /// later use, and fixing it here — while the register is vouching for this
    /// holder — is what stops it being chosen later, when they are not.
    ///
    /// Re-granting the same pair is deliberately harmless: the allowlist tree is
    /// append-only with no membership query, so `scripts/policy-bridge.sh sync`
    /// finds out a leaf is already present by proposing it again.
    pub fn grant(env: Env, holder: Address, leaf: U256, note_key: U256) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if !Self::registry_verifies(&env, &holder)? {
            return Err(Error::NotCredentialed);
        }

        let store = env.storage().persistent();
        let enrolment_key = DataKey::Enrolment(holder.clone());
        let owner_key = DataKey::NoteKeyOwner(note_key.clone());

        if let Some(on_record) = store.get::<_, Enrolment>(&enrolment_key) {
            if on_record.leaf != leaf || on_record.note_key != note_key {
                return Err(Error::AlreadyEnrolled);
            }
            // Already enrolled under exactly these keys. Nothing changes, so
            // nothing is inserted and nothing is announced.
            store.extend_ttl(&enrolment_key, TTL_THRESHOLD, TTL_EXTEND);
            store.extend_ttl(&owner_key, TTL_THRESHOLD, TTL_EXTEND);
            return Ok(());
        }

        // This holder has no enrolment, so any existing owner of the key is
        // somebody else — which is the substitution, arriving early.
        if store.has(&owner_key) {
            return Err(Error::NoteKeyBound);
        }

        store.set(&enrolment_key, &Enrolment { leaf: leaf.clone(), note_key: note_key.clone() });
        store.set(&owner_key, &holder);
        store.extend_ttl(&enrolment_key, TTL_THRESHOLD, TTL_EXTEND);
        store.extend_ttl(&owner_key, TTL_THRESHOLD, TTL_EXTEND);

        let allowlist = Self::address(&env, DataKey::Allowlist)?;
        env.invoke_contract::<()>(
            &allowlist,
            &Symbol::new(&env, "insert_leaf"),
            Vec::from_array(&env, [leaf.clone().into_val(&env)]),
        );

        PolicyChanged { action: Symbol::new(&env, "granted"), holder, leaf, note_key }
            .publish(&env);
        Ok(())
    }

    /// Freezes a holder in the rail — only once the register has stopped
    /// vouching for them.
    ///
    /// Refusing to act while the credential is still valid is what stops this
    /// being a back door, and taking no key is what stops the refusal being
    /// sidestepped: the key frozen is [`Enrolment::note_key`], written when the
    /// register approved this holder and owned by no one else. An operator cannot
    /// freeze an investor in good standing, because there is no argument here
    /// with which to name one — a decoy holder freezes only the decoy's key, and
    /// binding a victim's key to a decoy is refused at `grant` with
    /// [`Error::NoteKeyBound`].
    ///
    /// The freeze is retroactive by construction, not by choice here — the pool
    /// checks proofs against the current association roots, so notes received
    /// before the revocation stop being spendable too.
    pub fn revoke(env: Env, holder: Address) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if Self::registry_verifies(&env, &holder)? {
            return Err(Error::StillCredentialed);
        }

        let on_record = Self::enrolment_of(&env, &holder)?;

        let blocklist = Self::address(&env, DataKey::Blocklist)?;
        env.invoke_contract::<()>(
            &blocklist,
            &Symbol::new(&env, "insert_leaf"),
            Vec::from_array(
                &env,
                [
                    on_record.note_key.clone().into_val(&env),
                    U256::from_u32(&env, 1).into_val(&env),
                ],
            ),
        );

        PolicyChanged {
            action: Symbol::new(&env, "revoked"),
            holder,
            leaf: on_record.leaf,
            note_key: on_record.note_key,
        }
        .publish(&env);
        Ok(())
    }

    /// Lifts a freeze once the register vouches for the holder again.
    ///
    /// Symmetrical with `revoke`, and for the same reason: the key unfrozen is
    /// the one on record, so an operator cannot lift a freeze off a key that was
    /// never theirs to freeze.
    pub fn restore(env: Env, holder: Address) -> Result<(), Error> {
        Self::operator(&env)?.require_auth();

        if !Self::registry_verifies(&env, &holder)? {
            return Err(Error::NotCredentialed);
        }

        let on_record = Self::enrolment_of(&env, &holder)?;

        let blocklist = Self::address(&env, DataKey::Blocklist)?;
        env.invoke_contract::<()>(
            &blocklist,
            &Symbol::new(&env, "delete_leaf"),
            Vec::from_array(&env, [on_record.note_key.clone().into_val(&env)]),
        );

        PolicyChanged {
            action: Symbol::new(&env, "restored"),
            holder,
            leaf: on_record.leaf,
            note_key: on_record.note_key,
        }
        .publish(&env);
        Ok(())
    }

    /// What this contract has on record for a holder, readable by anyone.
    ///
    /// Exposed so the binding `revoke` acts on can be checked against the chain
    /// rather than against whatever the operator's own files happen to say.
    pub fn enrolment(env: Env, holder: Address) -> Result<Enrolment, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Enrolment(holder))
            .ok_or(Error::NotEnrolled)
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

    /// Loads a holder's enrolment and bumps it, because the paths that read one
    /// are the paths that must not fail for want of rent.
    fn enrolment_of(env: &Env, holder: &Address) -> Result<Enrolment, Error> {
        let store = env.storage().persistent();
        let key = DataKey::Enrolment(holder.clone());
        let on_record: Enrolment = store.get(&key).ok_or(Error::NotEnrolled)?;
        store.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        store.extend_ttl(
            &DataKey::NoteKeyOwner(on_record.note_key.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        Ok(on_record)
    }

    /// Asks the identity verifier about a holder.
    ///
    /// `verify_identity` reports failure by trapping rather than returning false,
    /// so the call is made through `try_invoke_contract`. But not every trap is a
    /// refusal, and the first version of this read them all as one: `outcome.is_ok()`
    /// meant a verifier that was unreachable, misconfigured or out of budget
    /// answered "not credentialed" — which `grant` treats as a reason to refuse,
    /// and `revoke` treats as permission to act. Fail-closed one way and fail-open
    /// the other, from a single line.
    ///
    /// Only [`REFUSALS`] is the register speaking. Anything else is
    /// [`Error::VerifierUnavailable`], and both directions stop.
    fn registry_verifies(env: &Env, holder: &Address) -> Result<bool, Error> {
        let verifier = Self::address(env, DataKey::Verifier)?;
        match env.try_invoke_contract::<(), soroban_sdk::Error>(
            &verifier,
            &Symbol::new(env, "verify_identity"),
            Vec::from_array(env, [holder.into_val(env)]),
        ) {
            Ok(_) => Ok(true),
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) && REFUSALS.contains(&e.get_code()) => {
                Ok(false)
            }
            Err(_) => Err(Error::VerifierUnavailable),
        }
    }
}

#[cfg(test)]
mod test;
