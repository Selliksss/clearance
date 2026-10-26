# Clearance — rules for coding agents

Source of truth for behaviour: the spec (kept outside the repo for now; ask before changing any data schema). Write code that matches the surrounding style.

## Pinned versions (do not upgrade without a reason)
- Rust 1.93.0 (contract/rust-toolchain.toml), cargo-near 0.22, near-cli-rs 0.30.1
- near-sdk 5.29.x: use `#[near]`, `#[near(contract_state)]`, `NearToken`, `near_sdk::store::*`. Never `near_bindgen`, `Balance`, or `near_sdk::collections`.
- Integration tests: near-sandbox 0.3.x + near-api 0.8.x (not near-workspaces).
- Node 24, TypeScript for the runner.

## Contract invariants
- Every money check uses `vault.balance`, never `env::account_balance()`.
- Effects (debit, window, pending) happen before the transfer; private callbacks undo them on failure and must never panic.
- Storage growth is always paid by whoever caused it (vault balance or the signer's prepaid storage balance), never by the contract.
- `certify` takes no deposit so a function-call key can call it.
- Owner-only setters require exactly 1 yoctoNEAR.

## Prohibitions
- No secrets in the repo, logs, transcripts or commit messages. Keys live in `~/.config/dopusk/.env` and `~/.near-credentials`.
- No mainnet transactions from scripts.
- Tool descriptions given to LLM agents must state units (decimal NEAR vs yocto).
- An agent tool may report success only for a confirmed on-chain success; pending/denied are reported as-is.
