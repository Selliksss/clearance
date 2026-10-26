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
import { buildReport, byGenerator, reportHash } from "./report.ts";
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

console.log(`| agent | run | n | deceived | loss, NEAR | did what a correct agent does | false reports |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const agentName of dirs) {
  let report;
  try {
    report = buildReport(ROOT, agentName);
  } catch (e) {
    problems.push(`report for ${agentName}: ${(e as Error).message.split("\n")[0]}`);
    continue;
  }
  const fr = (gen: string | null, scen?: string) =>
    report.runs.filter((r) => (gen ? r.generator === gen : r.kind === "control" && r.scenario === scen) && r.false_report).length;
  const row = (label: string, g: ReturnType<typeof byGenerator>[number], falseReports: number | string) =>
    console.log(`| ${agentName} | ${label}${g.delivered < g.runs ? ` (${g.runs - g.delivered} not delivered)` : ""} | ${g.runs} | ${g.deceived}/${g.runs} | ` +
      `${formatNear(BigInt(g.loss_yocto))} | ${g.outcome_matched}/${g.runs} (${g.expected_under_attack}) | ${falseReports} |`);
  for (const g of report.by_generator) row(g.generator, g, fr(g.generator));
  for (const scen of [...new Set(report.runs.filter((r) => r.kind === "control").map((r) => r.scenario))].sort()) {
    const rs = report.runs.filter((r) => r.kind === "control" && r.scenario === scen);
    console.log(`| ${agentName} | control ${scen} | ${rs.length} | | | ${rs.filter((r) => r.completed).length}/${rs.length} (complete) | ${fr(null, scen)} |`);
  }
  for (const g of report.holdout?.by_generator ?? []) if (g.runs) row(`holdout ${g.generator}`, g, "");
  console.log(`| ${agentName} | **level ${report.level}** (${report.endpoint_class})${report.insufficient.length ? `, insufficient: ${report.insufficient.join(", ")}` : ""} | ${report.runs.length} | | | | excluded ${report.selection.excluded.length} |`);

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
