// End-to-end checks against the real wasm in near-sandbox. Buckets are 1s so the
// 24-bucket window can be crossed with fast_forward. Every refusal is asserted
// by its panic message, so a setup mistake cannot pass as an expected refusal.
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;
use testresult::TestResult;
use tokio::sync::OnceCell;

const BUCKET_NS: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;

static WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

fn near(n: u128) -> String {
    NearToken::from_near(n).as_yoctonear().to_string()
}

/// What happened to a transaction.
#[derive(Debug)]
enum Outcome {
    /// Executed; `value` is the JSON return value (Null if none).
    Done {
        value: Value,
        logs: Vec<String>,
        receipt_failures: usize,
    },
    /// The contract panicked; the debug text of the failure.
    Panicked(String),
    /// The node refused the transaction before execution (e.g. access key
    /// rules); the text is kept for failure messages.
    Refused(#[allow(dead_code)] String),
}

impl Outcome {
    #[track_caller]
    fn ok(self) -> Value {
        match self {
            Outcome::Done { value, .. } => value,
            other => panic!("expected success, got {other:?}"),
        }
    }

    /// A `spend`/`withdraw` whose transfer actually landed (callback returned true).
    #[track_caller]
    fn landed(self) {
        match self {
            Outcome::Done {
                value: Value::Bool(true),
                receipt_failures: 0,
                ..
            } => {}
            other => panic!("expected a landed transfer, got {other:?}"),
        }
    }

    #[track_caller]
    fn panics(self, msg: &str) {
        match self {
            Outcome::Panicked(m) if m.contains(msg) => {}
            other => panic!("expected panic containing {msg:?}, got {other:?}"),
        }
    }

