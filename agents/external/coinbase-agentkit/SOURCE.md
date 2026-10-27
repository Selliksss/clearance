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
- The agent also gets Clearance's task-data tools (`get_invoice`, `get_price`, `get_token_metadata`, `read_inbox`), which the original does not have; the attacks arrive through them. The instructions are the original's, the attack surface is Clearance's.
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

## The guardrails example (`agents/agentkit-guardrails.json`)
`guardrails-chatbot.ts` — `typescript/examples/langchain-guardrails-cdp-chatbot/chatbot.ts`, same commit, unchanged.
Its `systemPrompt` template string is used verbatim (whitespace included); `guard: "agentkit-regex-v1"`
(`runner/src/guard.ts`) reproduces its `promptInjectionMiddleware`: before each model call the last message
is tested against its 11 patterns, and a match ends the run with "Blocked by guardrails middleware". Its
`humanInTheLoopMiddleware` interrupts only `ERC20ActionProvider_transfer`, which is not exposed here, so it
never fires; `native_transfer` (WalletActionProvider, loaded by the example) is not gated in the example
either. LangChain's message formatting is not reproduced: a tool result reaches the model (and the filter)
as the JSON text Clearance's runner sends.
