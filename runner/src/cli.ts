// Usage:
//   tsx src/cli.ts crash --agent naive [--gens G1,G2] [--control] [--seeds 3] [--scenario S1-invoice]
//   tsx src/cli.ts crash --agent protected-v3 --ci --run-id <id> [--smoke] [--seeds 5] [--concurrency 4]
// --concurrency N starts N sandboxes and runs one slot at a time on each: a run records every
// participant's balance, so two runs must never share a chain.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { injector, loadGenerator } from "./attack.ts";
import { AGENT_ACCOUNT, Chain, formatNear } from "./chain.ts";
import { invalidCategory } from "./integrity.ts";
import { RUN_BUDGET_MS, type Transcript, runOnce } from "./run.ts";
import { type Scenario, loadAgent, loadScenario, readJson } from "./scenario.ts";
import { base58 } from "./base58.ts";
import { deployedCode } from "./testnet.ts";

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
    concurrency: { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
    ci: { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    "run-id": { type: "string" },
    // Market jobs: a buyer's agent config from a file, transcripts outside the repo (see market-worker.ts).
    "agent-file": { type: "string" },
    out: { type: "string" },
    // Contract development only: run on the local build instead of the code deployed on testnet.
    "local-wasm": { type: "boolean", default: false },
  },
});

const CI = values.ci;
if (positionals[0] !== "crash" || !values.agent || !/^[a-z0-9-]+$/.test(values.agent) || (!CI && !values.gens && !values.control)
  || (CI && (values["agent-file"] || values.out)) || (!!values["agent-file"] !== !!values.out)) {
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
const concurrency = Number(values.concurrency ?? "1");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be 1..8");

const agentName = values.agent;
const agent = loadAgent(values["agent-file"] ? resolve(values["agent-file"]) : join(ROOT, "agents", `${agentName}.json`));
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
// External toolsets have no swap in their emulation (OutLayer swaps go through NEAR Intents; AgentKit's
// swap is not in its WalletActionProvider; Agent Connect swaps need 1Click solvers): a swap task would score a
// missing capability, not judgement.
if (agent.tools !== "clearance-v1") {
  const swap = [...generators.map((g) => g.scenario), ...(values.control ? [...scenarios.values()].filter((s) => !values.scenario || s.id === values.scenario) : [])]
    .find((s) => s.correct.tool === "swap");
  if (swap) throw new Error(`${swap.id} is a swap scenario: not supported by toolset ${agent.tools}`);
}
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

// The wasm under test should be the code deployed on testnet (deploy/contract.json records its hash).
const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8")) as { contract: string };
const testnetCodeHash: string | null = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "deploy", "contract.json"), "utf8")).code_hash ?? null;
  } catch {
    return null;
  }
})();
let wasm: string | Uint8Array = WASM;
if (CI || !values["local-wasm"]) {
  // Run on the deployed code itself (make verify-build shows it is the reproducible build of the sources);
  // a local build embeds the current commit (NEP-330), so its bytes differ from testnet's.
  const code = await deployedCode(deploy.contract);
  if (base58(createHash("sha256").update(code).digest()) !== testnetCodeHash) throw new Error("deployed code does not match deploy/contract.json code_hash");
  wasm = code;
}
const participants = [...new Set([...scenarios.values()].flatMap((s) => Object.values(s.participants)))];
const wasmBytes = typeof wasm === "string" ? readFileSync(wasm) : wasm;
const wasmMatchesTestnet = testnetCodeHash !== null && base58(createHash("sha256").update(wasmBytes).digest()) === testnetCodeHash;
if (!wasmMatchesTestnet) console.warn(`warning: local wasm differs from the testnet code hash ${testnetCodeHash}`);

// The manifest is written before any sandbox starts: if nothing runs, every slot stays "pending".
const outDir = CI ? join(ROOT, "transcripts-ci", ciRunId, agentName) : values.out ? resolve(values.out) : join(ROOT, "transcripts", agentName);
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
if (manifest.slots.length === 0) {
  console.error("nothing to run: no generator or scenario matched");
  process.exit(2);
}

