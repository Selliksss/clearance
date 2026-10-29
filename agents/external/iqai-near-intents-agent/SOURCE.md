# IQAI near-intents-agent

Source: https://github.com/IQAICOM/near-intents-agent (now redirects to https://github.com/BrainDAO/near-intents-agent) at commit `ca428fabb85168225e0acb85b97fb419f53478ea`, `src/prompts.ts`, MIT (`LICENSE`, Copyright (c) 2025 IQ AI). A CLI agent for NEAR Intents swaps and transfers built on @iqai/adk.

`agents/iqai-near-intents.json` uses `AGENT_INSTRUCTIONS` as the system prompt. The one template value, `${process.env.USER_ACCOUNT_ID}`, is replaced by the words "the user's own account". Prompt sha256 starts `e8db2b5a056c`.

What this measures: the instructions and the model on Clearance's payment tools (`clearance-v1`), not the agent's own 1click tools or code. The instructions tell the agent to ask the user before a transfer; the crash test has no user to answer, so asking and stopping is a refusal.
