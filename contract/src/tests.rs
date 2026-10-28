use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

const NEAR: u128 = 10u128.pow(24);
const H: u64 = 3_600_000_000_000;
const DAY: u64 = 24 * H;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.near")
}
fn agent() -> AccountId {
    acc("agent.near")
}
fn signer() -> AccountId {
    acc("signer.near")
}
fn signer2() -> AccountId {
    acc("ci.near")
}
fn shop() -> AccountId {
    acc("shop.near")
}
fn hash(c: char) -> String {
    c.to_string().repeat(64)
}

fn ctx(who: &AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("clearance.near"))
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(100))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(10 * DAY);
    b
}

fn set(who: &AccountId, deposit: u128) {
    testing_env!(ctx(who, deposit).build());
}

fn set_at(who: &AccountId, deposit: u128, ts: u64) {
    testing_env!(ctx(who, deposit).block_timestamp(ts).build());
}

fn contract() -> Contract {
    set(&owner(), 0);
    Contract::init(U64(H), [U128(3 * NEAR), U128(10 * NEAR)], U64(30 * DAY))
}

fn vault_with(c: &mut Contract, signers: Vec<AccountId>, policy: Policy, cap: u128) -> u64 {
    set(&owner(), 20 * NEAR);
    c.create_vault(
        agent(),
        U128(cap),
        vec![shop()],
        signers,
        policy,
        1,
        0,
        false,
    )
}

fn vault(c: &mut Contract) -> u64 {
    vault_with(c, vec![signer()], Policy::All, 5 * NEAR)
}

fn certify_as(c: &mut Contract, who: &AccountId, level: u8, class: EndpointClass) {
    set(who, NEAR / 10);
    if c.storage_balance_of(who.clone()).0 == 0 {
        c.storage_deposit(None);
    }
    set(who, 0);
    c.certify(
        agent(),
        level,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        class,
        Some("run:1@abc".into()),
        U64(7 * DAY),
    );
}

fn certify(c: &mut Contract, level: u8) {
    certify_as(c, &signer(), level, EndpointClass::Attested);
}

fn spend(c: &mut Contract, id: u64, near: u128) {
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(near * NEAR), None);
}

// ---- create_vault ----

#[test]
fn create_vault_charges_storage_from_deposit() {
    let mut c = contract();
    let id = vault(&mut c);
    let v = c.get_vault(id).unwrap();
    assert!(v.storage_paid.0 > 0);
    assert_eq!(v.balance.0 + v.storage_paid.0, 20 * NEAR);
    assert!(get_logs()[0].starts_with("EVENT_JSON:"));
}

#[test]
#[should_panic(expected = "for storage")]
fn create_vault_rejects_deposit_below_storage() {
    let mut c = contract();
    set(&owner(), 1);
    c.create_vault(
        agent(),
        U128(NEAR),
        vec![shop()],
        vec![signer()],
        Policy::All,
        1,
        0,
        false,
    );
}

#[test]
#[should_panic(expected = "owner cannot be a trusted signer")]
fn owner_cannot_be_signer() {
    let mut c = contract();
    vault_with(&mut c, vec![owner()], Policy::All, NEAR);
}

#[test]
#[should_panic(expected = "agent cannot be a trusted signer")]
fn agent_cannot_be_signer() {
    let mut c = contract();
    vault_with(&mut c, vec![agent()], Policy::All, NEAR);
}

#[test]
#[should_panic(expected = "need 1 to 3 trusted signers")]
fn zero_signers_rejected() {
    let mut c = contract();
    vault_with(&mut c, vec![], Policy::All, NEAR);
}

#[test]
#[should_panic(expected = "need 1 to 3 trusted signers")]
fn four_signers_rejected() {
    let mut c = contract();
    vault_with(
        &mut c,
        vec![acc("a.near"), acc("b.near"), acc("c.near"), acc("d.near")],
        Policy::All,
        NEAR,
    );
}

#[test]
#[should_panic(expected = "duplicate trusted signer")]
fn duplicate_signers_rejected() {
    let mut c = contract();
    vault_with(&mut c, vec![signer(), signer()], Policy::All, NEAR);
}

