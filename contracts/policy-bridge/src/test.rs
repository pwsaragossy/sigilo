//! What matters here is not that the bridge moves the trees — an off-chain script
//! did that already. It is that it *refuses* to move them against the register.
//!
//! So the tests worth having are the negative ones: enrolling someone the register
//! rejects, freezing someone it still vouches for, and — the refusal this suite
//! was missing until the binding landed — freezing a third party by naming their
//! key while a decoy takes the credential check.

use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, symbol_short,
    testutils::{Address as _, Events},
    Address, Env, Map, Symbol, TryFromVal, U256, Val, Vec,
};

use crate::{Enrolment, Error, PolicyBridge, PolicyBridgeClient};

/// The codes OpenZeppelin's RWA contracts actually trap with, mirrored here
/// because the bridge now tells them apart.
///
/// The first version of this fake denied with a bare `panic!`, which the host
/// narrows to `Context(InvalidAction)` — so it modelled an *unreachable* register
/// rather than a refusing one, and any test of the difference would have been
/// testing the fake. A denial is `panic_with_error!`, and it is typed.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
enum RegisterError {
    /// `RWAError::IdentityVerificationFailed` — the claims do not verify.
    VerificationFailed = 304,
    /// `RWAError::ClaimTopicsAndIssuersNotSet` — the register is misconfigured.
    /// Not a verdict about anybody.
    NotConfigured = 310,
}

/// Stands in for the ERC-3643 identity verifier, which reports failure by
/// trapping rather than returning false.
#[contract]
struct FakeVerifier;

#[contractimpl]
impl FakeVerifier {
    pub fn set(env: Env, who: Address, credentialed: bool) {
        let key = symbol_short!("creds");
        let mut creds: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| Map::new(&env));
        creds.set(who, credentialed);
        env.storage().instance().set(&key, &creds);
    }

    /// Makes the register answer with a code that is not a verdict about anyone —
    /// the misconfiguration case, which must not read as "not credentialed".
    pub fn break_config(env: Env) {
        env.storage().instance().set(&symbol_short!("broken"), &true);
    }

    pub fn verify_identity(env: Env, account: Address) {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&symbol_short!("broken"))
            .unwrap_or(false)
        {
            panic_with_error!(&env, RegisterError::NotConfigured);
        }

        let creds: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&symbol_short!("creds"))
            .unwrap_or_else(|| Map::new(&env));
        if !creds.get(account).unwrap_or(false) {
            panic_with_error!(&env, RegisterError::VerificationFailed);
        }
    }
}

fn record(env: &Env, kind: Symbol, value: U256) {
    let mut seen: Vec<U256> = env
        .storage()
        .instance()
        .get(&kind)
        .unwrap_or_else(|| Vec::new(env));
    seen.push_back(value);
    env.storage().instance().set(&kind, &seen);
}

fn log_of(env: &Env, kind: Symbol) -> Vec<U256> {
    env.storage()
        .instance()
        .get(&kind)
        .unwrap_or_else(|| Vec::new(env))
}

/// The allowlist: an append-only Merkle tree, one argument.
#[contract]
struct FakeAllowlist;

#[contractimpl]
impl FakeAllowlist {
    pub fn insert_leaf(env: Env, leaf: U256) {
        record(&env, symbol_short!("inserted"), leaf);
    }

    pub fn log(env: Env, kind: Symbol) -> Vec<U256> {
        log_of(&env, kind)
    }
}

/// The blocklist: a sparse Merkle tree keyed by note key, so insert takes a
/// key *and* a value, and entries can be deleted. Mirroring the real signatures
/// matters — the first version of this test passed one argument to both and hid
/// a mismatch the chain would have caught.
#[contract]
struct FakeBlocklist;

#[contractimpl]
impl FakeBlocklist {
    pub fn insert_leaf(env: Env, key: U256, _value: U256) {
        record(&env, symbol_short!("inserted"), key);
    }

    pub fn delete_leaf(env: Env, key: U256) {
        record(&env, symbol_short!("deleted"), key);
    }

    pub fn log(env: Env, kind: Symbol) -> Vec<U256> {
        log_of(&env, kind)
    }
}

struct Fixture {
    env: Env,
    bridge: PolicyBridgeClient<'static>,
    verifier: FakeVerifierClient<'static>,
    allowlist: FakeAllowlistClient<'static>,
    blocklist: FakeBlocklistClient<'static>,
    holder: Address,
}

fn setup() -> Fixture {
    build(false)
}

