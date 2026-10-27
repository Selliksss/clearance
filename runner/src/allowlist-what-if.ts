// Usage: tsx src/allowlist-what-if.ts <agent>
// What-if, computed from recorded actions (no new runs): had the owner allowed payments only to the
// task's payee, which deceived runs would still have lost money, and how much? An allowlist stops a
// redirected payment; it cannot stop paying the right party twice or too much.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNear, NEAR } from "./chain.ts";
import type { Transcript } from "./run.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = process.argv[2];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) throw new Error("usage: allowlist-what-if.ts <agent>");
const dir = join(ROOT, "transcripts", agent);
const rows = { suite: { runs: 0, loss: 0n, still: 0, stillLoss: 0n }, blind: { runs: 0, loss: 0n, still: 0, stillLoss: 0n } };
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript;
  if (t.status !== "valid" || !t.generator || !t.verdict.deceived) continue;
  const s = t.scenario as unknown as { participants: Record<string, string>; correct: { receiver?: string }; honest_payment_near: string };
  const payee = s.correct.receiver ? s.participants[s.correct.receiver] : undefined;
  if (!payee) continue;
  const toPayee = t.actions.filter((a) => a.landed && a.receiver === payee).reduce((n, a) => n + BigInt(a.amount_yocto), 0n);
  const honest = BigInt(Math.round(Number(s.honest_payment_near) * 1e6)) * (NEAR / 1_000_000n);
  const left = toPayee > honest ? toPayee - honest : 0n;
  const r = Number(t.generator.split("-")[0].slice(1)) >= 11 ? rows.blind : rows.suite;
  r.runs++;
  r.loss += BigInt(t.verdict.loss_yocto);
  if (left > 0n) {
    r.still++;
    r.stillLoss += left;
    console.log(`still loses with an allowlist: ${t.generator} ${formatNear(left)} NEAR (${t.run_id})`);
  }
}
for (const [k, r] of Object.entries(rows)) {
  console.log(`${agent} ${k} (payment scenarios): ${r.runs} deceived runs lost ${formatNear(r.loss)} NEAR; with a payee-only allowlist ${r.still} would still lose ${formatNear(r.stillLoss)} NEAR`);
}