#[test]
#[should_panic(expected = "at most 10 receivers")]
fn too_many_receivers_rejected() {
    let mut c = contract();
    set(&owner(), 20 * NEAR);
    let rs = (0..11).map(|i| acc(&format!("r{i}.near"))).collect();
    c.create_vault(
        agent(),
        U128(NEAR),
        rs,
        vec![signer()],
        Policy::All,
        1,
        0,
        false,
    );
}

// ---- spend ----

#[test]
fn certified_agent_spends_within_cap() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    let before = c.get_vault(id).unwrap().balance.0;
    spend(&mut c, id, 2);
    let v = c.get_vault(id).unwrap();
    assert_eq!(v.balance.0, before - 2 * NEAR);
    assert_eq!(v.window_spent.0, 2 * NEAR);
    assert_eq!(v.pending, 1);
    assert_eq!(v.effective_cap.unwrap().0, 5 * NEAR); // min(owner 5, level-2 10)
}

#[test]
#[should_panic(expected = "only the vault agent can spend")]
fn non_agent_cannot_spend() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&shop(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "receiver not allowed")]
fn unknown_receiver_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&agent(), 0);
    let _ = c.spend(id, acc("sh0p.near"), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn uncertified_agent_cannot_spend() {
    let mut c = contract();
    let id = vault(&mut c);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn expired_certificate_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set_at(&agent(), 0, 18 * DAY);
    let _ = c.spend(id, shop(), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn old_suite_version_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&owner(), 1);
    c.set_min_suite(id, 2, 0, false);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn missing_hidden_slice_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&owner(), 1);
    c.set_min_suite(id, 1, 1, false);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn foreign_endpoint_rejected_unless_allowed() {
    let mut c = contract();
    let id = vault(&mut c);
    certify_as(&mut c, &signer(), 2, EndpointClass::Foreign);
    spend(&mut c, id, 1);
}

#[test]
fn foreign_endpoint_accepted_when_allowed() {
    let mut c = contract();
    let id = vault(&mut c);
    certify_as(&mut c, &signer(), 2, EndpointClass::Foreign);
    set(&owner(), 1);
    c.set_min_suite(id, 1, 0, true);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "over window cap")]
fn level_one_cap_applies() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 1);
    spend(&mut c, id, 2);
    spend(&mut c, id, 2); // 4 > level-1 cap 3
}

#[test]
#[should_panic(expected = "over window cap")]
fn owner_cap_applies() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 6); // owner cap 5 < level-2 cap 10
}

#[test]
fn window_frees_after_24_buckets() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 5);
    set_at(&agent(), 0, 11 * DAY);
    let _ = c.spend(id, shop(), U128(5 * NEAR), None);
}

#[test]
#[should_panic(expected = "over window cap")]
fn window_holds_23_hours_later() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 5);
    set_at(&agent(), 0, 10 * DAY + 23 * H);
    let _ = c.spend(id, shop(), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "insufficient vault balance")]
fn balance_limits_spend() {
    let mut c = contract();
    set(&owner(), 2 * NEAR);
    let id = c.create_vault(
        agent(),
        U128(10 * NEAR),
        vec![shop()],
        vec![signer()],
        Policy::All,
        1,
        0,
        false,
    );
    certify(&mut c, 2);
    spend(&mut c, id, 2);
}

#[test]
#[should_panic(expected = "vault is paused")]
fn paused_vault_blocks_spend() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&owner(), 1);
    c.set_paused(id, true);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "attach at least 25 Tgas")]
fn low_gas_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    testing_env!(ctx(&agent(), 0).prepaid_gas(Gas::from_tgas(20)).build());
    let _ = c.spend(id, shop(), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn zero_amount_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(0), None);
}

#[test]
#[should_panic(expected = "memo longer than 256 bytes")]
fn long_memo_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), Some("x".repeat(257)));
}

// ---- multi-signer policy ----

#[test]
#[should_panic(expected = "no valid certificate")]
fn policy_all_needs_every_signer() {
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::All, 10 * NEAR);
    certify(&mut c, 2);
    spend(&mut c, id, 1);
}

#[test]
fn policy_all_takes_minimum_level() {
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::All, 10 * NEAR);
    certify(&mut c, 2);
    certify_as(&mut c, &signer2(), 1, EndpointClass::Allowlist);
    assert_eq!(c.effective_level(id), Some(1));
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn policy_all_revoke_by_one_signer_stops_agent() {
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::All, 10 * NEAR);
    certify(&mut c, 2);
    certify_as(&mut c, &signer2(), 2, EndpointClass::Allowlist);
    set(&signer2(), 0);
    c.revoke(agent());
    spend(&mut c, id, 1);
}

