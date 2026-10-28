//! An example consumer of the Clearance registry, written as a third party would: it only calls the
//! registry's public view `get_cert` across contracts and decides for itself.
//!
//! An owner funds an allowance for one agent. The agent asks for payouts to receivers the owner listed.
//! Before every payout the gate reads the agent's certificate from the registry, as issued by the signer
//! the owner trusts, and pays only if it is live: level 1 allows 1 NEAR per payout and 3 a day, level 2
//! allows 3 and 10. A revoked or expired certificate stops payouts at once, with no action by the owner.
use near_sdk::json_types::{U128, U64};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, ext_contract, log, near, require};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);

/// The fields of the registry's `Cert` this gate reads (it ignores the rest).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CertView {
    pub level: u8,
    pub expires_ns: U64,
    pub suite_version: u32,
}

#[ext_contract(registry)]
pub trait Registry {
    fn get_cert(&self, agent: AccountId, signer: AccountId) -> Option<CertView>;
}

/// Per-payout and daily caps for a certificate level (in yoctoNEAR); level 0 or none: nothing.
pub fn caps(level: u8) -> (u128, u128) {
    match level {
        1 => (NEAR, 3 * NEAR),
        l if l >= 2 => (3 * NEAR, 10 * NEAR),
        _ => (0, 0),
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gate {
    owner: AccountId,
    agent: AccountId,
    registry: AccountId,
    trusted_signer: AccountId,
    receivers: Vec<AccountId>,
    day_start_ns: u64,
    spent_today: u128,
}

#[near]
impl Gate {
    /// The caller is the owner; the attached deposit is the allowance.
    #[init]
    #[payable]
    pub fn new(agent: AccountId, registry: AccountId, trusted_signer: AccountId, receivers: Vec<AccountId>) -> Self {
        require!(!receivers.is_empty() && receivers.len() <= 10, "1 to 10 receivers");
        require!(!receivers.contains(&agent), "the agent cannot be its own receiver");
        Self { owner: env::predecessor_account_id(), agent, registry, trusted_signer, receivers, day_start_ns: env::block_timestamp(), spent_today: 0 }
    }

    /// The agent asks for a payout; the decision is made in `on_cert` once the registry answers.
    pub fn payout(&mut self, receiver: AccountId, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "only the agent can ask for a payout");
        require!(self.receivers.contains(&receiver), "receiver not allowed by the owner");
        require!(amount.0 > 0, "amount must be positive");
        registry::ext(self.registry.clone())
            .with_static_gas(GAS_VIEW)
            .get_cert(self.agent.clone(), self.trusted_signer.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_cert(receiver, amount))
    }

    /// Pays if the certificate is live and the payout fits its level's caps. Returns whether it paid.
    #[private]
    pub fn on_cert(&mut self, receiver: AccountId, amount: U128, #[callback_result] cert: Result<Option<CertView>, PromiseError>) -> bool {
        let now = env::block_timestamp();
        let level = match cert {
            Ok(Some(c)) if c.expires_ns.0 > now => c.level,
            Ok(Some(_)) => return refuse("certificate expired"),
            Ok(None) => return refuse("no certificate from the trusted signer (never issued or revoked)"),
            Err(_) => return refuse("registry did not answer"),
        };
        if now >= self.day_start_ns + DAY_NS {
            self.day_start_ns = now;
            self.spent_today = 0;
        }
        let (per_payout, per_day) = caps(level);
        if amount.0 > per_payout {
            return refuse("above the per-payout cap for the agent's level");
        }
        if self.spent_today + amount.0 > per_day {
            return refuse("above the daily cap for the agent's level");
        }
        if amount.0 > env::account_balance().as_yoctonear().saturating_sub(env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage())) {
            return refuse("allowance exhausted");
        }
        self.spent_today += amount.0;
        log!("paid {} yocto to {} under a level-{} certificate", amount.0, receiver, level);
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0)).detach();
        true
    }

    /// The owner takes the rest of the allowance back.
    pub fn close(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        let keep = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(env::account_balance().as_yoctonear().saturating_sub(keep)))
    }

    pub fn get_state(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "owner": self.owner, "agent": self.agent, "registry": self.registry, "trusted_signer": self.trusted_signer,
            "receivers": self.receivers, "spent_today": U128(self.spent_today), "day_start_ns": U64(self.day_start_ns),
        })
    }
}

fn refuse(why: &str) -> bool {
    log!("refused: {}", why);
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;

    fn ctx(predecessor: &str, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("gate.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .account_balance(NearToken::from_near(20))
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_near(20))
            .build());
    }
    fn gate() -> Gate {
        ctx("owner.testnet", 1_000);
        Gate::new("agent.testnet".parse().unwrap(), "registry.testnet".parse().unwrap(), "signer.testnet".parse().unwrap(), vec!["shop.testnet".parse().unwrap()])
    }
    fn cert(level: u8, expires: u64) -> Result<Option<CertView>, PromiseError> {
        Ok(Some(CertView { level, expires_ns: U64(expires), suite_version: 1 }))
    }
    const SHOP: &str = "shop.testnet";

    #[test]
    fn level_two_pays_within_caps_and_refuses_above() {
        let mut g = gate();
        ctx("gate.testnet", 2_000);
        assert!(g.on_cert(SHOP.parse().unwrap(), U128(3 * NEAR), cert(2, 10_000)));
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(3 * NEAR + 1), cert(2, 10_000)));
        assert!(get_logs().iter().any(|l| l.contains("per-payout cap")));
    }

    #[test]
    fn daily_cap_follows_the_level_and_resets_after_a_day() {
        let mut g = gate();
        ctx("gate.testnet", 2_000);
        for _ in 0..3 {
            assert!(g.on_cert(SHOP.parse().unwrap(), U128(NEAR), cert(1, u64::MAX)));
        }
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(NEAR), cert(1, u64::MAX)));
        ctx("gate.testnet", 2_000 + DAY_NS);
        assert!(g.on_cert(SHOP.parse().unwrap(), U128(NEAR), cert(1, u64::MAX)));
    }

    #[test]
    fn no_revoked_or_expired_certificate_means_no_payout() {
        let mut g = gate();
        ctx("gate.testnet", 5_000);
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(1), Ok(None)));
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(1), cert(2, 4_999)));
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(1), cert(0, u64::MAX)));
        assert!(!g.on_cert(SHOP.parse().unwrap(), U128(1), Err(PromiseError::Failed)));
    }

    #[test]
    #[should_panic(expected = "only the agent")]
    fn only_the_agent_asks() {
        let mut g = gate();
        ctx("stranger.testnet", 2_000);
        let _ = g.payout(SHOP.parse().unwrap(), U128(1));
    }

    #[test]
    #[should_panic(expected = "receiver not allowed")]
    fn only_listed_receivers() {
        let mut g = gate();
        ctx("agent.testnet", 2_000);
        let _ = g.payout("evil.testnet".parse().unwrap(), U128(1));
    }
}
