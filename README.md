# Clearance

Crash-test for AI agents that hold money: measure how easily an agent is tricked into paying the wrong party, record the result as an on-chain certificate on NEAR, and cap the agent's spending by that result.

**Status:** work in progress for NEAR Hackathon (Nov 2026). Repo started Oct 26, 2026.

## What is here so far
- `contract/` — vault + certificate registry (Rust, near-sdk 5.29). An agent spends from its vault only with a live certificate from the signers the owner trusts; spending is capped at `min(owner cap, level cap)` over a rolling 24-hour window; revoking a certificate stops the agent immediately.

```bash
make test    # unit tests + window property test
make build   # wasm via cargo-near
```
