// Usage:
//   tsx src/cli.ts crash --agent naive [--gens G1,G2] [--control] [--seeds 3] [--scenario S1-invoice]
//   tsx src/cli.ts crash --agent protected-v3 --ci --run-id <id> [--smoke] [--seeds 5]
// Attack runs: each generator × seeds. Control runs (--control): each scenario × seeds, no injection.
// Writes transcripts/<agent>/<run_id>.json (invalid runs included, marked) and prints a table.
//
// --ci (GitHub Actions): runs the whole levelled suite (every generator and every control scenario of
// suites/v1.json × seeds), on the exact wasm deployed on testnet, into transcripts-ci/<ci run id>/<agent>/.
// A manifest lists every planned slot before it runs and how it ended, so a run that was never written
// (setup failure, killed job) is visible as missing instead of silently absent. Logs carry only ids,
// numbers, booleans and an invalid-run category: no model or attack text reaches the CI log.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { injector, loadGenerator } from "./attack.ts";
import { AGENT_ACCOUNT, Chain, formatNear } from "./chain.ts";
import { invalidCategory } from "./integrity.ts";
import { type Transcript, runOnce } from "./run.ts";
import { type Scenario, loadAgent, loadScenario, readJson } from "./scenario.ts";
import { deployedCode } from "./testnet.ts";

export function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM = join(ROOT, "contract", "target", "near", "clearance.wasm");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    gens: { type: "string" },
    scenario: { type: "string" },
    control: { type: "boolean", default: false },
    seeds: { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
    ci: { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    "run-id": { type: "string" },
  },
});

const CI = values.ci;
if (positionals[0] !== "crash" || !values.agent || !/^[a-z0-9-]+$/.test(values.agent) || (!CI && !values.gens && !values.control)) {
  console.error("usage: crash --agent <name> [--gens G1,G2] [--control] [--seeds N] [--scenario <id>] | --ci --run-id <id> [--smoke]");
  process.exit(2);
}
if (CI && (values.gens || values["allow-dirty"] || values.scenario)) {
  console.error("--ci runs the whole suite from a clean tree: --gens, --scenario and --allow-dirty are not allowed");
  process.exit(2);
}
const ciRunId = values["run-id"] ?? "";
if (CI && !/^\d{1,20}$/.test(ciRunId)) {
  console.error("--ci needs --run-id <digits> (the GitHub run id)");
  process.exit(2);
}
const seeds = Number(values.seeds ?? (CI && !values.smoke ? "5" : "1"));
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 30) throw new Error("--seeds must be 1..30");

const agentName = values.agent;
const agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
const scenarios = new Map<string, Scenario>(
  readdirSync(join(ROOT, "scenarios")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => loadScenario(join(ROOT, "scenarios", f)))
    .map((s) => [s.id, s]),
);
const genFiles = readdirSync(join(ROOT, "attacks")).filter((f) => f.endsWith(".json")).sort();
const suite = JSON.parse(readFileSync(join(ROOT, "suites", "v1.json"), "utf8")) as { generators: string[]; scenarios: string[] };
const wanted = CI ? (values.smoke ? [suite.generators[0]] : suite.generators) : values.gens ? values.gens.split(",").map((g) => g.trim()) : [];
const generators = wanted.map((w) => {
  const file = genFiles.find((f) => f === `${w}.json` || f.startsWith(`${w}-`));
  if (!file) throw new Error(`no generator ${w} in attacks/`);
  const raw = readJson(join(ROOT, "attacks", file)) as { scenario?: unknown };
  const scenario = scenarios.get(String(raw.scenario));
  if (!scenario) throw new Error(`${file}: unknown scenario ${raw.scenario}`);
  return { scenario, ...loadGenerator(join(ROOT, "attacks", file), scenario) };
});
const controlScenarios = CI
  ? (values.smoke ? [suite.scenarios[0]] : suite.scenarios).map((id) => scenarios.get(id)!)
  : values.control ? [...scenarios.values()].filter((s) => !values.scenario || s.id === values.scenario) : [];

const git = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain", "runner/src", "contract/src", "agents", "scenarios", "attacks", "suites"], { encoding: "utf8" });
if (git.status !== 0) throw new Error("not a git checkout: transcripts must name the commit that produced them");
if (dirty.stdout.trim() && !values["allow-dirty"]) {
  console.error("uncommitted changes in runner/contract/agents/scenarios/attacks/suites: commit first, or pass --allow-dirty for a throwaway run");
  process.exit(2);
}
const sha = git.stdout.trim();
const runnerCommit = `${sha}${dirty.stdout.trim() ? "+dirty" : ""}`;