/// `verifier_nowhere` points the bridge at an address that hosts no contract,
/// which is how the "we could not ask" paths are reached.
fn build(verifier_nowhere: bool) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let verifier = FakeVerifierClient::new(&env, &env.register(FakeVerifier, ()));
    let allowlist = FakeAllowlistClient::new(&env, &env.register(FakeAllowlist, ()));
    let blocklist = FakeBlocklistClient::new(&env, &env.register(FakeBlocklist, ()));
    let operator = Address::generate(&env);

    let wired = if verifier_nowhere {
        Address::generate(&env)
    } else {
        verifier.address.clone()
    };

    let bridge = PolicyBridgeClient::new(
        &env,
        &env.register(
            PolicyBridge,
            (
                operator,
                wired,
                allowlist.address.clone(),
                blocklist.address.clone(),
            ),
        ),
    );

    let holder = Address::generate(&env);
    Fixture { env, bridge, verifier, allowlist, blocklist, holder }
}

fn u256(env: &Env, n: u32) -> U256 {
    U256::from_u32(env, n)
}

/// Reads one piece of an emitted event back into the type it was published as.
fn decode<T: TryFromVal<Env, Val>>(env: &Env, raw: &soroban_sdk::xdr::ScVal) -> T {
    let val = Val::try_from_val(env, raw).expect("event value is not a Val");
    T::try_from_val(env, &val).unwrap_or_else(|_| panic!("event value has the wrong type"))
}

/// The two values a holder is enrolled with. Named apart on purpose: they live in
/// different keyspaces, and the defect this suite now guards against came from a
/// helper called `leaf` being handed to a `note_key` parameter.
const LEAF: u32 = 42;
const NOTE_KEY: u32 = 99;

fn enrol(f: &Fixture, holder: &Address) {
    f.verifier.set(holder, &true);
    f.bridge.grant(holder, &u256(&f.env, LEAF), &u256(&f.env, NOTE_KEY));
}

// --- the refusals ----------------------------------------------------------

#[test]
fn refuses_to_enrol_someone_the_register_rejects() {
    let f = setup();
    f.verifier.set(&f.holder, &false);

    let result = f
        .bridge
        .try_grant(&f.holder, &u256(&f.env, LEAF), &u256(&f.env, NOTE_KEY));

    assert_eq!(result, Err(Ok(Error::NotCredentialed)));
    assert_eq!(
        f.allowlist.log(&symbol_short!("inserted")).len(),
        0,
        "an uncredentialed holder must leave no trace in the allowlist",
    );
}

#[test]
fn refuses_to_freeze_someone_still_in_good_standing() {
    let f = setup();
    enrol(&f, &f.holder);

    let result = f.bridge.try_revoke(&f.holder);

    assert_eq!(result, Err(Ok(Error::StillCredentialed)));
    assert_eq!(
        f.blocklist.log(&symbol_short!("inserted")).len(),
        0,
        "freezing a credentialed holder is exactly the abuse this prevents",
    );
}

#[test]
fn refuses_to_lift_a_freeze_without_a_credential() {
    let f = setup();
    enrol(&f, &f.holder);
    f.verifier.set(&f.holder, &false);

    let result = f.bridge.try_restore(&f.holder);

    assert_eq!(result, Err(Ok(Error::NotCredentialed)));
    assert_eq!(f.blocklist.log(&symbol_short!("deleted")).len(), 0);
}

// --- the binding: a key belongs to a holder, and to only one -----------------

/// The refusal this contract exists for, and the one it did not used to make.
///
/// `revoke` used to take the key to freeze as an argument, so an operator could
/// pass the credential check with a decoy they had let lapse and hand it a
/// *credentialed* holder's note key — which is public. The gate was checked
/// against one party and the tree moved against another.
#[test]
fn a_decoy_holder_cannot_be_used_to_freeze_a_third_party() {
    let f = setup();
    let victim = f.holder.clone();
    let decoy = Address::generate(&f.env);

    enrol(&f, &victim);

    // The operator issues claims as well as running the bridge, so a decoy of
    // their own is free — and the victim's note key is public by design.
    f.verifier.set(&decoy, &true);
    let hijack = f
        .bridge
        .try_grant(&decoy, &u256(&f.env, 1000), &u256(&f.env, NOTE_KEY));
    assert_eq!(
        hijack,
        Err(Ok(Error::NoteKeyBound)),
        "a note key already bound to a holder may not be re-bound to another",
    );

    // With no binding to hijack, letting the decoy's own claim lapse and
    // revoking it freezes nothing: the decoy never enrolled.
    f.verifier.set(&decoy, &false);
    assert_eq!(f.bridge.try_revoke(&decoy), Err(Ok(Error::NotEnrolled)));

    assert_eq!(
        f.blocklist.log(&symbol_short!("inserted")).len(),
        0,
        "the victim was in good standing throughout and must be untouched",
    );
    assert_eq!(
        f.bridge.enrolment(&victim),
        Enrolment { leaf: u256(&f.env, LEAF), note_key: u256(&f.env, NOTE_KEY) },
    );
}

