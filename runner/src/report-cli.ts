// Usage: tsx src/report-cli.ts <agent> [--check] [--upgrade-judge]
//        tsx src/report-cli.ts <agent> --ci <transcripts-ci/<run id>/<agent> dir> [--out <file>]
// Writes reports/<agent>.json; with --check, fails if the committed report differs from a rebuild.
// A committed report keeps its judge version (its hash may be on chain); --upgrade-judge rebuilds it
// under the current judge, which changes report_hash and needs a new certificate.
// With --ci, builds the report of one CI run (every planned slot must be present) and writes it to --out.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatNear } from "./chain.ts";
import { JUDGE_VERSION } from "./loss.ts";
import { buildReport, ciReport, committedJudgeVersion, reportHash } from "./report.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { check: { type: "boolean", default: false }, "upgrade-judge": { type: "boolean", default: false }, ci: { type: "string" }, out: { type: "string" } },
});
const agent = positionals[0];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
  console.error("usage: report-cli.ts <agent> [--check] | --ci <dir> [--out <file>]");
  process.exit(2);
}
const jv = values["upgrade-judge"] ? JUDGE_VERSION : committedJudgeVersion(ROOT, agent);
if (!values.ci && jv !== JUDGE_VERSION) console.error(`reports/${agent}.json is on judge v${jv} (current v${JUDGE_VERSION}); kept, pass --upgrade-judge to rebuild it under v${JUDGE_VERSION}`);
const r = values.ci ? ciReport(ROOT, agent, resolve(values.ci)) : buildReport(ROOT, agent, 1, { judgeVersion: jv });
const text = `${JSON.stringify(r, null, 2)}\n`;
const path = values.out ? resolve(values.out) : join(ROOT, "reports", `${agent}${values.ci ? ".ci" : ""}.json`);
if (values.check) {
  let committed = "";
  try {
    committed = readFileSync(path, "utf8");
  } catch {}
  if (committed !== text) {
    console.error(`${path} is stale: rebuild gives report_hash ${reportHash(r)}`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const t = r.totals;
console.log(
  `${agent}: level ${r.level} (${r.endpoint_class}) report_hash ${reportHash(r)}\n` +
  `  attacks ${t.attacks}: deceived ${t.deceived}, loss ${formatNear(BigInt(t.loss_yocto))} of ${formatNear(BigInt(t.honest_yocto))} honest, max run loss ${formatNear(BigInt(t.max_run_loss_yocto))}\n` +
  `  controls ${t.controls_completed}/${t.controls} completed; false reports ${t.false_reports}; excluded ${r.selection.excluded.length}` +
  `${r.insufficient.length ? `\n  insufficient: ${r.insufficient.join(", ")}` : ""}`,
);
