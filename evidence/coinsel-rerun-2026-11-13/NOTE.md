# Coinsel: the duplicate-payroll fix, rerun on testnet (Nov 13, 2026, 23:00 UTC)

[Coinsel](https://github.com/Veetor4x/Coinsel) is an AI treasurer for Sputnik DAOs. It may only file proposals; a council of 3 votes.

On Nov 11, Clearance ran the payroll sequence below through Coinsel's public demo. Its duplicate check matched exact amounts, so changing one payout by 0.01 NEAR filed a second payroll top-up for the same payday, and changing it by 0.02 NEAR filed a third (#31 to #33).

The author shipped two fixes:
- [PR #13](https://github.com/Veetor4x/Coinsel/pull/13): any open top-up counts toward the gap.
- [PR #14](https://github.com/Veetor4x/Coinsel/pull/14): that check reads every proposal, not only the last 20, a gap found in PR #13 by reading its code.

He agreed to this rerun ("go ahead and rerun whenever").

## Setup
- **Target:** the public demo at coinsel-jet.vercel.app, after PR #14 (merge `901468d`). The DAO is `coinselx69t-treasury.sputnikv2.testnet`.
- **Path:** the site's own Step-1 path, `POST /api/analyze` then `POST /api/propose`. These are the calls the "Ask Coinsel" and "File step 1" buttons make. Script: `drive.mjs`; log: `log.jsonl`.
- **What was not done:** no proposal was crafted directly, and nothing was voted or executed.
- **Cleanup:** "Reset demo" afterwards (`reset.json`), which closed both proposals the run filed.
- **Ground truth:** the DAO's proposals, read from NEAR testnet RPC (`chain.mjs`; before the reset `chain-before-reset.jsonl`, after it `chain-after-reset.jsonl`).

## Results
| step | payout list sent | gap the server recomputed | Nov 11 (before the fixes) | Nov 13 (after) |
|---|---|---|---|---|
| honest | demo default | 3 NEAR | filed #31 | filed [#45](https://testnet.nearblocks.io/txns/AYsxo3HgU3SpGkfVxwyjXuAC6qF3pQMjeJ7kbhRCtbAw), 3 NEAR |
| control: honest again, unchanged | demo default | 3 NEAR | blocked, duplicate | blocked: "Already filed as #45 and still waiting for votes." |
| attack: one payout +0.01 | 2 → 2.01 | 3.01 NEAR | **filed #32, 3.01 NEAR** | **not filed:** "Already covered by pending #45." |
| attack: one payout +0.02 | 2 → 2.02 | 3.02 NEAR | **filed #33, 3.02 NEAR** | **not filed:** "Already covered by pending #45." |
| control: a real new hire | +1 payout of 2 NEAR | 5 NEAR | filed #34, 5 NEAR | filed [#46](https://testnet.nearblocks.io/txns/7kjQ1S7u5vTVWu596V75eYWvhgamCvwnyQkQpi3eaV1d), **2 NEAR**: only the difference over pending #45 |

On chain after the run, only two proposals were open: #45 for 3 NEAR and #46 for 2 NEAR. Together they come to 5 NEAR, the real gap. Before the fixes, the same sequence left 3 + 3.01 + 3.02 + 5 = 14.03 NEAR pending for the same payday. Reset rejected both #45 and #46.

## What this does not show
- **The fix in PR #14 was read, not attacked.** `getAllProposals` pages through every proposal id. Pushing an open top-up past 20 newer proposals would have meant filing 20 proposals in the author's DAO.
- **One run of the sequence.** The checks are deterministic server code; the AI only writes the advice text and never sets the amount or the receiver.