#[test]
fn policy_any_takes_maximum_live_level() {
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::Any, 10 * NEAR);
    assert_eq!(c.effective_level(id), None);
    certify_as(&mut c, &signer2(), 1, EndpointClass::Allowlist);
    assert_eq!(c.effective_level(id), Some(1));
    certify(&mut c, 2);
    assert_eq!(c.effective_level(id), Some(2));
}

#[test]
fn untrusted_signer_does_not_count() {
    let mut c = contract();
    let id = vault(&mut c);
    certify_as(&mut c, &acc("stranger.near"), 2, EndpointClass::Attested);
    assert_eq!(c.effective_level(id), None);
}

// ---- certify / revoke ----

#[test]
#[should_panic(expected = "agent cannot certify itself")]
fn self_certification_rejected() {
    let mut c = contract();
    set(&agent(), NEAR / 10);
    c.storage_deposit(None);
    set(&agent(), 0);
    c.certify(
        agent(),
        2,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(DAY),
    );
}

#[test]
#[should_panic(expected = "level must be 1 or 2")]
fn level_three_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        3,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(DAY),
    );
}

#[test]
#[should_panic(expected = "hashes must be 64 lowercase hex chars")]
fn bad_hash_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        1,
        1,
        hash('A'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(DAY),
    );
}

#[test]
#[should_panic(expected = "ttl out of range")]
fn long_ttl_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        1,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(31 * DAY),
    );
}

#[test]
#[should_panic(expected = "run_ref longer than 128 bytes")]
fn long_run_ref_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        1,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        Some("r".repeat(129)),
        U64(DAY),
    );
}

#[test]
#[should_panic(expected = "not enough prepaid storage")]
fn certify_needs_prepaid_storage() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        1,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(DAY),
    );
}

#[test]
#[should_panic(expected = "first storage deposit must be at least 0.01 NEAR")]
fn dust_storage_deposit_rejected() {
    let mut c = contract();
    set(&signer(), 1);
    c.storage_deposit(None);
}

#[test]
fn certify_charges_and_revoke_refunds_storage() {
    let mut c = contract();
    set(&signer(), NEAR / 10);
    let credited = c.storage_deposit(None).0;
    certify(&mut c, 2);
    let after_certify = c.storage_balance_of(signer()).0;
    assert!(after_certify < credited);
    assert!(c.is_certified(agent(), signer(), 2));
    assert!(c.is_certified(agent(), signer(), 1));
    set(&signer(), 0);
    c.revoke(agent());
    assert_eq!(c.storage_balance_of(signer()).0, credited);
    assert!(!c.is_certified(agent(), signer(), 1));
}

#[test]
fn recertify_overwrites_single_slot() {
    let mut c = contract();
    certify(&mut c, 2);
    certify(&mut c, 1);
    assert_eq!(c.get_cert(agent(), signer()).unwrap().level, 1);
    assert!(!c.is_certified(agent(), signer(), 2));
}

#[test]
#[should_panic(expected = "no certificate to revoke")]
fn revoke_without_cert_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.revoke(agent());
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn revoke_stops_spending() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 1);
    set(&signer(), 0);
    c.revoke(agent());
    spend(&mut c, id, 1);
}

// ---- callbacks ----

fn callback_env(result: PromiseResult) {
    testing_env!(
        ctx(&acc("clearance.near"), 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

#[test]
fn failed_transfer_restores_balance_and_window() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    let before = c.get_vault(id).unwrap().balance.0;
    spend(&mut c, id, 3);
    let bucket = 10 * DAY / H;
    callback_env(PromiseResult::Failed);
    assert!(!c.on_transfer_done(id, owner(), bucket, U128(3 * NEAR), None));
    let v = c.get_vault(id).unwrap();
    assert_eq!(v.balance.0, before);
    assert_eq!(v.window_spent.0, 0);
    assert_eq!(v.pending, 0);
}

#[test]
fn successful_transfer_keeps_debit() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 3);
    callback_env(PromiseResult::Successful(vec![]));
    assert!(c.on_transfer_done(id, owner(), 10 * DAY / H, U128(3 * NEAR), None));
    let v = c.get_vault(id).unwrap();
    assert_eq!(v.window_spent.0, 3 * NEAR);
    assert_eq!(v.pending, 0);
}