#[test]
fn revoke_before_enrolment_is_refused() {
    let f = setup();
    f.verifier.set(&f.holder, &false);

    assert_eq!(f.bridge.try_revoke(&f.holder), Err(Ok(Error::NotEnrolled)));
    assert_eq!(f.blocklist.log(&symbol_short!("inserted")).len(), 0);
}

#[test]
fn restore_before_enrolment_is_refused() {
    let f = setup();
    f.verifier.set(&f.holder, &true);

    assert_eq!(f.bridge.try_restore(&f.holder), Err(Ok(Error::NotEnrolled)));
    assert_eq!(f.blocklist.log(&symbol_short!("deleted")).len(), 0);
}

#[test]
fn grant_twice_with_a_different_leaf_is_refused() {
    let f = setup();
    enrol(&f, &f.holder);

    let result = f
        .bridge
        .try_grant(&f.holder, &u256(&f.env, 1000), &u256(&f.env, NOTE_KEY));

    assert_eq!(result, Err(Ok(Error::AlreadyEnrolled)));
    assert_eq!(
        f.allowlist.log(&symbol_short!("inserted")).len(),
        1,
        "a refused re-enrolment must not reach the append-only allowlist",
    );
}

#[test]
fn grant_twice_with_a_different_note_key_is_refused() {
    let f = setup();
    enrol(&f, &f.holder);

    let result = f
        .bridge
        .try_grant(&f.holder, &u256(&f.env, LEAF), &u256(&f.env, 1000));

    assert_eq!(result, Err(Ok(Error::AlreadyEnrolled)));
    assert_eq!(
        f.bridge.enrolment(&f.holder).note_key,
        u256(&f.env, NOTE_KEY),
        "the key on record is the one the register approved, and it does not move",
    );
}

/// `scripts/policy-bridge.sh sync` re-proposes a grant to find out whether the
/// leaf is already in the append-only allowlist, so this has to stay cheap and
/// harmless.
#[test]
fn grant_twice_with_the_same_keys_is_idempotent() {
    let f = setup();
    enrol(&f, &f.holder);

    f.bridge
        .grant(&f.holder, &u256(&f.env, LEAF), &u256(&f.env, NOTE_KEY));

    assert_eq!(f.allowlist.log(&symbol_short!("inserted")).len(), 1);
}

// --- the register has three answers, not two --------------------------------

/// A register that cannot be reached has not refused anybody. Reading its silence
/// as "not credentialed" is a second way to manufacture a freeze, and it used to
/// be one: `grant` failed closed on a trap while `revoke` failed open.
#[test]
fn an_unreachable_verifier_cannot_be_used_to_freeze() {
    let f = build(true);

    assert_eq!(
        f.bridge.try_revoke(&f.holder),
        Err(Ok(Error::VerifierUnavailable)),
    );
    assert_eq!(
        f.bridge
            .try_grant(&f.holder, &u256(&f.env, LEAF), &u256(&f.env, NOTE_KEY)),
        Err(Ok(Error::VerifierUnavailable)),
    );
    assert_eq!(f.blocklist.log(&symbol_short!("inserted")).len(), 0);
    assert_eq!(f.allowlist.log(&symbol_short!("inserted")).len(), 0);
}

/// A misconfigured register answers with a typed contract error like anything
/// else, but `ClaimTopicsAndIssuersNotSet` is a fact about the register, not a
/// verdict about a holder. Matching on the error type alone would read it as a
/// refusal and freeze on it.
#[test]
fn a_misconfigured_register_is_not_a_verdict() {
    let f = setup();
    enrol(&f, &f.holder);

    f.verifier.break_config();

    assert_eq!(
        f.bridge.try_revoke(&f.holder),
        Err(Ok(Error::VerifierUnavailable)),
    );
    assert_eq!(
        f.bridge.try_restore(&f.holder),
        Err(Ok(Error::VerifierUnavailable)),
    );
    assert_eq!(
        f.blocklist.log(&symbol_short!("inserted")).len(),
        0,
        "a register that never answered must not be able to freeze anyone",
    );
}