// After a signal no worker takes another slot; stop() is shared, so every caller waits for the same teardown.
const chains: Chain[] = [];
let aborted = false;
let stopping: Promise<void> | null = null;
const stop = () => (stopping ??= Promise.all(chains.map((c) => c.stop())).then(() => {}));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    aborted = true;
    void stop().then(() => process.exit(130));
  });
}
const workers = Math.min(concurrency, manifest.slots.length);
const started = await Promise.allSettled(Array.from({ length: workers }, () => Chain.start(wasm, participants)));
for (const r of started) if (r.status === "fulfilled") chains.push(r.value);
if (aborted) {
  // A signal during start-up stopped no chain yet: stop the ones that came up, then exit.
  await Promise.all(chains.map((c) => c.stop()));
  process.exit(130);
}
if (chains.length === 0) throw (started[0] as PromiseRejectedResult).reason;
// Slots do not depend on which sandbox runs them, so fewer sandboxes only make the run slower.
if (chains.length < workers) console.warn(`warning: ${workers - chains.length} of ${workers} sandboxes failed to start`);

function line(t: Transcript): string {
  const v = t.verdict;
  const what = t.generator ?? `control:${t.scenario.id}`;
  // In CI the reason is reduced to a category: exception text could carry attacker-controlled strings.
  const status = t.status === "valid" ? "" : ` INVALID(${CI ? invalidCategory(t.invalid_reason) : t.invalid_reason})`;
  return `${what.padEnd(26)} seed=${t.seed} deceived=${String(v.deceived).padEnd(5)} loss=${formatNear(BigInt(v.loss_yocto)).padEnd(6)} ` +
    `completed=${String(v.completed).padEnd(5)} false_report=${String(v.false_report).padEnd(5)} typo=${v.typo}${status}  ${t.run_id}`;
}

const WATCHDOG = Symbol("watchdog");
/** Runs one slot; returns false if the sandbox must not be used again (the run hung past its budget). */
async function record(slot: Slot, run: Promise<Transcript>): Promise<boolean> {
  run.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<typeof WATCHDOG>((r) => { timer = setTimeout(() => r(WATCHDOG), RUN_BUDGET_MS + 5 * 60_000); });
  let t: Transcript | typeof WATCHDOG;
  try {
    t = await Promise.race([run, hung]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    slot.status = "setup_failed";
    slot.category = invalidCategory(msg);
    console.log(`${slot.id.padEnd(26)} could not set up the run: ${CI ? slot.category : msg}`);
    saveManifest();
    return true;
  } finally {
    clearTimeout(timer);
  }
  if (t === WATCHDOG) {
    slot.status = "setup_failed";
    slot.category = "run watchdog";
    console.log(`${slot.id.padEnd(26)} run hung past its budget; its sandbox is retired`);
    saveManifest();
    return false;
  }
  writeFileSync(join(outDir, `${t.run_id}.json`), `${JSON.stringify(t, null, 2)}\n`);
  rows.push(t);
  slot.status = "written";
  slot.run_id = t.run_id;
  saveManifest();
  console.log(line(t));
  return true;
}

// Each worker owns one chain and takes the next pending slot. A run's verdict does not depend on the
// order; its recorded absolute balances and vault id do, since earlier runs on that chain moved money.
let next = 0;
let fatal: unknown = null;
async function worker(chain: Chain): Promise<void> {
  try {
    while (!aborted && next < manifest.slots.length) {
      const slot = manifest.slots[next++];
      const g = slot.kind === "attack" ? generators.find((x) => x.generator.id === slot.id)! : null;
      const scenario = g ? g.scenario : controlScenarios.find((x) => x.id === slot.id)!;
      const usable = await record(slot, runOnce({
        chain, agentAccount: AGENT_ACCOUNT, agent, scenario, runnerCommit, wasmMatchesTestnet,
        generator: g ? { id: g.generator.id, sha256: g.sha256, make: (seed) => injector(g.generator, g.scenario, seed) } : undefined,
      }));
      if (!usable) return void (await chain.stop());
    }
  } catch (e) {
    // Only bookkeeping (writing a file) can throw here: stop handing out slots, let the others finish.
    fatal ??= e;
    aborted = true;
  }
}

try {
  await Promise.all(chains.map(worker));
} finally {
  await stop();
}
if (fatal) throw fatal;

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
