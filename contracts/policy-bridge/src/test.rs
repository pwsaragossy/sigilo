//! What matters here is not that the bridge moves the trees — an off-chain script
//! did that already. It is that it *refuses* to move them against the register.
//!
//! So the tests worth having are the negative ones: enrolling someone the register
//! rejects, and freezing someone it still vouches for. Those two refusals are the
//! entire reason this contract exists.

use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events},
    Address, Env, Map, Symbol, U256, Vec,
};

use crate::{Error, PolicyBridge, PolicyBridgeClient};

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

    pub fn verify_identity(env: Env, account: Address) {
        let creds: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&symbol_short!("creds"))
            .unwrap_or_else(|| Map::new(&env));
        if !creds.get(account).unwrap_or(false) {
            panic!("identity not verified");
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
    let env = Env::default();
    env.mock_all_auths();

    let verifier = FakeVerifierClient::new(&env, &env.register(FakeVerifier, ()));
    let allowlist = FakeAllowlistClient::new(&env, &env.register(FakeAllowlist, ()));
    let blocklist = FakeBlocklistClient::new(&env, &env.register(FakeBlocklist, ()));
    let operator = Address::generate(&env);

    let bridge = PolicyBridgeClient::new(
        &env,
        &env.register(
            PolicyBridge,
            (
                operator,
                verifier.address.clone(),
                allowlist.address.clone(),
                blocklist.address.clone(),
            ),
        ),
    );

    let holder = Address::generate(&env);
    Fixture { env, bridge, verifier, allowlist, blocklist, holder }
}

fn leaf(env: &Env, n: u32) -> U256 {
    U256::from_u32(env, n)
}

// --- the refusals ----------------------------------------------------------

#[test]
fn refuses_to_enrol_someone_the_register_rejects() {
    let f = setup();
    f.verifier.set(&f.holder, &false);

    let result = f.bridge.try_grant(&f.holder, &leaf(&f.env, 42));

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
    f.verifier.set(&f.holder, &true);

    let result = f.bridge.try_revoke(&f.holder, &leaf(&f.env, 7));

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
    f.verifier.set(&f.holder, &false);

    let result = f.bridge.try_restore(&f.holder, &leaf(&f.env, 7));

    assert_eq!(result, Err(Ok(Error::NotCredentialed)));
    assert_eq!(f.blocklist.log(&symbol_short!("deleted")).len(), 0);
}

// --- the happy paths, and that they follow the register --------------------

#[test]
fn enrols_a_credentialed_holder() {
    let f = setup();
    f.verifier.set(&f.holder, &true);

    f.bridge.grant(&f.holder, &leaf(&f.env, 42));

    assert_eq!(
        f.allowlist.log(&symbol_short!("inserted")),
        Vec::from_array(&f.env, [leaf(&f.env, 42)]),
    );
}

#[test]
fn freezes_once_the_credential_is_gone() {
    let f = setup();
    f.verifier.set(&f.holder, &true);
    f.bridge.grant(&f.holder, &leaf(&f.env, 42));

    // The register changes its mind; only then may the bridge act.
    f.verifier.set(&f.holder, &false);
    f.bridge.revoke(&f.holder, &leaf(&f.env, 99));

    assert_eq!(
        f.blocklist.log(&symbol_short!("inserted")),
        Vec::from_array(&f.env, [leaf(&f.env, 99)]),
    );
}

#[test]
fn lifts_the_freeze_when_the_credential_returns() {
    let f = setup();
    f.verifier.set(&f.holder, &false);
    f.bridge.revoke(&f.holder, &leaf(&f.env, 99));

    f.verifier.set(&f.holder, &true);
    f.bridge.restore(&f.holder, &leaf(&f.env, 99));

    assert_eq!(
        f.blocklist.log(&symbol_short!("deleted")),
        Vec::from_array(&f.env, [leaf(&f.env, 99)]),
    );
}

/// The full cycle the demo shows, in one test: enrolled, revoked, restored —
/// each step permitted only by what the register said at that moment.
#[test]
fn the_register_decides_at_every_step() {
    let f = setup();

    f.verifier.set(&f.holder, &true);
    f.bridge.grant(&f.holder, &leaf(&f.env, 1));
    assert_eq!(f.bridge.is_credentialed(&f.holder), true);

    assert!(f.bridge.try_revoke(&f.holder, &leaf(&f.env, 1)).is_err());

    f.verifier.set(&f.holder, &false);
    assert_eq!(f.bridge.is_credentialed(&f.holder), false);
    f.bridge.revoke(&f.holder, &leaf(&f.env, 1));

    assert!(f.bridge.try_grant(&f.holder, &leaf(&f.env, 1)).is_err());

    f.verifier.set(&f.holder, &true);
    f.bridge.restore(&f.holder, &leaf(&f.env, 1));

    assert_eq!(f.allowlist.log(&symbol_short!("inserted")).len(), 1);
    assert_eq!(f.blocklist.log(&symbol_short!("inserted")).len(), 1);
    assert_eq!(f.blocklist.log(&symbol_short!("deleted")).len(), 1);
}

#[test]
fn announces_what_it_did() {
    let f = setup();
    f.verifier.set(&f.holder, &true);
    f.bridge.grant(&f.holder, &leaf(&f.env, 42));

    let emitted = f.env.events().all().filter_by_contract(&f.bridge.address);
    assert!(
        !emitted.events().is_empty(),
        "an auditor watching the chain should see policy decisions as they happen",
    );
}
