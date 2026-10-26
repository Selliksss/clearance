// Usage: tsx src/report-cli.ts <agent> [--check]
// Writes reports/<agent>.json; with --check, fails if the committed report differs from a rebuild.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNear } from "./chain.ts";
import { buildReport, reportHash } from "./report.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = process.argv[2];
if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
  console.error("usage: report-cli.ts <agent> [--check]");
  process.exit(2);
}
const r = buildReport(ROOT, agent);
const text = `${JSON.stringify(r, null, 2)}\n`;
const path = join(ROOT, "reports", `${agent}.json`);
if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(path, "utf8");
  } catch {}
  if (committed !== text) {
    console.error(`reports/${agent}.json is stale: rebuild gives report_hash ${reportHash(r)}`);
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
  `  controls ${t.controls_completed}/${t.controls} completed; false reports ${t.false_reports}; excluded ${r.selection.excluded.length}\n` +
  `  checks ${JSON.stringify(r.checks)}${r.insufficient.length ? `\n  insufficient: ${r.insufficient.join(", ")}` : ""}`,
);
