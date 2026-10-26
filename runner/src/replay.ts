// Usage: tsx src/replay.ts [--rescore]
// Offline, no keys, no sandbox, over transcripts/<agent>/ (transcripts/archive/ is skipped).
// For every transcript:
//   - the verdict recomputed by the current judge from its actions, final claim and
//     injected text equals the stored one; a run judged by an older judge version is
//     reported as stale, and `--rescore` rewrites its verdict (keeping the original)
//   - for attacks, the generator file in attacks/ still has the recorded hash and the
//     seed reproduces the recorded slot values; a run made with an older generator
//     file belongs in transcripts/archive/
//   - verify.ts checks pass (hashes, history chaining, tool results, signatures)
// Then prints the results table the README quotes. Exits non-zero on any problem.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectedFields, loadGenerator, resolveSlots } from "./attack.ts";
import { formatNear } from "./chain.ts";
import { JUDGE_VERSION, judge, parseClaim } from "./loss.ts";
import type { Transcript } from "./run.ts";
import { canonical, sha256hex } from "./scenario.ts";
import { verifyTranscript } from "./verify.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESCORE = process.argv.includes("--rescore");
const base = join(ROOT, "transcripts");
const dirs = readdirSync(base).filter((d) => d !== "archive" && statSync(join(base, d)).isDirectory()).sort();
const genFiles = readdirSync(join(ROOT, "attacks")).filter((f) => f.endsWith(".json"));

const problems: string[] = [];
let rescored = 0;
type Row = { n: number; invalid: number; deceived: number; loss: bigint; completed: number; falseReports: number };
const table = new Map<string, Row>();

for (const agent of dirs) {
  for (const f of readdirSync(join(base, agent)).filter((x) => x.endsWith(".json")).sort()) {
    const path = join(base, agent, f);
    const t: Transcript = JSON.parse(readFileSync(path, "utf8"));
    const where = `${agent}/${f}`;
    if (sha256hex(canonical(t.scenario)) !== t.scenario_sha256) problems.push(`${where}: embedded scenario does not match its hash`);

    let injected = t.injected ?? null;
    if (t.generator) {
      const file = genFiles.find((g) => g === `${t.generator}.json`);
      if (!file) {
        problems.push(`${where}: generator ${t.generator} not in attacks/`);
        continue;
      }
      const { generator, sha256 } = loadGenerator(join(ROOT, "attacks", file), t.scenario);
      if (sha256 !== t.generator_sha256) {
        problems.push(`${where}: made with an older version of ${t.generator}; move it to transcripts/archive/`);
        continue;
      }
      if (canonical(resolveSlots(generator, t.scenario, t.seed)) !== canonical(t.attack_slots)) {
        problems.push(`${where}: seed does not reproduce the recorded attack slots`);
      }
      injected ??= injectedFields(generator, t.scenario, t.seed); // older transcripts did not store it
    }

    const verdictVersion = t.rescored?.to_judge_version ?? t.env.judge_version;
    const again = judge(t.scenario, t.actions, parseClaim(t.final_message), injected);
    if (canonical(again) !== canonical(t.verdict)) {
      if (verdictVersion === JUDGE_VERSION) {
        problems.push(`${where}: verdict differs on replay`);
      } else if (RESCORE) {
        t.rescored = {
          from_judge_version: verdictVersion,
          to_judge_version: JUDGE_VERSION,
          at: new Date().toISOString(),
          original_verdict: t.rescored?.original_verdict ?? t.verdict,
        };
        t.verdict = again;
        writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
        rescored++;
      } else {
        problems.push(`${where}: judged by v${verdictVersion}, current judge v${JUDGE_VERSION} disagrees; run make replay ARGS=--rescore`);
      }
    }

    for (const c of verifyTranscript(t)) if (!c.ok) problems.push(`${where}: turn ${c.turn}: ${c.what}`);

    const key = `${agent} | ${t.generator ?? `control ${t.scenario.id}`}`;
    const row = table.get(key) ?? { n: 0, invalid: 0, deceived: 0, loss: 0n, completed: 0, falseReports: 0 };
    if (t.status !== "valid") row.invalid++;
    else {
      const v = t.verdict;
      row.n++;
      row.deceived += v.deceived ? 1 : 0;
      row.loss += BigInt(v.loss_yocto);
      row.completed += v.completed ? 1 : 0;
      row.falseReports += v.false_report ? 1 : 0;
    }
    table.set(key, row);
  }
}

console.log(`| agent | run | n | deceived | loss, NEAR | completed | false reports | invalid (network) |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const [key, r] of [...table.entries()].sort()) {
  const [agent, run] = key.split(" | ");
  console.log(`| ${agent} | ${run} | ${r.n} | ${r.deceived}/${r.n} | ${formatNear(r.loss)} | ${r.completed}/${r.n} | ${r.falseReports} | ${r.invalid} |`);
}
if (rescored) console.log(`\nrescored ${rescored} transcript(s) to judge v${JUDGE_VERSION} (original verdicts kept in "rescored")`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : `all reproducible under judge v${JUDGE_VERSION}`);
process.exit(problems.length ? 1 : 0);
