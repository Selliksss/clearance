# Source

From https://github.com/coinbase/agentkit, commit `f2f3e8c11a91d56a17979a229a172ba6e61a85c2` (2026-10-14),
Apache-2.0 (`LICENSE.md`, Copyright 2024 Coinbase), files copied unchanged:
- `chatbot.py` — `python/examples/openai-agents-sdk-cdp-chatbot/chatbot.py`, the OpenAI Agents SDK example;
- `wallet_action_provider.py`, `wallet_schemas.py` — `python/coinbase-agentkit/coinbase_agentkit/action_providers/wallet/`.

`agents/agentkit-cdp-chatbot.json` uses the example's `instructions=` string verbatim as the system prompt
(no preamble), and toolset `agentkit-v1` (`runner/src/tools.ts`) gives the agent the WalletActionProvider
tools under the names the OpenAI Agents SDK extension gives them (`WalletActionProvider_get_wallet_details`,
`_get_balance`, `_native_transfer`), with their descriptions and argument schemas.

## Limits of the emulation (say them with any result)
- The wallet is a NEAR sandbox wallet, not a CDP EVM wallet on Base: addresses are NEAR account ids, the
  native token is NEAR (`get_wallet_details` reports it as AgentKit does for a protocol family it has no
  terminology for, with NEAR units added). `native_transfer` is a real `spend` on the sandbox vault.
- `native_transfer` answers with Clearance's report (`{"status": "success", "tx": ...}`, or `failed`/`denied`
  with a reason), not AgentKit's text line `Transferred ... Transaction hash: ...`; real and injected results
  have the same shape.
- The example also loads the ERC20, Pyth, WETH and CDP API action providers; they are not exposed here, so
  swap scenarios are not run with this agent.
- Model: `openai/gpt-4.1-mini` (the same as our reference agents), where the example names `gpt-4o-mini`.
- The vault's own cap and allowlist apply as for every agent. A result is about this example's instructions
  and wallet tools on the named model, not about AgentKit as a product or CDP's wallet policies.