    #[track_caller]
    fn refused(self) {
        assert!(
            matches!(self, Outcome::Refused(_)),
            "expected node refusal, got {self:?}"
        );
    }
}

struct Env {
    sandbox: Sandbox,
    net: NetworkConfig,
    key: Arc<Signer>,
    contract: Contract,
}

impl Env {
    async fn start() -> TestResult<Self> {
        let wasm = WASM
            .get_or_init(|| async {
                let path =
                    cargo_near_build::build_with_cli(Default::default()).expect("build wasm");
                std::fs::read(path).expect("read wasm")
            })
            .await
            .clone();
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
    ) -> Outcome {
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
    ) -> Outcome {
        let mut tx = self
            .contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(60));
        // An explicit zero deposit makes near-api 0.8 build a transaction a
        // function-call key cannot sign; omit it instead.
        if !deposit.is_zero() {
            tx = tx.deposit(deposit);
        }
        let res = match tx.with_signer(who.clone(), key).send_to(&self.net).await {
            Ok(res) => res,
            Err(e) => return Outcome::Refused(format!("{e:?}")),
        };
        match res.into_result() {
            Ok(s) => Outcome::Done {
                value: s.json::<Value>().unwrap_or(Value::Null),
                logs: s.logs().into_iter().map(String::from).collect(),
                receipt_failures: s.receipt_failures().len(),
            },
            Err(f) => Outcome::Panicked(format!("{f:?}")),
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

    fn cert_args(agent: &AccountId, level: u8, class: &str) -> Value {
        let h = |c: char| c.to_string().repeat(64);
        json!({ "agent": agent, "level": level, "suite_version": 1, "suite_hash": h('a'), "hidden_count": 0,
            "report_hash": h('b'), "config_hash": h('c'), "endpoint_class": class, "run_ref": "run:1@abc", "ttl_ns": DAY_NS.to_string() })
    }

    async fn certify(
        &self,
        signer: &AccountId,
        agent: &AccountId,
        level: u8,
        class: &str,
    ) -> Outcome {
        let args = Self::cert_args(agent, level, class);
        self.call(signer, "certify", args, NearToken::from_yoctonear(0))
            .await
    }

    async fn prepay(&self, who: &AccountId) {
        self.call(
            who,
            "storage_deposit",
            json!({}),
            NearToken::from_millinear(100),
        )
        .await
        .ok();
    }

    async fn spend(&self, agent: &AccountId, vault: u64, to: &AccountId, n: u128) -> Outcome {
        let args = json!({ "vault_id": vault, "receiver": to, "amount": near(n) });
        self.call(agent, "spend", args, NearToken::from_yoctonear(0))
            .await
    }

    async fn balance(&self, id: &AccountId) -> TestResult<u128> {
        Ok(Account(id.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total
            .as_yoctonear())
    }
}

fn yocto(v: &Value, field: &str) -> u128 {
    near_sdk::serde_json::from_value::<U128>(v[field].clone())
        .unwrap()
        .0
}

fn vault_args(
    agent: &AccountId,
    cap: u128,
    receivers: Value,
    signers: Value,
    policy: &str,
) -> Value {
    json!({ "agent": agent, "owner_cap": near(cap), "receivers": receivers, "trusted_signers": signers,
        "policy": policy, "min_suite_version": 1, "min_hidden": 0, "allow_foreign_endpoint": false })
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
    let n = |x: u128| NearToken::from_near(x).as_yoctonear();

    env.call(
        &owner,
        "create_vault",
        vault_args(&agent, 5, json!([shop, ghost]), json!([owner]), "All"),
        NearToken::from_near(20),
    )
    .await
    .panics("owner cannot be a trusted signer");
    let id = env
        .call(
            &owner,
            "create_vault",
            vault_args(&agent, 5, json!([shop, ghost]), json!([signer]), "All"),
            NearToken::from_near(20),
        )
        .await
        .ok();
    assert_eq!(id, json!(0));
    let v = env.vault(0).await?;
    let start = yocto(&v, "balance");
    assert_eq!(start + yocto(&v, "storage_paid"), n(20));

    // No certificate: refused. Certify needs prepaid storage, then works with zero deposit.
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("no valid certificate");
    env.certify(&signer, &agent, 2, "Attested")
        .await
        .panics("not enough prepaid storage");
    env.prepay(&signer).await;
    env.certify(&signer, &agent, 2, "Attested").await.ok();

    // Level 2 (10) capped by owner (5): 2 + 2 land, a third 2 exceeds.
    let shop_before = env.balance(&shop).await?;
    env.spend(&agent, 0, &shop, 2).await.landed();
    env.spend(&agent, 0, &shop, 2).await.landed();
    assert_eq!(env.balance(&shop).await? - shop_before, n(4));
    env.spend(&agent, 0, &shop, 2)
        .await
        .panics("over window cap");
    env.spend(&agent, 0, &owner, 1)
        .await
        .panics("receiver not allowed");
    env.spend(&signer, 0, &shop, 1)
        .await
        .panics("only the vault agent can spend");
    let v = env.vault(0).await?;
    assert_eq!(yocto(&v, "balance"), start - n(4));
    assert_eq!(yocto(&v, "window_spent"), n(4));
    assert_eq!(v["pending"], 0);

    // Transfer to a nonexistent (but allowed) account: the callback runs, reports
    // false and restores balance and window.
    match env.spend(&agent, 0, &ghost, 1).await {
        Outcome::Done {
            value,
            logs,
            receipt_failures,
        } => {
            assert_eq!(value, json!(false));
            assert!(receipt_failures > 0);
            assert!(logs.iter().any(|l| l.contains("\"spend_refunded\"")));
        }
        other => panic!("expected executed spend with failed transfer, got {other:?}"),
    }
    let v = env.vault(0).await?;
    assert_eq!(yocto(&v, "balance"), start - n(4));
    assert_eq!(yocto(&v, "window_spent"), n(4));
    assert_eq!(v["pending"], 0);

    // Past 24 one-second buckets the window is free again.
    env.sandbox.fast_forward(400).await?;
    assert_eq!(yocto(&env.vault(0).await?, "window_spent"), 0);
    env.spend(&agent, 0, &shop, 5).await.landed();

    // Pause blocks, unpause restores.
    env.call(
        &owner,
        "set_paused",
        json!({ "vault_id": 0, "paused": true }),
        one,
    )
    .await
    .ok();
    env.sandbox.fast_forward(400).await?;
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("vault is paused");
    env.call(
        &owner,
        "set_paused",
        json!({ "vault_id": 0, "paused": false }),
        one,
    )
    .await
    .ok();
    env.spend(&agent, 0, &shop, 1).await.landed();

    // Revoke stops the agent at once.
    env.call(&signer, "revoke", json!({ "agent": agent }), zero)
        .await
        .ok();
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("no valid certificate");

    // Withdraw needs exactly 1 yocto and the owner.
    let w = json!({ "vault_id": 0, "amount": near(1) });
    env.call(&owner, "withdraw", w.clone(), zero)
        .await
        .panics("exactly 1 yoctoNEAR");
    env.call(&agent, "withdraw", w.clone(), one)
        .await
        .panics("only the vault owner");
    env.call(&owner, "withdraw", w, one).await.landed();

    // Close refunds balance + storage; the vault is gone.
    let before = env.balance(&owner).await?;
    let v = env.vault(0).await?;
    let refund = yocto(&v, "balance") + yocto(&v, "storage_paid");
    env.call(&owner, "close_vault", json!({ "vault_id": 0 }), one)
        .await
        .ok();
    // Gas costs at most 0.01 NEAR here.
    assert!(env.balance(&owner).await? + n(1) / 100 > before + refund);
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
        env.prepay(s).await;
    }
    env.call(
        &owner,
        "create_vault",
        vault_args(&agent, 10, json!([shop]), json!([runner, ci]), "All"),
        NearToken::from_near(15),
    )
    .await
    .ok();

    // Self-certification is refused; an untrusted signer's certificate unlocks nothing.
    env.certify(&agent, &agent, 2, "Attested")
        .await
        .panics("agent cannot certify itself");
    env.certify(&stranger, &agent, 2, "Attested").await.ok();
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("no valid certificate");

    // The runner signs through a function-call key limited to certify/revoke.
    let fc_key = Signer::from_secret_key(near_api::signer::generate_secret_key()?)?;
    Account(runner.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_millinear(250)),
                receiver_id: env.contract.0.to_string(),
                method_names: vec!["certify".into(), "revoke".into()],
            }),
            fc_key.get_public_key().await?,
        )
        .with_signer(env.key.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    env.call_with(
        &runner,
        fc_key.clone(),
        "certify",
        Env::cert_args(&agent, 2, "Attested"),
        zero,
    )
    .await
    .ok();

    // All: one of two trusted signers is not enough.
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("no valid certificate");
    env.certify(&ci, &agent, 1, "Allowlist").await.ok();
    // Level = min(2, 1) = 1 → cap 3.
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(1)
    );
    env.spend(&agent, 0, &shop, 3).await.landed();
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("over window cap");

    // The function-call key cannot move money: deposits and other methods are
    // refused by the node before the contract runs.
    env.call_with(
        &runner,
        fc_key.clone(),
        "storage_withdraw",
        json!({ "amount": "1" }),
        one,
    )
    .await
    .refused();
    env.call_with(
        &runner,
        fc_key.clone(),
        "spend",
        json!({ "vault_id": 0, "receiver": shop, "amount": near(1) }),
        zero,
    )
    .await
    .refused();

    // Revoke by one signer under All stops the agent.
    env.sandbox.fast_forward(400).await?;
    env.call_with(
        &runner,
        fc_key.clone(),
        "revoke",
        json!({ "agent": agent }),
        zero,
    )
    .await
    .ok();
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("no valid certificate");

    // Any: the best live certificate counts, but never above what it says.
    env.call(
        &owner,
        "set_trusted_signers",
        json!({ "vault_id": 0, "signers": [runner, ci], "policy": "Any" }),
        one,
    )
    .await
    .ok();
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(1)
    );
    env.spend(&agent, 0, &shop, 3).await.landed();
    env.spend(&agent, 0, &shop, 1)
        .await
        .panics("over window cap");

    // Foreign-endpoint certificates are ignored unless the owner allows them.
    env.certify(&ci, &agent, 2, "Foreign").await.ok();
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        Value::Null
    );
    env.call(
        &owner,
        "set_min_suite",
        json!({ "vault_id": 0, "version": 1, "min_hidden": 0, "allow_foreign": true }),
        one,
    )
    .await
    .ok();
    assert_eq!(
        env.view("effective_level", json!({ "vault_id": 0 }))
            .await?,
        json!(2)
    );

    // The registry view other contracts read.
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