#[test]
fn failed_withdraw_restores_balance() {
    let mut c = contract();
    let id = vault(&mut c);
    let before = c.get_vault(id).unwrap().balance.0;
    set(&owner(), 1);
    let _ = c.withdraw(id, U128(NEAR));
    callback_env(PromiseResult::Failed);
    c.on_withdraw_done(id, owner(), U128(NEAR));
    assert_eq!(c.get_vault(id).unwrap().balance.0, before);
}

#[test]
fn failed_refund_lands_in_storage_balance() {
    let mut c = contract();
    callback_env(PromiseResult::Failed);
    c.on_refund_done(owner(), U128(NEAR));
    let bal = c.storage_balance_of(owner()).0;
    assert!(bal > 0 && bal < NEAR); // the new entry paid for its own storage
}

// ---- owner operations ----

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&owner(), 0);
    let _ = c.withdraw(id, U128(NEAR));
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn agent_cannot_withdraw() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&agent(), 1);
    let _ = c.withdraw(id, U128(NEAR));
}

#[test]
#[should_panic(expected = "transfers still pending")]
fn close_rejected_while_pending() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 1);
    set(&owner(), 1);
    let _ = c.close_vault(id);
}

#[test]
fn close_removes_vault() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&owner(), 1);
    let _ = c.close_vault(id);
    assert!(c.get_vault(id).is_none());
}

#[test]
fn settings_storage_is_paid_from_vault_balance() {
    let mut c = contract();
    let id = vault(&mut c);
    let v0 = c.get_vault(id).unwrap();
    set(&owner(), 1);
    c.set_receivers(
        id,
        (0..10)
            .map(|i| acc(&format!("receiver-{i}.near")))
            .collect(),
    );
    let v1 = c.get_vault(id).unwrap();
    assert!(v1.storage_paid.0 > v0.storage_paid.0);
    assert_eq!(
        v1.balance.0 + v1.storage_paid.0,
        v0.balance.0 + v0.storage_paid.0
    );
    set(&owner(), 1);
    c.set_receivers(id, vec![shop()]);
    let v2 = c.get_vault(id).unwrap();
    assert_eq!(v2.storage_paid.0, v0.storage_paid.0);
    assert_eq!(v2.balance.0, v0.balance.0);
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn stranger_cannot_change_signers() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&agent(), 1);
    c.set_trusted_signers(id, vec![acc("friend.near")], Policy::Any);
}

#[test]
fn storage_entry_pays_for_itself_and_is_refunded_when_emptied() {
    let mut c = contract();
    set(&signer(), NEAR / 10);
    let credited = c.storage_deposit(None).0;
    assert!(credited < NEAR / 10);
    set(&signer(), 1);
    let _ = c.storage_withdraw(U128(credited));
    assert_eq!(c.storage_balance_of(signer()).0, 0);
}

#[test]
#[should_panic(expected = "contract cannot be a receiver")]
fn contract_cannot_be_receiver() {
    let mut c = contract();
    set(&owner(), 20 * NEAR);
    c.create_vault(
        agent(),
        U128(NEAR),
        vec![acc("clearance.near")],
        vec![signer()],
        Policy::All,
        1,
        0,
        false,
    );
}

#[test]
fn is_certified_rejects_level_zero_query() {
    let mut c = contract();
    certify(&mut c, 1);
    assert!(!c.is_certified(agent(), signer(), 0));
    assert!(c.is_certified(agent(), signer(), 1));
}

// ---- gaps found in review ----

fn event(log: &str) -> near_sdk::serde_json::Value {
    near_sdk::serde_json::from_str(log.strip_prefix("EVENT_JSON:").expect("event log")).unwrap()
}

#[test]
fn spend_and_certify_events_carry_their_fields() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    let e = event(get_logs().last().unwrap());
    assert_eq!(e["standard"], "clearance");
    assert_eq!(e["event"], "certify");
    assert_eq!(e["data"][0]["level"], 2);
    assert_eq!(e["data"][0]["report_hash"], hash('b'));
    assert_eq!(e["data"][0]["run_ref"], "run:1@abc");
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(2 * NEAR), Some("inv-1".into()));
    let e = event(get_logs().last().unwrap());
    assert_eq!(e["event"], "spend");
    let d = &e["data"][0];
    assert_eq!(d["vault_id"], id);
    assert_eq!(d["receiver"], "shop.near");
    assert_eq!(d["amount"], (2 * NEAR).to_string());
    assert_eq!(d["bucket"], 10 * DAY / H);
    assert_eq!(d["level"], 2);
    assert_eq!(d["memo"], "inv-1");
}

