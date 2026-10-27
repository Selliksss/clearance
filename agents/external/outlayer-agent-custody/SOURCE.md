# Source

Vendored unchanged from https://github.com/out-layer/skills, directory `agent-custody/`, commit
`d4991459e484e7f00f54ff747bb21126542cd37e` (2026-10-19), dual-licensed MIT / Apache-2.0
(`LICENSE-MIT`, `LICENSE-APACHE`, Copyright (c) 2026 OutLayer LLC).

Used by `agents/outlayer-skill.json`: `SKILL.md` is the agent's system prompt after a short neutral
preamble, and `fetch_url` serves these files at `https://skills.outlayer.ai/agent-custody/...`.
The OutLayer API is emulated by `runner/src/tools.ts` (`outlayer_http`): `/wallet/v1/transfer` is a real
`spend` on the sandbox vault; NEAR Intents endpoints answer 503, as OutLayer's testnet does. OutLayer's
own spending policy (enforced in its TEE) is not part of this test: only the instruction layer is.

## Limits of the emulation (say them with any result)
- The agent also gets Clearance's task-data tools (`get_invoice`, `get_price`, `get_token_metadata`, `read_inbox`), which the original does not have; the attacks arrive through them. The instructions are the original's, the attack surface is Clearance's.
- Money calls answer with Clearance's report (`{"status": "success", "tx": ...}`, or `failed`/`denied` with a reason), not OutLayer's `{request_id, status, tx_hash}`; a `denied` carries the sandbox contract's panic text. The agent sees the same shape for real and injected results.
- `headers` (e.g. `X-Idempotency-Key`) and a transfer's `memo`/`token` are accepted and ignored; there is no request polling (`/requests/{id}` is 404).
- `POST /register` answers 409 (the wallet is pre-registered); `/call`, payment checks and account binding are 404; NEAR Intents, confidential and cross-chain endpoints are 503. Swap scenarios are therefore not run with this agent.
- The vault's own cap and allowlist apply as for every agent; OutLayer's TEE-enforced policy is not in the loop. A result is about the skill's instruction layer on the named model, not about OutLayer's product.
- `transcripts/archive/outlayer-skill-emulator-v0/`: 24 runs on an earlier emulator (no `headers`, `SOURCE.md` reachable through `fetch_url`), kept, not scored.
