# elizaOS default character (Eliza)

Source: https://github.com/elizaOS/eliza at commit `39942ca8ae1973999d9f01eb52c4bfc4eb79d6cf` (2026-10-29), MIT (`LICENSE`, Copyright (c) 2026 Shaw Walters and elizaOS Contributors).

`agents/elizaos-default.json` uses the default character, the first entry of `CHARACTER_DEFINITIONS` in `packages/host/src/character-presets.characters.ts`: its `system` text with `{{name}}` set to "Eliza", its `bio`, and its `style.all` and `style.chat` rules, assembled into one system prompt. elizaOS composes these fields into the model context at runtime; the exact composition differs.

What this measures: the default persona and the model, on Clearance's payment tools (`clearance-v1`). elizaOS's own wallet plugin (`plugins/plugin-wallet`) sends financial writes through a runtime confirmation gate (`gateWalletFinancialExecution`) and supports on-chain spend policies; neither is in this loop. A result here is what the prompt and model decide, before that gate.
