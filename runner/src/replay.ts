// Usage: tsx src/replay.ts [--rescore]
// Offline, no keys, no sandbox, over transcripts/<agent>/ (transcripts/archive/ is skipped).
//   - every transcript passes the shared integrity check (integrity.ts)
//   - a run whose only problem is a verdict by an older judge is reported as stale;
//     `--rescore` rewrites that verdict (atomically, keeping the original)
//   - every committed reports/<agent>.json equals a rebuild from the transcripts
// Prints the results table the README quotes (built from the same report rows).
// Exits non-zero on any problem.
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNear } from "./chain.ts";
import { checkTranscript } from "./integrity.ts";
import { JUDGE_VERSION, judge, parseClaim } from "./loss.ts";
import { buildReport, reportHash } from "./report.ts";
import type { Transcript } from "./run.ts";
import { loadAgent } from "./scenario.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESCORE = process.argv.includes("--rescore");
const base = join(ROOT, "transcripts");
const dirs = readdirSync(base).filter((d) => d !== "archive" && statSync(join(base, d)).isDirectory()).sort();
const STALE = "verdict differs from the current judge";

const problems: string[] = [];
let rescored = 0;
let checked = 0;

for (const agentName of dirs) {
  let agent = null;
  try {
    agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
  } catch {}
  for (const f of readdirSync(join(base, agentName)).filter((x) => x.endsWith(".json")).sort()) {
    const path = join(base, agentName, f);
    const t: Transcript = JSON.parse(readFileSync(path, "utf8"));
    checked++;
    const c = checkTranscript(ROOT, f, t, agent);
    const others = c.problems.filter((p) => p !== STALE);
    if (c.problems.includes(STALE)) {
      const verdictVersion = t.rescored?.to_judge_version ?? t.env.judge_version;
      if (RESCORE && others.length === 0 && verdictVersion !== JUDGE_VERSION) {
        t.rescored = {
          from_judge_version: t.rescored?.from_judge_version ?? verdictVersion,
          to_judge_version: JUDGE_VERSION,
          at: new Date().toISOString(),
          original_verdict: t.rescored?.original_verdict ?? t.verdict,
        };
        t.verdict = judge(t.scenario, t.actions, parseClaim(t.final_message), c.injected);
        writeFileSync(`${path}.tmp`, `${JSON.stringify(t, null, 2)}\n`);
        renameSync(`${path}.tmp`, path);
        rescored++;
      } else if (verdictVersion === JUDGE_VERSION) {
        others.push("verdict differs on replay (same judge version)");
      } else {
        others.push(`judged by v${verdictVersion}; current judge v${JUDGE_VERSION} disagrees, run make replay ARGS=--rescore`);
      }
    }
    for (const p of others) problems.push(`${agentName}/${f}: ${p}`);
  }
}

console.log(`| agent | run | n | deceived | loss, NEAR | completed | false reports | excluded |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const agentName of dirs) {
  let report;
  try {
    report = buildReport(ROOT, agentName);
  } catch (e) {
    problems.push(`report for ${agentName}: ${(e as Error).message.split("\n")[0]}`);
    continue;
  }
  const groups = new Map<string, typeof report.runs>();
  for (const r of report.runs) {
    const key = r.generator ?? `control ${r.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of [...groups.entries()].sort()) {
    const n = rows.length;
    const undelivered = rows.filter((r) => !r.delivered).length;
    const loss = rows.reduce((s, r) => s + BigInt(r.loss_yocto), 0n);
    console.log(`| ${agentName} | ${key}${undelivered ? ` (${undelivered} not delivered)` : ""} | ${n} | ${rows.filter((r) => r.deceived).length}/${n} | ` +
      `${formatNear(loss)} | ${rows.filter((r) => r.completed).length}/${n} | ${rows.filter((r) => r.false_report).length} | |`);
  }
  console.log(`| ${agentName} | **level ${report.level}** (${report.endpoint_class}) | ${report.runs.length} | | | | | ${report.selection.excluded.length} |`);

  let committed: string | null = null;
  try {
    committed = readFileSync(join(ROOT, "reports", `${agentName}.json`), "utf8");
  } catch {}
  if (committed !== null && committed !== `${JSON.stringify(report, null, 2)}\n`) {
    problems.push(`reports/${agentName}.json is stale (rebuild: ${reportHash(report)}); run make report AGENT=${agentName}`);
  }
}

console.log(`\nchecked ${checked} transcripts${rescored ? `; rescored ${rescored} to judge v${JUDGE_VERSION} (originals kept)` : ""}`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : `all reproducible under judge v${JUDGE_VERSION}`);
process.exit(problems.length ? 1 : 0);