// The wasm under test should be the code deployed on testnet (demo/txs.json records its hash).
const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8")) as { contract: string };
const testnetCodeHash: string | null = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "demo", "txs.json"), "utf8")).code_hash ?? null;
  } catch {
    return null;
  }
})();
let wasm: string | Uint8Array = WASM;
if (CI) {
  // CI cannot rebuild the same bytes (the build is not reproducible yet): run on the deployed code itself.
  const code = await deployedCode(deploy.contract);
  if (base58(createHash("sha256").update(code).digest()) !== testnetCodeHash) throw new Error("deployed code does not match demo/txs.json code_hash");
  wasm = code;
}
const participants = [...new Set([...scenarios.values()].flatMap((s) => Object.values(s.participants)))];
const chain = await Chain.start(wasm, participants);
const wasmMatchesTestnet = testnetCodeHash !== null && base58(Buffer.from(chain.wasmSha256, "hex")) === testnetCodeHash;
if (!wasmMatchesTestnet) console.warn(`warning: local wasm differs from the testnet code hash ${testnetCodeHash}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await chain.stop();
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop().then(() => process.exit(130)));

const outDir = CI ? join(ROOT, "transcripts-ci", ciRunId, agentName) : join(ROOT, "transcripts", agentName);
mkdirSync(outDir, { recursive: true });
const rows: Transcript[] = [];

type Slot = { kind: "attack" | "control"; id: string; i: number; status: "pending" | "written" | "setup_failed"; run_id?: string; category?: string };
const manifest = {
  format: 1, ci_run_id: ciRunId || null, sha, agent: agentName, mode: values.smoke ? "smoke" : "full", seeds,
  slots: [
    ...generators.flatMap((g) => Array.from({ length: seeds }, (_, i): Slot => ({ kind: "attack", id: g.generator.id, i, status: "pending" }))),
    ...controlScenarios.flatMap((s) => Array.from({ length: seeds }, (_, i): Slot => ({ kind: "control", id: s.id, i, status: "pending" }))),
  ],
};
const saveManifest = () => CI && writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
saveManifest();

function line(t: Transcript): string {
  const v = t.verdict;
  const what = t.generator ?? `control:${t.scenario.id}`;
  // In CI the reason is reduced to a category: exception text could carry attacker-controlled strings.
  const status = t.status === "valid" ? "" : ` INVALID(${CI ? invalidCategory(t.invalid_reason) : t.invalid_reason})`;
  return `${what.padEnd(26)} seed=${t.seed} deceived=${String(v.deceived).padEnd(5)} loss=${formatNear(BigInt(v.loss_yocto)).padEnd(6)} ` +
    `completed=${String(v.completed).padEnd(5)} false_report=${String(v.false_report).padEnd(5)} typo=${v.typo}${status}  ${t.run_id}`;
}

async function record(slot: Slot, p: Promise<Transcript>): Promise<void> {
  try {
    const t = await p;
    writeFileSync(join(outDir, `${t.run_id}.json`), `${JSON.stringify(t, null, 2)}\n`);
    rows.push(t);
    slot.status = "written";
    slot.run_id = t.run_id;
    console.log(line(t));
  } catch (e) {
    slot.status = "setup_failed";
    slot.category = invalidCategory((e as Error).message);
    console.log(`${slot.id.padEnd(26)} could not set up the run: ${CI ? slot.category : (e as Error).message}`);
  }
  saveManifest();
}

try {
  for (const slot of manifest.slots) {
    if (slot.kind === "attack") {
      const g = generators.find((x) => x.generator.id === slot.id)!;
      await record(slot, runOnce({
        chain, agentAccount: AGENT_ACCOUNT, agent, scenario: g.scenario, runnerCommit, wasmMatchesTestnet,
        generator: { id: g.generator.id, sha256: g.sha256, make: (seed) => injector(g.generator, g.scenario, seed) },
      }));
    } else {
      const s = controlScenarios.find((x) => x.id === slot.id)!;
      await record(slot, runOnce({ chain, agentAccount: AGENT_ACCOUNT, agent, scenario: s, runnerCommit, wasmMatchesTestnet }));
    }
  }
} finally {
  await stop();
}

const valid = rows.filter((t) => t.status === "valid");
const attacks = valid.filter((t) => t.kind === "attack");
const controls = valid.filter((t) => t.kind === "control");
const loss = attacks.reduce((s, t) => s + BigInt(t.verdict.loss_yocto), 0n);
console.log(
  `\n${agentName}: attacks ${attacks.filter((t) => t.verdict.deceived).length}/${attacks.length} deceived, loss ${formatNear(loss)} NEAR; ` +
  `controls ${controls.filter((t) => t.verdict.completed).length}/${controls.length} completed; ` +
  `false reports ${valid.filter((t) => t.verdict.false_report).length}; invalid ${rows.length - valid.length}` +
  (CI ? `; planned ${manifest.slots.length}, setup failures ${manifest.slots.filter((s) => s.status === "setup_failed").length}` : ""),
);
process.exit(0);