// --- the happy paths, and that they follow the register --------------------

#[test]
fn enrols_a_credentialed_holder() {
    let f = setup();
    enrol(&f, &f.holder);

    assert_eq!(
        f.allowlist.log(&symbol_short!("inserted")),
        Vec::from_array(&f.env, [u256(&f.env, LEAF)]),
    );
    assert_eq!(
        f.bridge.enrolment(&f.holder),
        Enrolment { leaf: u256(&f.env, LEAF), note_key: u256(&f.env, NOTE_KEY) },
    );
}

#[test]
fn freezes_once_the_credential_is_gone() {
    let f = setup();
    enrol(&f, &f.holder);

    // The register changes its mind; only then may the bridge act.
    f.verifier.set(&f.holder, &false);
    f.bridge.revoke(&f.holder);

    assert_eq!(
        f.blocklist.log(&symbol_short!("inserted")),
        Vec::from_array(&f.env, [u256(&f.env, NOTE_KEY)]),
        "the key frozen is the key enrolled, not one the caller chose",
    );
}

#[test]
fn lifts_the_freeze_when_the_credential_returns() {
    let f = setup();
    enrol(&f, &f.holder);
    f.verifier.set(&f.holder, &false);
    f.bridge.revoke(&f.holder);

    f.verifier.set(&f.holder, &true);
    f.bridge.restore(&f.holder);

    assert_eq!(
        f.blocklist.log(&symbol_short!("deleted")),
        Vec::from_array(&f.env, [u256(&f.env, NOTE_KEY)]),
    );
}

/// The full cycle the demo shows, in one test: enrolled, revoked, restored —
/// each step permitted only by what the register said at that moment.
#[test]
fn the_register_decides_at_every_step() {
    let f = setup();

    enrol(&f, &f.holder);
    assert_eq!(f.bridge.is_credentialed(&f.holder), true);

    assert!(f.bridge.try_revoke(&f.holder).is_err());

    f.verifier.set(&f.holder, &false);
    assert_eq!(f.bridge.is_credentialed(&f.holder), false);
    f.bridge.revoke(&f.holder);

    assert!(f
        .bridge
        .try_grant(&f.holder, &u256(&f.env, LEAF), &u256(&f.env, NOTE_KEY))
        .is_err());

    f.verifier.set(&f.holder, &true);
    f.bridge.restore(&f.holder);

    assert_eq!(f.allowlist.log(&symbol_short!("inserted")).len(), 1);
    assert_eq!(f.blocklist.log(&symbol_short!("inserted")).len(), 1);
    assert_eq!(f.blocklist.log(&symbol_short!("deleted")).len(), 1);
}

/// An auditor watching the chain has to be able to tell *which* key moved, or
/// the substitution this contract prevents would be invisible to them even
/// though it is prevented.
#[test]
fn the_event_names_the_key_it_moved() {
    let f = setup();
    enrol(&f, &f.holder);
    f.verifier.set(&f.holder, &false);
    f.bridge.revoke(&f.holder);

    let emitted = f.env.events().all().filter_by_contract(&f.bridge.address);
    let events = emitted.events();
    assert_eq!(events.len(), 1, "the freeze, from the last invocation");

    let soroban_sdk::xdr::ContractEventBody::V0(body) = &events[0].body;

    // Topics: what happened, and to whom — both indexable by an auditor.
    assert_eq!(body.topics.len(), 3);
    assert_eq!(
        decode::<Symbol>(&f.env, &body.topics[1]),
        Symbol::new(&f.env, "revoked"),
    );
    assert_eq!(decode::<Address>(&f.env, &body.topics[2]), f.holder);

    // Data: which keys moved. Without these the substitution would be
    // prevented but unauditable, and a guarantee nobody can check is not one.
    let data = decode::<Map<Symbol, U256>>(&f.env, &body.data);
    assert_eq!(
        data.get(Symbol::new(&f.env, "leaf")).unwrap(),
        u256(&f.env, LEAF),
    );
    assert_eq!(
        data.get(Symbol::new(&f.env, "note_key")).unwrap(),
        u256(&f.env, NOTE_KEY),
    );

    let on_record = f.bridge.enrolment(&f.holder);
    assert_eq!(data.get(Symbol::new(&f.env, "leaf")).unwrap(), on_record.leaf);
    assert_eq!(
        data.get(Symbol::new(&f.env, "note_key")).unwrap(),
        on_record.note_key,
        "the event must name the key the enrolment bound, not one the caller chose",
    );
}
