// Clearance: agent vaults whose spending is capped by the agent's crash-test level.
// An agent spends from its vault only while every trusted signer (policy All) or
// at least one (policy Any) holds a live certificate for it; the cap is
// min(owner cap, level cap) over a rolling 24-bucket window.
//
// One-time permits (optional, per vault): with `set_permits_required` on, a spend
// also needs a permit the owner granted for that receiver (`grant_permit`, up to a
// maximum amount, optionally until a deadline). The spend consumes it, so a second
// payment, a "pay the remainder" or a re-issued invoice to the same receiver is
// refused until the owner grants another. Permits live under their own storage keys
// (prefixes P and Q), so vaults and certificates stored before this feature read as
// before.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near, require,
};

mod window;
use window::Buckets;

const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MIN_GAS_FOR_SPEND: Gas = Gas::from_tgas(25);
const MAX_RECEIVERS: usize = 10;
const MAX_SIGNERS: usize = 3;
const MAX_MEMO_BYTES: usize = 256;
const MAX_RUN_REF_BYTES: usize = 128;
/// First storage deposit must cover the new balance entry itself.
const MIN_FIRST_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    All,
    Any,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EndpointClass {
    Allowlist,
    Attested,
    Foreign,
}

/// A one-time permission to pay one receiver up to `max_amount`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Permit {
    pub max_amount: U128,
    pub expires_ns: Option<U64>,
}

fn permit_key(vault_id: u64, receiver: &AccountId) -> Vec<u8> {
    [b"P".as_slice(), &vault_id.to_le_bytes(), receiver.as_bytes()].concat()
}

fn required_key(vault_id: u64) -> Vec<u8> {
    [b"Q".as_slice(), &vault_id.to_le_bytes()].concat()
}

/// The stored value, including a spent permit (a tombstone with `max_amount` 0).
fn read_permit_raw(vault_id: u64, receiver: &AccountId) -> Option<Permit> {
    env::storage_read(&permit_key(vault_id, receiver))
        .and_then(|b| near_sdk::borsh::from_slice::<Permit>(&b).ok())
}

/// A usable permit: present and not spent.
fn read_permit(vault_id: u64, receiver: &AccountId) -> Option<Permit> {
    read_permit_raw(vault_id, receiver).filter(|p| p.max_amount.0 > 0)
}

fn write_permit(vault_id: u64, receiver: &AccountId, p: &Permit) {
    let bytes = near_sdk::borsh::to_vec(p).unwrap_or_else(|_| fail("permit encoding"));
    env::storage_write(&permit_key(vault_id, receiver), &bytes);
}

fn permits_required(vault_id: u64) -> bool {
    env::storage_has_key(&required_key(vault_id))
}

#[near(serializers = [borsh])]
pub struct Vault {
    pub owner: AccountId,
    pub agent: AccountId,
    pub balance: u128,
    pub owner_cap: u128,
    pub receivers: Vec<AccountId>,
    pub trusted_signers: Vec<AccountId>,
    pub policy: Policy,
    pub min_suite_version: u32,
    pub min_hidden: u32,
    pub allow_foreign_endpoint: bool,
    pub paused: bool,
    pub buckets: Buckets,
    pub pending: u32,
    /// Storage staking taken from the owner's deposits; refunded on close.
    pub storage_paid: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Cert {
    pub level: u8,
    pub suite_version: u32,
    pub suite_hash: String,
    pub hidden_count: u32,
    pub report_hash: String,
    pub config_hash: String,
    pub endpoint_class: EndpointClass,
    pub run_ref: Option<String>,
    pub issued_ns: U64,
    pub expires_ns: U64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub balance: U128,
    pub owner_cap: U128,
    pub receivers: Vec<AccountId>,
    pub trusted_signers: Vec<AccountId>,
    pub policy: Policy,
    pub min_suite_version: u32,
    pub min_hidden: u32,
    pub allow_foreign_endpoint: bool,
    pub paused: bool,
    pub pending: u32,
    pub storage_paid: U128,
    pub window_spent: U128,
    pub effective_level: Option<u8>,
    pub effective_cap: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    bucket_ns: u64,
    level_caps: [u128; 2],
    max_cert_ttl_ns: u64,
    next_vault_id: u64,
    vaults: IterableMap<u64, Vault>,
    certs: LookupMap<(AccountId, AccountId), Cert>,
    storage_balance: LookupMap<AccountId, u128>,
}

fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}

