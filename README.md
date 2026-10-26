# Clearance

**Status:** work in progress for NEAR Hackathon (Nov 2026), started Oct 26, 2026. The on-chain part (vault + certificate registry) works and is deployed on testnet; the crash-test runner that measures agents is not built yet.

Clearance will crash-test AI agents that hold money — measure how easily an agent is tricked into paying the wrong party — record the result as an on-chain certificate on NEAR, and cap the agent's spending by that result.

## What works today
`contract/` — vault + certificate registry (Rust, near-sdk 5.29):
- An agent spends from its vault only while the signers the owner trusts hold a live certificate for it (policy `All`: every trusted signer, lowest level counts; `Any`: best certificate counts).
- Spending is capped at `min(owner cap, level cap)` over 24 hourly buckets: at most the cap within any 23 hours.
- Revoking a certificate stops the agent at the next call. The agent can never certify itself.
- A signer can work through a function-call key limited to `certify`/`revoke`, so that key cannot move money.

## Run the tests
Prerequisites: Rust via rustup (the pinned 1.93.0 toolchain installs itself from `contract/rust-toolchain.toml`), `cargo install cargo-near`. The integration tests download a near-sandbox binary on first run; no Docker needed.

```bash
make test    # 75 unit tests (incl. a window property test) + 2 near-sandbox integration tests
make build   # wasm via cargo-near
```

## On testnet
Dev deployment: [`clearance-dev.testnet`](https://testnet.nearblocks.io/address/clearance-dev.testnet) (keys kept; the final demo contract will be deployed without keys). [`demo/txs.json`](demo/txs.json) records real transactions with the contract's code hash and the commit they came from. Main refusal paths recorded: untrusted signer, self-certification, over the cap, receiver outside the list, spend after revoke — plus a certificate issued and revoked through the runner's function-call key and a payment that landed. The other refusal paths (pause, low balance, low gas, expired certificate, old suite version, missing hidden slice, foreign endpoint, long memo, zero amount, close with pending transfers) are covered by unit tests.