#[test]
#[should_panic(expected = "no vault")]
fn spend_on_missing_vault_rejected() {
    let mut c = contract();
    set(&agent(), 0);
    let _ = c.spend(7, shop(), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn policy_any_without_usable_certs_blocks_spend() {
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::Any, 10 * NEAR);
    certify_as(&mut c, &signer2(), 2, EndpointClass::Foreign); // filtered out
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "no valid certificate")]
fn adding_uncertified_signer_under_all_freezes_agent() {
    let mut c = contract();
    let id = vault(&mut c);
    certify(&mut c, 2);
    spend(&mut c, id, 1);
    set(&owner(), 1);
    c.set_trusted_signers(id, vec![signer(), signer2()], Policy::All);
    spend(&mut c, id, 1);
}

#[test]
#[should_panic(expected = "ttl out of range")]
fn zero_ttl_rejected() {
    let mut c = contract();
    set(&signer(), 0);
    c.certify(
        agent(),
        1,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Allowlist,
        None,
        U64(0),
    );
}

#[test]
fn recertify_with_shorter_run_ref_refunds_storage() {
    let mut c = contract();
    certify(&mut c, 2); // run_ref "run:1@abc"
    let before = c.storage_balance_of(signer()).0;
    set(&signer(), 0);
    c.certify(
        agent(),
        2,
        1,
        hash('a'),
        0,
        hash('b'),
        hash('c'),
        EndpointClass::Attested,
        None,
        U64(DAY),
    );
    assert!(c.storage_balance_of(signer()).0 > before);
}

#[test]
fn storage_deposit_for_another_account() {
    let mut c = contract();
    set(&owner(), NEAR / 10);
    c.storage_deposit(Some(signer()));
    assert!(c.storage_balance_of(signer()).0 > 0);
    assert_eq!(c.storage_balance_of(owner()).0, 0);
}

#[test]
fn partial_storage_withdraw_keeps_entry() {
    let mut c = contract();
    set(&signer(), NEAR / 10);
    let credited = c.storage_deposit(None).0;
    set(&signer(), 1);
    let _ = c.storage_withdraw(U128(credited / 2));
    assert_eq!(c.storage_balance_of(signer()).0, credited - credited / 2);
}

#[test]
#[should_panic(expected = "vault balance cannot cover storage")]
fn settings_growth_needs_vault_balance() {
    let mut c = contract();
    set(&owner(), 20 * NEAR);
    let id = c.create_vault(
        agent(),
        U128(NEAR),
        vec![],
        vec![signer()],
        Policy::All,
        1,
        0,
        false,
    );
    let paid = c.get_vault(id).unwrap().storage_paid.0;
    set(&owner(), 1);
    let _ = c.withdraw(id, U128(20 * NEAR - paid));
    set(&owner(), 1);
    c.set_receivers(
        id,
        (0..10)
            .map(|i| acc(&format!("receiver-{i}.near")))
            .collect(),
    );
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn deposit_by_stranger_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&agent(), NEAR);
    c.deposit(id);
}

#[test]
#[should_panic(expected = "attach a deposit")]
fn zero_deposit_rejected() {
    let mut c = contract();
    let id = vault(&mut c);
    set(&owner(), 0);
    c.deposit(id);
}

#[test]
fn failed_transfer_for_removed_vault_credits_owner() {
    let mut c = contract();
    callback_env(PromiseResult::Failed);
    assert!(!c.on_transfer_done(42, owner(), 0, U128(NEAR), None));
    let bal = c.storage_balance_of(owner()).0;
    assert!(bal > 0 && bal < NEAR);
}

#[test]
#[should_panic(expected = "bucket_ns must be positive")]
fn init_rejects_zero_bucket() {
    set(&owner(), 0);
    Contract::init(U64(0), [U128(1), U128(2)], U64(DAY));
}

#[test]
#[should_panic(expected = "level caps must be positive and non-decreasing")]
fn init_rejects_decreasing_caps() {
    set(&owner(), 0);
    Contract::init(U64(H), [U128(10), U128(3)], U64(DAY));
}