fn storage_cost(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

fn emit(event: &str, data: Value) {
    let log =
        json!({ "standard": "clearance", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_receivers(receivers: &[AccountId]) {
    require!(receivers.len() <= MAX_RECEIVERS, "at most 10 receivers");
    for (i, r) in receivers.iter().enumerate() {
        require!(!receivers[..i].contains(r), "duplicate receiver");
        // Funds sent to the contract itself would leave vault accounting.
        require!(
            r != &env::current_account_id(),
            "contract cannot be a receiver"
        );
    }
}

fn validate_signers(owner: &AccountId, agent: &AccountId, signers: &[AccountId]) {
    require!(
        (1..=MAX_SIGNERS).contains(&signers.len()),
        "need 1 to 3 trusted signers"
    );
    for (i, s) in signers.iter().enumerate() {
        require!(s != owner, "owner cannot be a trusted signer");
        require!(s != agent, "agent cannot be a trusted signer");
        require!(!signers[..i].contains(s), "duplicate trusted signer");
    }
}

#[near]
impl Contract {
    /// Production: bucket 1h, caps [3, 10] NEAR. The crash-test sandbox uses the
    /// same wasm with a 1s bucket and caps [100, 100].
    #[init]
    pub fn init(bucket_ns: U64, level_caps: [U128; 2], max_cert_ttl_ns: U64) -> Self {
        require!(bucket_ns.0 > 0, "bucket_ns must be positive");
        require!(max_cert_ttl_ns.0 > 0, "max_cert_ttl_ns must be positive");
        require!(
            level_caps[0].0 > 0 && level_caps[0].0 <= level_caps[1].0,
            "level caps must be positive and non-decreasing"
        );
        Self {
            bucket_ns: bucket_ns.0,
            level_caps: [level_caps[0].0, level_caps[1].0],
            max_cert_ttl_ns: max_cert_ttl_ns.0,
            next_vault_id: 0,
            vaults: IterableMap::new(b"v"),
            certs: LookupMap::new(b"c"),
            storage_balance: LookupMap::new(b"s"),
        }
    }

    fn now_bucket(&self) -> u64 {
        env::block_timestamp() / self.bucket_ns
    }

    fn cert_usable(c: &Cert, v: &Vault, now_ns: u64) -> bool {
        c.expires_ns.0 > now_ns
            && c.suite_version >= v.min_suite_version
            && c.hidden_count >= v.min_hidden
            && (v.allow_foreign_endpoint || c.endpoint_class != EndpointClass::Foreign)
    }

    fn level_of(&self, v: &Vault, now_ns: u64) -> Option<u8> {
        if v.trusted_signers.is_empty() {
            return None;
        }
        let mut levels = v.trusted_signers.iter().map(|s| {
            // Re-checked here, not only in validate_signers: an agent's own
            // certificate never counts (under All it blocks, under Any it is skipped).
            if s == &v.agent {
                return None;
            }
            self.certs
                .get(&(v.agent.clone(), s.clone()))
                .filter(|c| Self::cert_usable(c, v, now_ns))
                .map(|c| c.level)
        });
        match v.policy {
            Policy::All => levels.try_fold(u8::MAX, |min, l| l.map(|l| min.min(l))),
            Policy::Any => levels.flatten().max(),
        }
    }

    fn vault_mut(&mut self, vault_id: u64) -> &mut Vault {
        self.vaults
            .get_mut(&vault_id)
            .unwrap_or_else(|| fail("no vault"))
    }

    fn owned_vault_mut(&mut self, vault_id: u64) -> &mut Vault {
        let v = self.vault_mut(vault_id);
        require!(
            env::predecessor_account_id() == v.owner,
            "only the vault owner"
        );
        v
    }

    /// Owner-only settings change; storage growth is paid from the vault balance
    /// and shrinkage is refunded to it.
    fn update_settings(&mut self, vault_id: u64, f: impl FnOnce(&mut Vault)) {
        assert_one_yocto();
        let before = env::storage_usage();
        f(self.owned_vault_mut(vault_id));
        self.vaults.flush();
        let after = env::storage_usage();
        let v = self.vault_mut(vault_id);
        if after > before {
            let cost = storage_cost(after - before);
            require!(v.balance >= cost, "vault balance cannot cover storage");
            v.balance -= cost;
            v.storage_paid += cost;
        } else {
            let refund = storage_cost(before - after).min(v.storage_paid);
            v.storage_paid -= refund;
            v.balance += refund;
        }
    }

    fn charge_storage(&mut self, who: &AccountId, before: u64, after: u64) {
        let bal = self.storage_balance.get(who).copied().unwrap_or(0);
        let new_bal = if after > before {
            let cost = storage_cost(after - before);
            require!(
                bal >= cost,
                "not enough prepaid storage; call storage_deposit"
            );
            bal - cost
        } else {
            bal.saturating_add(storage_cost(before - after))
        };
        self.storage_balance.insert(who.clone(), new_bal);
    }

    /// Adds to an account's storage balance. A new entry pays for its own
    /// storage out of `amount`; if `amount` cannot cover it, the money stays
    /// with the contract and is logged.
    fn credit_storage(&mut self, who: &AccountId, amount: u128) -> u128 {
        if let Some(bal) = self.storage_balance.get(who).copied() {
            let new_bal = bal.saturating_add(amount);
            self.storage_balance.insert(who.clone(), new_bal);
            return new_bal;
        }
        let before = env::storage_usage();
        self.storage_balance.insert(who.clone(), amount);
        self.storage_balance.flush();
        let cost = storage_cost(env::storage_usage() - before);
        if amount < cost {
            self.storage_balance.remove(who);
            env::log_str(&format!(
                "{amount} yoctoNEAR for {who} kept: below entry storage cost"
            ));
            return 0;
        }
        self.storage_balance.insert(who.clone(), amount - cost);
        amount - cost
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_vault(
        &mut self,
        agent: AccountId,
        owner_cap: U128,
        receivers: Vec<AccountId>,
        trusted_signers: Vec<AccountId>,
        policy: Policy,
        min_suite_version: u32,
        min_hidden: u32,
        allow_foreign_endpoint: bool,
    ) -> u64 {
        let owner = env::predecessor_account_id();
        require!(agent != owner, "agent must differ from owner");
        validate_receivers(&receivers);
        validate_signers(&owner, &agent, &trusted_signers);
        let id = self.next_vault_id;
        self.next_vault_id = id
            .checked_add(1)
            .unwrap_or_else(|| fail("vault id overflow"));

        let before = env::storage_usage();
        self.vaults.insert(
            id,
            Vault {
                owner: owner.clone(),
                agent: agent.clone(),
                balance: 0,
                owner_cap: owner_cap.0,
                receivers,
                trusted_signers,
                policy,
                min_suite_version,
                min_hidden,
                allow_foreign_endpoint,
                paused: false,
                buckets: Buckets::default(),
                pending: 0,
                storage_paid: 0,
            },
        );
        self.vaults.flush();
        let cost = storage_cost(env::storage_usage() - before);
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit < cost {
            fail(&format!("attach at least {cost} yoctoNEAR for storage"));
        }
        let v = self.vault_mut(id);
        v.balance = deposit - cost;
        v.storage_paid = cost;
        emit(
            "vault_created",
            json!({ "vault_id": id, "owner": owner, "agent": agent, "balance": U128(deposit - cost) }),
        );
        id
    }

    #[payable]
    pub fn deposit(&mut self, vault_id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach a deposit");
        let v = self.owned_vault_mut(vault_id);
        v.balance = v
            .balance
            .checked_add(amount)
            .unwrap_or_else(|| fail("overflow"));
    }

    #[payable]
    pub fn set_receivers(&mut self, vault_id: u64, receivers: Vec<AccountId>) {
        validate_receivers(&receivers);
        self.update_settings(vault_id, |v| {
            // A permit only makes sense for a listed receiver; drop those of removed ones.
            for r in v.receivers.iter().filter(|r| !receivers.contains(r)) {
                env::storage_remove(&permit_key(vault_id, r));
            }
            v.receivers = receivers;
        });
    }

    /// Owner: require a one-time permit for every spend from this vault (or stop requiring it).
    #[payable]
    pub fn set_permits_required(&mut self, vault_id: u64, required: bool) {
        self.update_settings(vault_id, |_| {
            if required {
                env::storage_write(&required_key(vault_id), &[1]);
            } else {
                env::storage_remove(&required_key(vault_id));
            }
        });
        emit(
            "permits_required",
            json!({ "vault_id": vault_id, "required": required }),
        );
    }

    /// Owner: allow one payment to `receiver` of at most `max_amount`, optionally until
    /// `expires_ns`. Replaces an unused permit for the same receiver.
    #[payable]
    pub fn grant_permit(
        &mut self,
        vault_id: u64,
        receiver: AccountId,
        max_amount: U128,
        expires_ns: Option<U64>,
    ) {
        require!(max_amount.0 > 0, "max_amount must be positive");
        if let Some(e) = expires_ns {
            require!(e.0 > env::block_timestamp(), "permit already expired");
        }
        let permit = Permit {
            max_amount,
            expires_ns,
        };
        self.update_settings(vault_id, |v| {
            require!(v.receivers.contains(&receiver), "receiver not allowed");
            write_permit(vault_id, &receiver, &permit);
        });
        emit(
            "permit_granted",
            json!({ "vault_id": vault_id, "receiver": receiver, "max_amount": max_amount, "expires_ns": expires_ns }),
        );
    }

    /// Owner: withdraw an unused permit.
    #[payable]
    pub fn revoke_permit(&mut self, vault_id: u64, receiver: AccountId) {
        self.update_settings(vault_id, |_| {
            require!(
                read_permit(vault_id, &receiver).is_some(),
                "no permit for this receiver"
            );
            env::storage_remove(&permit_key(vault_id, &receiver));
        });
        emit(
            "permit_revoked",
            json!({ "vault_id": vault_id, "receiver": receiver }),
        );
    }

    #[payable]
    pub fn set_trusted_signers(&mut self, vault_id: u64, signers: Vec<AccountId>, policy: Policy) {
        self.update_settings(vault_id, |v| {
            validate_signers(&v.owner, &v.agent, &signers);
            v.trusted_signers = signers;
            v.policy = policy;
        });
    }

    #[payable]
    pub fn set_min_suite(
        &mut self,
        vault_id: u64,
        version: u32,
        min_hidden: u32,
        allow_foreign: bool,
    ) {
        self.update_settings(vault_id, |v| {
            v.min_suite_version = version;
            v.min_hidden = min_hidden;
            v.allow_foreign_endpoint = allow_foreign;
        });
    }

    #[payable]
    pub fn set_owner_cap(&mut self, vault_id: u64, owner_cap: U128) {
        self.update_settings(vault_id, |v| v.owner_cap = owner_cap.0);
    }

    #[payable]
    pub fn set_paused(&mut self, vault_id: u64, paused: bool) {
        self.update_settings(vault_id, |v| v.paused = paused);
    }

    #[payable]
    pub fn withdraw(&mut self, vault_id: u64, amount: U128) -> Promise {
        assert_one_yocto();
        let v = self.owned_vault_mut(vault_id);
        require!(amount.0 > 0, "amount must be positive");
        require!(v.balance >= amount.0, "insufficient vault balance");
        v.balance -= amount.0;
        v.pending += 1;
        let owner = v.owner.clone();
        emit(
            "withdraw",
            json!({ "vault_id": vault_id, "amount": amount }),
        );
        Promise::new(owner.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw_done(vault_id, owner, amount),
            )
    }

    /// Deletes the vault and returns its balance plus storage staking to the owner.
    #[payable]
    pub fn close_vault(&mut self, vault_id: u64) -> Promise {
        assert_one_yocto();
        let v = self.owned_vault_mut(vault_id);
        require!(v.pending == 0, "transfers still pending");
        let owner = v.owner.clone();
        let amount = v.balance + v.storage_paid;
        for r in v.receivers.clone() {
            env::storage_remove(&permit_key(vault_id, &r));
        }
        env::storage_remove(&required_key(vault_id));
        self.vaults.remove(&vault_id);
        emit(
            "vault_closed",
            json!({ "vault_id": vault_id, "amount": U128(amount) }),
        );
        Promise::new(owner.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_refund_done(owner, U128(amount)),
            )
    }

    pub fn spend(
        &mut self,
        vault_id: u64,
        receiver: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_GAS_FOR_SPEND,
            "attach at least 25 Tgas"
        );
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        if let Some(m) = &memo {
            require!(m.len() <= MAX_MEMO_BYTES, "memo longer than 256 bytes");
        }
        let now_ns = env::block_timestamp();
        let now_bucket = self.now_bucket();

        let v = self
            .vaults
            .get(&vault_id)
            .unwrap_or_else(|| fail("no vault"));
        require!(!v.paused, "vault is paused");
        require!(
            env::predecessor_account_id() == v.agent,
            "only the vault agent can spend"
        );
        require!(v.receivers.contains(&receiver), "receiver not allowed");
        let level = self
            .level_of(v, now_ns)
            .unwrap_or_else(|| fail("no valid certificate"));
        let cap = v.owner_cap.min(self.level_caps[usize::from(level) - 1]);

        let permit = if permits_required(vault_id) {
            let p = read_permit(vault_id, &receiver)
                .unwrap_or_else(|| fail("no permit for this receiver"));
            require!(
                p.expires_ns.is_none_or(|e| e.0 > now_ns),
                "permit expired"
            );
            require!(amount <= p.max_amount.0, "above the permit's amount");
            Some(p)
        } else {
            None
        };

        let v = self.vault_mut(vault_id);
        let spent = v.buckets.window_sum(now_bucket);
        require!(
            spent.checked_add(amount).is_some_and(|s| s <= cap),
            "over window cap"
        );
        require!(v.balance >= amount, "insufficient vault balance");

        if let Some(p) = &permit {
            // Spent now: overwritten by a tombstone of the same size, so storage does not change and
            // the vault balance moves by exactly `amount`. The callback restores it only if the
            // tombstone is still there (not re-granted, not removed with its receiver).
            write_permit(
                vault_id,
                &receiver,
                &Permit {
                    max_amount: U128(0),
                    expires_ns: p.expires_ns,
                },
            );
            emit(
                "permit_used",
                json!({ "vault_id": vault_id, "receiver": receiver, "amount": U128(amount) }),
            );
        }

        let owner = v.owner.clone();
        // Effects before the interaction; the callback undoes them on failure.
        v.balance -= amount;
        v.buckets.record(now_bucket, amount);
        v.pending += 1;
        emit(
            "spend",
            json!({ "vault_id": vault_id, "receiver": receiver, "amount": U128(amount), "bucket": now_bucket, "level": level, "memo": memo }),
        );
        let receiver_for_callback = receiver.clone();
        Promise::new(receiver)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_done(
                        vault_id,
                        owner,
                        now_bucket,
                        U128(amount),
                        permit.map(|p| (receiver_for_callback, p)),
                    ),
            )
    }

    /// Must not panic: a panic here would leave funds outside vault accounting.
    #[private]
    /// Returns whether the transfer landed; the outer `spend` transaction
    /// succeeds either way, so callers must read this value or the events.
    pub fn on_transfer_done(
        &mut self,
        vault_id: u64,
        owner: AccountId,
        bucket: u64,
        amount: U128,
        permit: Option<(AccountId, Permit)>,
    ) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        match self.vaults.get_mut(&vault_id) {
            Some(v) => {
                v.pending = v.pending.saturating_sub(1);
                if !ok {
                    v.balance = v.balance.saturating_add(amount.0);
                    v.buckets.unrecord(bucket, amount.0);
                    // The payment did not happen, so its permit is given back, but only over its own
                    // tombstone: a receiver removed meanwhile, or a newer grant, wins.
                    if let Some((receiver, p)) = &permit {
                        let spent = read_permit_raw(vault_id, receiver).is_some_and(|t| t.max_amount.0 == 0);
                        if spent && v.receivers.contains(receiver) {
                            write_permit(vault_id, receiver, p);
                        }
                    }
                }
            }
            // Unreachable while close_vault requires pending == 0; never lose the money.
            None if !ok => {
                self.credit_storage(&owner, amount.0);
            }
            None => {}
        }
        if !ok {
            emit(
                "spend_refunded",
                json!({ "vault_id": vault_id, "amount": amount, "bucket": bucket }),
            );
        }
        ok
    }

    #[private]
    pub fn on_withdraw_done(&mut self, vault_id: u64, owner: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        match self.vaults.get_mut(&vault_id) {
            Some(v) => {
                v.pending = v.pending.saturating_sub(1);
                if !ok {
                    v.balance = v.balance.saturating_add(amount.0);
                }
            }
            None if !ok => {
                self.credit_storage(&owner, amount.0);
            }
            None => {}
        }
        if !ok {
            emit(
                "withdraw_failed",
                json!({ "vault_id": vault_id, "amount": amount }),
            );
        }
        ok
    }

    /// For transfers whose source record is gone (closed vault, storage
    /// withdrawal): on failure the amount lands in the account's storage balance.
    #[private]
    pub fn on_refund_done(&mut self, account_id: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        if !ok {
            self.credit_storage(&account_id, amount.0);
            emit(
                "refund_failed",
                json!({ "account_id": account_id, "amount": amount }),
            );
        }
        ok
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let add = env::attached_deposit().as_yoctonear();
        let cur = self.storage_balance.get(&who).copied();
        let min = if cur.is_some() {
            1
        } else {
            MIN_FIRST_STORAGE_DEPOSIT.as_yoctonear()
        };
        require!(
            add >= min,
            "first storage deposit must be at least 0.01 NEAR"
        );
        U128(self.credit_storage(&who, add))
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let bal = self.storage_balance.get(&who).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= bal, "invalid amount");
        let mut payout = amount.0;
        if bal == amount.0 {
            // Emptied: drop the entry and return the storage it was paying for.
            let before = env::storage_usage();
            self.storage_balance.remove(&who);
            self.storage_balance.flush();
            payout += storage_cost(before - env::storage_usage());
        } else {
            self.storage_balance.insert(who.clone(), bal - amount.0);
        }
        let amount = U128(payout);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(payout))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_refund_done(who, amount),
            )
    }

    /// No deposit, so a function-call key can call it; storage comes from the
    /// signer's prepaid balance. One slot per (agent, signer); re-certify overwrites.
    #[allow(clippy::too_many_arguments)]
    pub fn certify(
        &mut self,
        agent: AccountId,
        level: u8,
        suite_version: u32,
        suite_hash: String,
        hidden_count: u32,
        report_hash: String,
        config_hash: String,
        endpoint_class: EndpointClass,
        run_ref: Option<String>,
        ttl_ns: U64,
    ) {
        let signer = env::predecessor_account_id();
        require!(signer != agent, "agent cannot certify itself");
        require!(level == 1 || level == 2, "level must be 1 or 2");
        require!(
            is_hex64(&suite_hash) && is_hex64(&report_hash) && is_hex64(&config_hash),
            "hashes must be 64 lowercase hex chars"
        );
        require!(
            ttl_ns.0 > 0 && ttl_ns.0 <= self.max_cert_ttl_ns,
            "ttl out of range"
        );
        if let Some(r) = &run_ref {
            require!(
                r.len() <= MAX_RUN_REF_BYTES,
                "run_ref longer than 128 bytes"
            );
        }
        let now = env::block_timestamp();
        let before = env::storage_usage();
        self.certs.insert(
            (agent.clone(), signer.clone()),
            Cert {
                level,
                suite_version,
                suite_hash,
                hidden_count,
                report_hash: report_hash.clone(),
                config_hash,
                endpoint_class,
                run_ref: run_ref.clone(),
                issued_ns: U64(now),
                expires_ns: U64(now.saturating_add(ttl_ns.0)),
            },
        );
        self.certs.flush();
        self.charge_storage(&signer, before, env::storage_usage());
        emit(
            "certify",
            json!({ "agent": agent, "signer": signer, "level": level, "report_hash": report_hash, "run_ref": run_ref }),
        );
    }

    pub fn revoke(&mut self, agent: AccountId) {
        let signer = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(
            self.certs
                .remove(&(agent.clone(), signer.clone()))
                .is_some(),
            "no certificate to revoke"
        );
        self.certs.flush();
        self.charge_storage(&signer, before, env::storage_usage());
        emit("revoke", json!({ "agent": agent, "signer": signer }));
    }

    // Views

    pub fn get_vault(&self, vault_id: u64) -> Option<VaultView> {
        let v = self.vaults.get(&vault_id)?;
        let level = self.level_of(v, env::block_timestamp());
        Some(VaultView {
            owner: v.owner.clone(),
            agent: v.agent.clone(),
            balance: U128(v.balance),
            owner_cap: U128(v.owner_cap),
            receivers: v.receivers.clone(),
            trusted_signers: v.trusted_signers.clone(),
            policy: v.policy,
            min_suite_version: v.min_suite_version,
            min_hidden: v.min_hidden,
            allow_foreign_endpoint: v.allow_foreign_endpoint,
            paused: v.paused,
            pending: v.pending,
            storage_paid: U128(v.storage_paid),
            window_spent: U128(v.buckets.window_sum(self.now_bucket())),
            effective_level: level,
            effective_cap: level
                .map(|l| U128(v.owner_cap.min(self.level_caps[usize::from(l) - 1]))),
        })
    }

    pub fn effective_level(&self, vault_id: u64) -> Option<u8> {
        let v = self.vaults.get(&vault_id)?;
        self.level_of(v, env::block_timestamp())
    }

    pub fn get_permit(&self, vault_id: u64, receiver: AccountId) -> Option<Permit> {
        read_permit(vault_id, &receiver)
    }

    pub fn get_permits_required(&self, vault_id: u64) -> bool {
        permits_required(vault_id)
    }

    pub fn get_cert(&self, agent: AccountId, signer: AccountId) -> Option<Cert> {
        self.certs.get(&(agent, signer)).cloned()
    }

    /// True if `signer` holds an unexpired certificate for `agent` at `level` or
    /// higher. Weaker than what `spend` checks: it ignores a vault's minimum
    /// suite version, hidden-slice count and endpoint class, and trusts whatever
    /// `signer` the caller names. Read `get_cert` to apply those filters.
    pub fn is_certified(&self, agent: AccountId, signer: AccountId, level: u8) -> bool {
        level >= 1
            && self
                .certs
                .get(&(agent, signer))
                .is_some_and(|c| c.level >= level && c.expires_ns.0 > env::block_timestamp())
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage_balance.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_config(&self) -> Value {
        json!({
            "bucket_ns": U64(self.bucket_ns),
            "level_caps": [U128(self.level_caps[0]), U128(self.level_caps[1])],
            "max_cert_ttl_ns": U64(self.max_cert_ttl_ns),
            "next_vault_id": self.next_vault_id,
        })
    }
}

#[cfg(test)]
mod tests;
