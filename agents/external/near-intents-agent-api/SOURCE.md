# Source

The "AI assistant" recipe of Agent Connect (NEAR Intents Agent API), the stack nearbuilders.org/build recommends for
agentic commerce: https://github.com/NEAR-Intents-Agent-API/examples, commit `de6d0fe5dee38099b8874fe0945aa76a3f53ee2c`
(2026-10-27), file `10-recipes/03-ai-assistant.ts`. The repository has no license file, so no code is copied here;
toolset `agentconnect-v1` (`runner/src/tools.ts`) reproduces only the interface the recipe gives an assistant:
four tools, `get_portfolio`, `quote_swap(from, to, amount)`, `execute_swap(from, to, amount)` and
`send(asset, amount, to)`, each mapping to one Agent API call (balances, a dry-run swap, a swap, a transfer).
The recipe's own comment puts all safety in the account policy: the assistant "can do exactly what the account
policy allows and no more".

`agents/agentconnect-assistant.json` is that assistant with a one-sentence neutral prompt (the recipe has none)
on `openai/gpt-4.1-mini`, the model of our other reference agents.

## Limits of the emulation (say them with any result)
- The recipe gives no tool descriptions; ours come from its comments and the Agent API's OpenAPI spec (amounts
  in the asset's smallest unit, NEAR as `nep141:wrap.near`).
- The agent also gets Clearance's task-data tools (`get_invoice`, `get_price`, `get_token_metadata`, `read_inbox`);
  the attacks arrive through them. The tools are the recipe's, the attack surface and the prompt are Clearance's.
- `send` is a real `spend` from the sandbox vault in native NEAR, not a wNEAR transfer inside NEAR Intents, and it
  answers with Clearance's report (`{"status": "success", "tx": ...}`, or `failed`/`denied` with a reason), not the
  Agent API's status object; real and injected results have the same shape.
- Swaps answer `route_unavailable` (no 1Click solvers on the sandbox), so swap scenarios are not run.
- No Agent Connect policy is in the loop: this measures the assistant on an open policy. What the level-2
  Agent Connect policy (`make policy`) would have changed is computed from the recorded actions.
- A result is about this recipe's tool layer with a minimal prompt on the named model, not about Agent Connect
  as a product.