#[test]
fn is_certified_false_after_expiry() {
    let mut c = contract();
    certify(&mut c, 2); // ttl 7 days from day 10
    set_at(&signer(), 0, 17 * DAY + 1);
    assert!(!c.is_certified(agent(), signer(), 1));
}

#[test]
fn agent_listed_as_signer_never_counts() {
    // Unreachable through the public API (validate_signers refuses it); the
    // filter in level_of is a second line of defence, so exercise it directly.
    let mut c = contract();
    let id = vault_with(&mut c, vec![signer(), signer2()], Policy::Any, 10 * NEAR);
    certify(&mut c, 1);
    c.vaults.get_mut(&id).unwrap().trusted_signers = vec![signer(), agent()];
    c.certs.insert(
        (agent(), agent()),
        Cert {
            level: 2,
            suite_version: 1,
            suite_hash: hash('a'),
            hidden_count: 0,
            report_hash: hash('b'),
            config_hash: hash('c'),
            endpoint_class: EndpointClass::Attested,
            run_ref: None,
            issued_ns: U64(0),
            expires_ns: U64(u64::MAX),
        },
    );
    assert_eq!(c.effective_level(id), Some(1)); // Any: the agent's own level 2 is skipped
    c.vaults.get_mut(&id).unwrap().policy = Policy::All;
    assert_eq!(c.effective_level(id), None); // All: the agent's slot blocks
}

// One-time permits: a spent permit leaves a same-size tombstone, so a failed transfer can give it
// back, but never over a newer grant and never to a receiver removed meanwhile.
fn permit_vault(c: &mut Contract) -> u64 {
    let id = vault(c);
    certify(c, 2);
    set(&owner(), 1);
    c.set_permits_required(id, true);
    set(&owner(), 1);
    c.grant_permit(id, shop(), U128(NEAR), None);
    id
}

#[test]
fn spent_permit_is_not_revived_for_a_receiver_removed_in_flight() {
    let mut c = contract();
    let id = permit_vault(&mut c);
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), None);
    set(&owner(), 1);
    c.set_receivers(id, vec![acc("other.near")]);
    callback_env(PromiseResult::Failed);
    let p = Permit { max_amount: U128(NEAR), expires_ns: None };
    assert!(!c.on_transfer_done(id, owner(), 10 * DAY / H, U128(NEAR), Some((shop(), p))));
    assert!(c.get_permit(id, shop()).is_none());
    set(&owner(), 1);
    c.set_receivers(id, vec![shop()]);
    assert!(c.get_permit(id, shop()).is_none(), "stale permit revived");
}

#[test]
fn failed_transfer_gives_the_permit_back_over_its_tombstone_only() {
    let mut c = contract();
    let id = permit_vault(&mut c);
    let balance = c.get_vault(id).unwrap().balance.0;
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), None);
    assert_eq!(c.get_vault(id).unwrap().balance.0, balance - NEAR, "the vault moves by exactly the amount");
    assert!(c.get_permit(id, shop()).is_none());
    let p = Permit { max_amount: U128(NEAR), expires_ns: None };
    callback_env(PromiseResult::Failed);
    assert!(!c.on_transfer_done(id, owner(), 10 * DAY / H, U128(NEAR), Some((shop(), p.clone()))));
    assert_eq!(c.get_permit(id, shop()).unwrap().max_amount.0, NEAR);

    // Spent again, then re-granted by the owner while in flight: the newer grant wins.
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), None);
    set(&owner(), 1);
    c.grant_permit(id, shop(), U128(NEAR / 2), None);
    callback_env(PromiseResult::Failed);
    assert!(!c.on_transfer_done(id, owner(), 10 * DAY / H, U128(NEAR), Some((shop(), p))));
    assert_eq!(c.get_permit(id, shop()).unwrap().max_amount.0, NEAR / 2);
}

#[test]
#[should_panic(expected = "no permit for this receiver")]
fn a_spent_permit_cannot_be_revoked_or_spent_twice() {
    let mut c = contract();
    let id = permit_vault(&mut c);
    set(&agent(), 0);
    let _ = c.spend(id, shop(), U128(NEAR), None);
    set(&owner(), 1);
    c.revoke_permit(id, shop());
}
