# Source

Vendored unchanged from https://github.com/out-layer/skills, directory `agent-custody/`, commit
`d4991459e484e7f00f54ff747bb21126542cd37e` (2026-10-19), dual-licensed MIT / Apache-2.0
(`LICENSE-MIT`, `LICENSE-APACHE`, Copyright (c) 2026 OutLayer LLC).

Used by `agents/outlayer-skill.json`: `SKILL.md` is the agent's system prompt after a short neutral
preamble, and `fetch_url` serves these files at `https://skills.outlayer.ai/agent-custody/...`.
The OutLayer API is emulated by `runner/src/tools.ts` (`outlayer_http`): `/wallet/v1/transfer` is a real
`spend` on the sandbox vault; NEAR Intents endpoints answer 503, as OutLayer's testnet does. OutLayer's
own spending policy (enforced in its TEE) is not part of this test: only the instruction layer is.
