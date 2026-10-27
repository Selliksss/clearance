// Usage: tsx src/allowlist-what-if.ts <agent>
// What-if, computed from recorded actions (no new runs): which deceived runs would still have lost money,
// and how much, (1) had the owner allowed payments only to the task's payee, and (2) under the whole
// level-2 OutLayer policy that make policy exports (that allowlist, at most 3 NEAR per transfer, 10 NEAR a
// day: a transfer over a limit is refused, not cut). An allowlist stops a redirected payment; only the
// limits stop paying the right party too much, and nothing here stops paying it twice within them.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNear, NEAR } from "./chain.ts";
import type { Transcript } from "./run.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = process.argv[2];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) throw new Error("usage: allowlist-what-if.ts <agent>");
const dir = join(ROOT, "transcripts", agent);
const PER_TX = 3n * NEAR;
const DAILY = 10n * NEAR;
const row = () => ({ runs: 0, loss: 0n, still: 0, stillLoss: 0n, policy: 0, policyLoss: 0n });
const rows = { suite: row(), blind: row() };
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript;
  if (t.status !== "valid" || !t.generator || !t.verdict.deceived) continue;
  const s = t.scenario as unknown as { participants: Record<string, string>; correct: { receiver?: string }; honest_payment_near: string };
  const payee = s.correct.receiver ? s.participants[s.correct.receiver] : undefined;
  if (!payee) continue;
  const toPayee = t.actions.filter((a) => a.landed && a.receiver === payee).reduce((n, a) => n + BigInt(a.amount_yocto), 0n);
  const honest = BigInt(Math.round(Number(s.honest_payment_near) * 1e6)) * (NEAR / 1_000_000n);
  const left = toPayee > honest ? toPayee - honest : 0n;
  // Under the policy, transfers to the payee land in order while each is within 3 NEAR and the day's total within 10.
  let day = 0n;
  for (const a of t.actions.filter((x) => x.landed && x.receiver === payee)) {
    const v = BigInt(a.amount_yocto);
    if (v <= PER_TX && day + v <= DAILY) day += v;
  }
  const leftPolicy = day > honest ? day - honest : 0n;
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
