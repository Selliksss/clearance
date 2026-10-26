// End-to-end checks against the real wasm in near-sandbox. Buckets are 1s so the
// 24-bucket window can be crossed with fast_forward.
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;
use testresult::TestResult;

const BUCKET_NS: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;

fn near(n: u128) -> String {
    NearToken::from_near(n).as_yoctonear().to_string()
}

struct Env {
    sandbox: Sandbox,
    net: NetworkConfig,
    key: Arc<Signer>,
    contract: Contract,
}

impl Env {
    async fn start() -> TestResult<Self> {
        let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
        let sandbox = Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let key = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let id: AccountId = "clearance.sandbox".parse()?;
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;
        Contract::deploy(id.clone())
            .use_code(wasm)
            .with_init_call(
                "init",
                json!({ "bucket_ns": BUCKET_NS.to_string(), "level_caps": [near(3), near(10)], "max_cert_ttl_ns": (30 * DAY_NS).to_string() }),
            )?
            .with_signer(key.clone())
            .send_to(&net)
            .await?
            .assert_success();
        Ok(Self {
            sandbox,
            net,
            key,
            contract: Contract(id),
        })
    }

    async fn account(&self, name: &str) -> TestResult<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(30))
            .send()
            .await?;
        Ok(id)
    }

    async fn call(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<bool> {
        self.call_with(who, self.key.clone(), method, args, deposit)
            .await
    }

    async fn call_with(
        &self,
        who: &AccountId,
        key: Arc<Signer>,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<bool> {
        let mut tx = self
            .contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(60));
        // An explicit zero deposit makes near-api 0.8 send a transaction a
        // function-call key cannot sign; omit it instead.
        if !deposit.is_zero() {
            tx = tx.deposit(deposit);
        }
        // A transaction the node refuses outright (e.g. a function-call key
        // attaching a deposit) counts as "did not succeed", like a contract panic.
        match tx.with_signer(who.clone(), key).send_to(&self.net).await {
            Ok(res) => Ok(res.is_success()),
            Err(_) => Ok(false),
        }
    }

    async fn view(&self, method: &str, args: Value) -> TestResult<Value> {
        Ok(self
            .contract
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn vault(&self, id: u64) -> TestResult<Value> {
        self.view("get_vault", json!({ "vault_id": id })).await
    }

    async fn certify(
        &self,
        signer: &AccountId,
        agent: &AccountId,
        level: u8,
        class: &str,
    ) -> TestResult<bool> {
        self.certify_with(signer, self.key.clone(), agent, level, class)
            .await
    }

    async fn certify_with(
        &self,
        signer: &AccountId,
        key: Arc<Signer>,
        agent: &AccountId,
        level: u8,
        class: &str,
    ) -> TestResult<bool> {
        let h = |c: char| c.to_string().repeat(64);
        let args = json!({ "agent": agent, "level": level, "suite_version": 1, "suite_hash": h('a'), "hidden_count": 0,
            "report_hash": h('b'), "config_hash": h('c'), "endpoint_class": class, "run_ref": "run:1@abc", "ttl_ns": DAY_NS.to_string() });
        self.call_with(signer, key, "certify", args, NearToken::from_yoctonear(0))
            .await
    }

    async fn prepay(&self, who: &AccountId) -> TestResult<()> {
        assert!(
            self.call(
                who,
                "storage_deposit",
                json!({}),
                NearToken::from_millinear(100)
            )
            .await?
        );
        Ok(())
    }

    async fn spend(
        &self,
        agent: &AccountId,
        vault: u64,
        to: &AccountId,
        n: u128,
    ) -> TestResult<bool> {
        self.call(
            agent,
            "spend",
            json!({ "vault_id": vault, "receiver": to, "amount": near(n) }),
            NearToken::from_yoctonear(0),
        )
        .await
    }
}

fn yocto(v: &Value, field: &str) -> u128 {
    near_sdk::serde_json::from_value::<U128>(v[field].clone())
        .unwrap()
        .0
}

#[tokio::test]
async fn vault_lifecycle() -> TestResult<()> {
    let env = Env::start().await?;
    let owner = env.account("owner").await?;
    let agent = env.account("agent").await?;
    let signer = env.account("signer").await?;
    let shop = env.account("shop").await?;
    let ghost: AccountId = "ghost.shop.sandbox".parse()?;
    let zero = NearToken::from_yoctonear(0);
    let one = NearToken::from_yoctonear(1);

    // Owner as its own signer is refused.
    let bad = json!({ "agent": agent, "owner_cap": near(5), "receivers": [shop, ghost], "trusted_signers": [owner],
        "policy": "All", "min_suite_version": 1, "min_hidden": 0, "allow_foreign_endpoint": false });
    assert!(
        !env.call(&owner, "create_vault", bad, NearToken::from_near(8))
            .await?
    );

    let args = json!({ "agent": agent, "owner_cap": near(5), "receivers": [shop, ghost], "trusted_signers": [signer],
        "policy": "All", "min_suite_version": 1, "min_hidden": 0, "allow_foreign_endpoint": false });
    assert!(
        env.call(&owner, "create_vault", args, NearToken::from_near(20))
            .await?
    );
    let v = env.vault(0).await?;
    let start = yocto(&v, "balance");
    assert_eq!(
        start + yocto(&v, "storage_paid"),
        NearToken::from_near(20).as_yoctonear()
    );

    // No certificate: refused. Certify needs prepaid storage, then works with zero deposit.
    assert!(!env.spend(&agent, 0, &shop, 1).await?);
    assert!(!env.certify(&signer, &agent, 2, "Attested").await?);
    env.prepay(&signer).await?;
    assert!(env.certify(&signer, &agent, 2, "Attested").await?);

    // Level 2 (10) capped by owner (5): 2 + 2 pass, a third 2 exceeds.
    assert!(env.spend(&agent, 0, &shop, 2).await?);
    assert!(env.spend(&agent, 0, &shop, 2).await?);
    assert!(!env.spend(&agent, 0, &shop, 2).await?);
    // A receiver outside the list and a non-agent caller are refused.
    assert!(!env.spend(&agent, 0, &owner, 1).await?);
    assert!(!env.spend(&signer, 0, &shop, 1).await?);
    let v = env.vault(0).await?;
    assert_eq!(
        yocto(&v, "balance"),
        start - NearToken::from_near(4).as_yoctonear()
    );
    assert_eq!(
        yocto(&v, "window_spent"),
        NearToken::from_near(4).as_yoctonear()
    );
    assert_eq!(v["pending"], 0);

    // Transfer to a nonexistent (but allowed) account: callback restores balance and window.
    let _ = env.spend(&agent, 0, &ghost, 1).await?;
    let v = env.vault(0).await?;
    assert_eq!(
        yocto(&v, "balance"),
        start - NearToken::from_near(4).as_yoctonear()
    );
    assert_eq!(
        yocto(&v, "window_spent"),
        NearToken::from_near(4).as_yoctonear()
    );
    assert_eq!(v["pending"], 0);

    // Past 24 one-second buckets the window is free again.
    env.sandbox.fast_forward(400).await?;
    assert_eq!(yocto(&env.vault(0).await?, "window_spent"), 0);
    assert!(env.spend(&agent, 0, &shop, 5).await?);

    // Pause blocks, unpause restores (window is full now, so check via the error path only).
    assert!(
        env.call(
            &owner,
            "set_paused",
            json!({ "vault_id": 0, "paused": true }),
            one
        )
        .await?
    );
    env.sandbox.fast_forward(400).await?;
    assert!(!env.spend(&agent, 0, &shop, 1).await?);
    assert!(
        env.call(
            &owner,
            "set_paused",
            json!({ "vault_id": 0, "paused": false }),
            one
        )
        .await?
    );
    assert!(env.spend(&agent, 0, &shop, 1).await?);

    // Revoke stops the agent at once.
    assert!(
        env.call(&signer, "revoke", json!({ "agent": agent }), zero)
            .await?
    );
    assert!(!env.spend(&agent, 0, &shop, 1).await?);

    // Withdraw needs exactly 1 yocto and the owner.
    assert!(
        !env.call(
            &owner,
            "withdraw",
            json!({ "vault_id": 0, "amount": near(1) }),
            zero
        )
        .await?
    );
    assert!(
        !env.call(
            &agent,
            "withdraw",
            json!({ "vault_id": 0, "amount": near(1) }),
            one
        )
        .await?
    );
    assert!(
        env.call(
            &owner,
            "withdraw",
            json!({ "vault_id": 0, "amount": near(1) }),
            one
        )
        .await?
    );

    // Close refunds balance + storage; the vault is gone.
    let before = Account(owner.clone())
        .tokens()
        .near_balance()
        .fetch_from(&env.net)
        .await?
        .total;
    assert!(
        env.call(&owner, "close_vault", json!({ "vault_id": 0 }), one)
            .await?
    );
    let after = Account(owner.clone())
        .tokens()
        .near_balance()
        .fetch_from(&env.net)
        .await?
        .total;
    assert!(after > before);
    assert!(env.vault(0).await?.is_null());
    Ok(())
}

#[tokio::test]
async fn signer_policies_and_function_call_key() -> TestResult<()> {
    let env = Env::start().await?;
    let owner = env.account("owner").await?;
    let agent = env.account("agent").await?;
    let runner = env.account("runner").await?;
    let ci = env.account("ci").await?;
    let stranger = env.account("stranger").await?;
    let shop = env.account("shop").await?;
    let zero = NearToken::from_yoctonear(0);
    let one = NearToken::from_yoctonear(1);

    for s in [&runner, &ci, &stranger, &agent] {
        env.prepay(s).await?;
    }
    let args = json!({ "agent": agent, "owner_cap": near(10), "receivers": [shop], "trusted_signers": [runner, ci],
        "policy": "All", "min_suite_version": 1, "min_hidden": 0, "allow_foreign_endpoint": false });
    assert!(
        env.call(&owner, "create_vault", args, NearToken::from_near(15))
            .await?
    );

    // Self-certification and an untrusted signer do not unlock spending.
    assert!(!env.certify(&agent, &agent, 2, "Attested").await?);
    assert!(env.certify(&stranger, &agent, 2, "Attested").await?);
    assert!(!env.spend(&agent, 0, &shop, 1).await?);

    // The runner signs through a function-call key limited to certify/revoke.
    let fc_secret = near_api::signer::generate_secret_key()?;
    let fc_key = Signer::from_secret_key(fc_secret)?;
    let fc_pub = fc_key.get_public_key().await?;
    Account(runner.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: None,
                receiver_id: env.contract.0.to_string(),
                method_names: vec!["certify".into(), "revoke".into()],
            }),
            fc_pub,
        )
        .with_signer(env.key.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    assert!(
        env.certify_with(&runner, fc_key.clone(), &agent, 2, "Attested")
            .await?
    );

    // All: one of two trusted signers is not enough.
    assert!(!env.spend(&agent, 0, &shop, 1).await?);
    assert!(env.certify(&ci, &agent, 1, "Allowlist").await?);
    // Level = min(2, 1) = 1 → cap 3.
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(1)
    );
    assert!(env.spend(&agent, 0, &shop, 3).await?);
    assert!(!env.spend(&agent, 0, &shop, 1).await?);

    // The function-call key cannot move money: no deposits, no other methods.
    assert!(
        !env.call_with(
            &runner,
            fc_key.clone(),
            "storage_withdraw",
            json!({ "amount": "1" }),
            one
        )
        .await?
    );
    assert!(
        !env.call_with(&runner, fc_key.clone(), "storage_deposit", json!({}), zero)
            .await?
    );

    // Revoke by one signer under All stops the agent.
    env.sandbox.fast_forward(400).await?;
    assert!(
        env.call_with(
            &runner,
            fc_key.clone(),
            "revoke",
            json!({ "agent": agent }),
            zero
        )
        .await?
    );
    assert!(!env.spend(&agent, 0, &shop, 1).await?);

    // Any: the best live certificate counts, but never above what it says.
    assert!(
        env.call(
            &owner,
            "set_trusted_signers",
            json!({ "vault_id": 0, "signers": [runner, ci], "policy": "Any" }),
            one
        )
        .await?
    );
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(1)
    );
    assert!(env.spend(&agent, 0, &shop, 3).await?);
    assert!(!env.spend(&agent, 0, &shop, 1).await?);

    // Foreign-endpoint certificates are ignored unless the owner allows them.
    assert!(env.certify(&ci, &agent, 2, "Foreign").await?);
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        Value::Null
    );
    assert!(
        env.call(
            &owner,
            "set_min_suite",
            json!({ "vault_id": 0, "version": 1, "min_hidden": 0, "allow_foreign": true }),
            one
        )
        .await?
    );
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(2)
    );

    // Closing with a transfer in flight is impossible in one block here, so check the
    // registry view other contracts would read.
    assert_eq!(
        env.view(
            "is_certified",
            json!({ "agent": agent, "signer": ci, "level": 2 })
        )
        .await?,
        json!(true)
    );
    assert_eq!(
        env.view(
            "is_certified",
            json!({ "agent": agent, "signer": runner, "level": 1 })
        )
        .await?,
        json!(false)
    );
    Ok(())
}
