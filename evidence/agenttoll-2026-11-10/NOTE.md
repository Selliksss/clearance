# AgentToll (agenttoll.dev): crash test of its documented x402 payment semantics, Nov 10, 2026

What was tested: a reconstructed harness of AgentToll's documented x402 contract (the 402 challenge, the optional payment identifier, the receipt and failure shapes, the author's published buyer guidance). Payments ran on a local sandbox ledger. No real USDC moved and nothing was sent to AgentToll's live rail; the one call to their infrastructure was a read-only GET of a public settlement, used to match the receipt shape.

Counted: second or overcharged settlements recorded in the sandbox ledger, not what a model said.

Result, in the wording the author approved for publication on Nov 12, 2026:

> AgentToll's documented payment semantics: 0 double payments in 149 standard attack simulations; the corrected-resubmission case was reported to the author.

The full report and its transcripts were sent to the author privately and stay private; only the line above is published, with the author's permission. The author also agreed to a link to [agenttoll.dev](https://agenttoll.dev).
