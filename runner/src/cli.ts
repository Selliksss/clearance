// Usage:
//   tsx src/cli.ts crash --agent naive [--gens G1,G2] [--control] [--seeds 3] [--scenario S1-invoice]
// Attack runs: each generator × seeds. Control runs (--control): each scenario × seeds, no injection.
// Writes transcripts/<agent>/<run_id>.json (invalid runs included, marked) and prints a table.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { injector, loadGenerator } from "./attack.ts";
import { readJson } from "./scenario.ts";
import { AGENT_ACCOUNT, Chain, formatNear } from "./chain.ts";
import { type Transcript, runOnce } from "./run.ts";
import { type Scenario, loadAgent, loadScenario } from "./scenario.ts";

function base58(bytes: Uint8Array): string {
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
    seeds: { type: "string", default: "1" },
    "allow-dirty": { type: "boolean", default: false },
  },
});

if (positionals[0] !== "crash" || !values.agent || !/^[a-z0-9-]+$/.test(values.agent) || (!values.gens && !values.control)) {
  console.error("usage: crash --agent <name> [--gens G1,G2] [--control] [--seeds N] [--scenario <id>]");
  process.exit(2);
}
const seeds = Number(values.seeds);
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 30) throw new Error("--seeds must be 1..30");

const agentName = values.agent;
const agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
const scenarios = new Map<string, Scenario>(
  readdirSync(join(ROOT, "scenarios")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => loadScenario(join(ROOT, "scenarios", f)))
    .map((s) => [s.id, s]),
);
const genFiles = readdirSync(join(ROOT, "attacks")).filter((f) => f.endsWith(".json")).sort();
const wanted = values.gens ? values.gens.split(",").map((g) => g.trim()) : [];
const generators = wanted.map((w) => {
  const file = genFiles.find((f) => f === `${w}.json` || f.startsWith(`${w}-`));
  if (!file) throw new Error(`no generator ${w} in attacks/`);
  const raw = readJson(join(ROOT, "attacks", file)) as { scenario?: unknown };
  const scenario = scenarios.get(String(raw.scenario));
  if (!scenario) throw new Error(`${file}: unknown scenario ${raw.scenario}`);
  return { scenario, ...loadGenerator(join(ROOT, "attacks", file), scenario) };
});
const controlScenarios = values.control
  ? [...scenarios.values()].filter((s) => !values.scenario || s.id === values.scenario)
  : [];

const git = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain", "runner/src", "contract/src", "agents", "scenarios", "attacks"], { encoding: "utf8" });
if (git.status !== 0) throw new Error("not a git checkout: transcripts must name the commit that produced them");
if (dirty.stdout.trim() && !values["allow-dirty"]) {
  console.error("uncommitted changes in runner/contract/agents/scenarios/attacks: commit first, or pass --allow-dirty for a throwaway run");
  process.exit(2);
}
const runnerCommit = `${git.stdout.trim()}${dirty.stdout.trim() ? "+dirty" : ""}`;

const participants = [...new Set([...scenarios.values()].flatMap((s) => Object.values(s.participants)))];
const chain = await Chain.start(WASM, participants);
// The wasm under test should be the code deployed on testnet (demo/txs.json records its hash).
const testnetCodeHash: string | null = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "demo", "txs.json"), "utf8")).code_hash ?? null;
  } catch {
    return null;
  }
})();
const wasmMatchesTestnet = testnetCodeHash !== null && base58(Buffer.from(chain.wasmSha256, "hex")) === testnetCodeHash;
if (!wasmMatchesTestnet) console.warn(`warning: local wasm differs from the testnet code hash ${testnetCodeHash}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await chain.stop();
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop().then(() => process.exit(130)));

const outDir = join(ROOT, "transcripts", agentName);
mkdirSync(outDir, { recursive: true });
const rows: Transcript[] = [];

function line(t: Transcript): string {
  const v = t.verdict;
  const what = t.generator ?? `control:${t.scenario.id}`;
  const status = t.status === "valid" ? "" : ` INVALID(${t.invalid_reason})`;
  return `${what.padEnd(26)} seed=${t.seed} deceived=${String(v.deceived).padEnd(5)} loss=${formatNear(BigInt(v.loss_yocto)).padEnd(6)} ` +
    `completed=${String(v.completed).padEnd(5)} false_report=${String(v.false_report).padEnd(5)} typo=${v.typo}${status}  ${t.run_id}`;
}

async function record(p: Promise<Transcript>, label: string): Promise<void> {
  try {
    const t = await p;
    writeFileSync(join(outDir, `${t.run_id}.json`), `${JSON.stringify(t, null, 2)}\n`);
    rows.push(t);
    console.log(line(t));
  } catch (e) {
    console.log(`${label.padEnd(26)} could not set up the run: ${(e as Error).message}`);
  }
}

try {
  for (const g of generators) {
    for (let i = 0; i < seeds; i++) {
      await record(runOnce({
        chain, agentAccount: AGENT_ACCOUNT, agent, scenario: g.scenario, runnerCommit, wasmMatchesTestnet,
        generator: { id: g.generator.id, sha256: g.sha256, make: (seed) => injector(g.generator, g.scenario, seed) },
      }), g.generator.id);
    }
  }
  for (const s of controlScenarios) {
    for (let i = 0; i < seeds; i++) {
      await record(runOnce({ chain, agentAccount: AGENT_ACCOUNT, agent, scenario: s, runnerCommit, wasmMatchesTestnet }), `control:${s.id}`);
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
  `false reports ${valid.filter((t) => t.verdict.false_report).length}; invalid ${rows.length - valid.length}`,
);
process.exit(0);
