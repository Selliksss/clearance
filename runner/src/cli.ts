// Usage:
//   tsx src/cli.ts crash --agent naive [--scenario S1-invoice] [--control] [--runs 1]
// Writes transcripts/<agent>/<run_id>.json (invalid runs included, marked) and prints one line per run.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_ACCOUNT, Chain, formatNear } from "./chain.ts";
import { runOnce } from "./run.ts";
import { loadAgent, loadScenario } from "./scenario.ts";

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
    scenario: { type: "string" },
    control: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    "allow-dirty": { type: "boolean", default: false },
  },
});

if (positionals[0] !== "crash" || !values.agent || !/^[a-z0-9-]+$/.test(values.agent)) {
  console.error("usage: crash --agent <name> [--scenario <id>] [--control] [--runs N]");
  process.exit(2);
}
if (!values.control) {
  console.error("attack generators arrive with the format interpreter; run with --control for now");
  process.exit(2);
}

const agentName = values.agent;
const agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
const scenarioFiles = readdirSync(join(ROOT, "scenarios")).filter((f) => f.endsWith(".json")).sort();
const scenarios = scenarioFiles.map((f) => loadScenario(join(ROOT, "scenarios", f)))
  .filter((s) => !values.scenario || s.id === values.scenario);
if (scenarios.length === 0) throw new Error(`no scenario ${values.scenario}`);
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw new Error("--runs must be 1..30");

const git = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain", "runner/src", "contract/src", "agents", "scenarios"], { encoding: "utf8" });
if (git.status !== 0) throw new Error("not a git checkout: transcripts must name the commit that produced them");
if (dirty.stdout.trim() && !values["allow-dirty"]) {
  console.error("uncommitted changes in runner/contract/agents/scenarios: commit first, or pass --allow-dirty for a throwaway run");
  process.exit(2);
}
const runnerCommit = `${git.stdout.trim()}${dirty.stdout.trim() ? "+dirty" : ""}`;

const participants = [...new Set(scenarios.flatMap((s) => Object.values(s.participants)))];
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
let failures = 0;
try {
  for (const scenario of scenarios) {
    for (let i = 0; i < runs; i++) {
      let t;
      try {
        t = await runOnce({ chain, agentAccount: AGENT_ACCOUNT, agent, scenario, runnerCommit, wasmMatchesTestnet });
      } catch (e) {
        failures++;
        console.log(`invalid ${scenario.id}: could not set up the run: ${(e as Error).message}`);
        continue;
      }
      writeFileSync(join(outDir, `${t.run_id}.json`), `${JSON.stringify(t, null, 2)}\n`);
      const v = t.verdict;
      if (t.status !== "valid" || !v.completed || v.deceived) failures++;
      const calls = t.turns.flatMap((x) => x.tool_calls.map((c) => c.name)).join(",");
      console.log(
        `${t.status === "valid" ? t.kind : `INVALID(${t.invalid_reason})`} ${scenario.id} completed=${v.completed} ` +
        `deceived=${v.deceived} loss=${formatNear(BigInt(v.loss_yocto))} false_report=${v.false_report} ` +
        `typo=${v.typo} turns=${t.turns.length} signed=${t.agent.attested} tools=[${calls}] -> ${t.run_id}`,
      );
    }
  }
} finally {
  await stop();
}
process.exit(failures ? 1 : 0);
