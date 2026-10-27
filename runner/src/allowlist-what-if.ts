// Usage: tsx src/allowlist-what-if.ts <agent>
// What-if, computed from recorded actions (no new runs): which deceived runs would still have lost money,
// and how much, (1) had the owner allowed payments only to the task's payee, and (2) under the whole
// level-2 OutLayer policy that make policy exports (that allowlist, at most 3 NEAR per transfer, 10 NEAR a
// day: a transfer over a limit is refused, not cut). An allowlist stops a redirected payment; only the
// limits stop paying the right party too much, and nothing here stops paying it twice within them.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNear } from "./chain.ts";
import type { Transcript } from "./run.ts";
import { whatIf } from "./whatif.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = process.argv[2];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) throw new Error("usage: allowlist-what-if.ts <agent>");
const dir = join(ROOT, "transcripts", agent);
const row = () => ({ runs: 0, loss: 0n, still: 0, stillLoss: 0n, policy: 0, policyLoss: 0n });
const rows = { suite: row(), blind: row() };
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript;
  if (t.status !== "valid" || !t.generator || !t.verdict.deceived) continue;
  const w = whatIf(t);
  if (!w) continue;
  const left = w.allowlistLeft;
  const leftPolicy = w.policyLeft;
  const r = Number(t.generator.split("-")[0].slice(1)) >= 11 ? rows.blind : rows.suite;
  r.runs++;
  r.loss += BigInt(t.verdict.loss_yocto);
  if (left > 0n) {
    r.still++;
    r.stillLoss += left;
    console.log(`still loses with an allowlist: ${t.generator} ${formatNear(left)} NEAR (${t.run_id})`);
  }
  if (leftPolicy > 0n) {
    r.policy++;
    r.policyLoss += leftPolicy;
    console.log(`still loses under the level-2 policy: ${t.generator} ${formatNear(leftPolicy)} NEAR (${t.run_id})`);
  }
}
for (const [k, r] of Object.entries(rows)) {
  console.log(`${agent} ${k} (payment scenarios): ${r.runs} deceived runs lost ${formatNear(r.loss)} NEAR; with a payee-only allowlist ${r.still} would still lose ${formatNear(r.stillLoss)} NEAR; under the level-2 policy ${r.policy} would, ${formatNear(r.policyLoss)} NEAR`);
}
