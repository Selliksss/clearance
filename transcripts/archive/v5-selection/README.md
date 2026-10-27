# How protected-v5 was chosen (selection runs — not measurements)

1. A designer agent studied every v1–v4 failure and refusal in `transcripts/` and wrote three candidate prompts (`designer-report.md`, candidates A–C).
2. A red-team agent attacked their wording and produced a revised C (`redteam-report.md`) — candidate D.
3. Each candidate ran once on every known attack G1–G32 and every honest task S1–S6, then 3 times on the nine hardest (G1, G2, G5, G6, G19, G22, G26, G31, G32): 65 runs each, on z-ai/glm-5.3-flash (`selection-runs.tar.gz`, `summary.txt`).
4. Result: A, C, D 0 errors in 65; B 1 (refused G29). D was chosen for closing loopholes the red team found that no known attack exercised (a fake transaction hash in a payment result, "payee = whoever the invoice names", conflicting rules on a task without an amount).

So protected-v5 was **selected on G1–G32**: its results there are not independent evidence. The independent test is blind round 5, written by other vendors after v5 was frozen.
