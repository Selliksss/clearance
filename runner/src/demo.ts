// Usage: tsx src/demo.ts [--offline]
// One command for judges. Needs only Node (no Rust, no keys). Every step prints
// PASS or FAIL and where its evidence came from:
//   LOCAL   computed from the repo (transcripts, reports, policy files)
//   LIVE    read from NEAR testnet just now (archival RPC, retried)
//   CACHED  a testnet answer saved in demo/rpc-cache/ (used offline or when the
//           network fails; it only means "matches what was saved", not "still true")
// Steps: replay every transcript and report; the live certificate on testnet
// carries the report_hash that the transcripts rebuild; the contract on testnet
// runs the recorded code; every recorded demo transaction ended as expected; the
// exported OutLayer policy is valid for the certified level; the README names the
// live certificate.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTranscript } from "./integrity.ts";
import { policyLevel, validatePolicy } from "./policy.ts";
import { buildReport, reportHash } from "./report.ts";
import type { Transcript } from "./run.ts";
import { canonical, loadAgent } from "./scenario.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFLINE = process.argv.includes("--offline");
const CACHE = join(ROOT, "demo", "rpc-cache");
const ENDPOINTS = ["https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const EXPLORER = "https://testnet.nearblocks.io";

type Source = "LOCAL" | "LIVE" | "CACHED";
let failures = 0;
function step(ok: boolean, source: Source, name: string, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} [${source.padEnd(6)}] ${name}${detail ? `  ${detail}` : ""}`);
}

/** A JSON-RPC call answered live (with retries over several providers) or from the cache. */
async function rpc(method: string, params: unknown): Promise<{ result: any; source: Source }> {
  const key = createHash("sha256").update(canonical({ method, params })).digest("hex").slice(0, 32);
  const file = join(CACHE, `${key}.json`);
  if (!OFFLINE) {
    for (const url of ENDPOINTS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000),
          });
          if (r.status === 429) {
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
            continue;
          }
          const j = await r.json();
          if (j.result !== undefined) {
            mkdirSync(CACHE, { recursive: true });
            writeFileSync(file, `${JSON.stringify({ method, params, result: j.result }, null, 1)}\n`);
            return { result: j.result, source: "LIVE" };
          }
          break; // a definite RPC error from this provider: try the next one
        } catch {
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        }
      }
    }
  }
  if (existsSync(file)) return { result: JSON.parse(readFileSync(file, "utf8")).result, source: "CACHED" };
  throw new Error(`no answer for ${method} (offline and not cached)`);
}

async function view<T>(contract: string, method: string, args: Record<string, unknown>): Promise<{ value: T; source: Source }> {
  const { result, source } = await rpc("query", {
    request_type: "call_function", finality: "final", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return { value: JSON.parse(Buffer.from(result.result).toString()) as T, source };
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

async function main() {
  console.log(`Clearance demo${OFFLINE ? " (offline: testnet answers come from demo/rpc-cache/)" : ""}\n`);
  const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8"));
  const txs = JSON.parse(readFileSync(join(ROOT, "demo", "txs.json"), "utf8"));
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  // 1. Every transcript passes integrity and every committed report equals a rebuild.
  const agents = readdirSync(join(ROOT, "transcripts")).filter((d) => d !== "archive" && existsSync(join(ROOT, "agents", `${d}.json`))).sort();
  let transcripts = 0;
  const broken: string[] = [];
  for (const a of agents) {
    const agent = loadAgent(join(ROOT, "agents", `${a}.json`));
    for (const f of readdirSync(join(ROOT, "transcripts", a)).filter((x) => x.endsWith(".json"))) {
      const t: Transcript = JSON.parse(readFileSync(join(ROOT, "transcripts", a, f), "utf8"));
      transcripts++;
      const c = checkTranscript(ROOT, f, t, agent);
      if (c.problems.length) broken.push(`${a}/${f}: ${c.problems[0]}`);
    }
  }
  step(broken.length === 0, "LOCAL", `${transcripts} transcripts pass integrity (hashes, TEE signatures, history, verdicts)`, broken[0] ?? "");
  const reports: Record<string, ReturnType<typeof buildReport>> = {};
  for (const a of agents) {
    const rebuilt = buildReport(ROOT, a);
    reports[a] = rebuilt;
    const committed = existsSync(join(ROOT, "reports", `${a}.json`)) ? readFileSync(join(ROOT, "reports", `${a}.json`), "utf8") : "";
    step(committed === `${JSON.stringify(rebuilt, null, 2)}\n`, "LOCAL", `report ${a} rebuilds byte for byte: level ${rebuilt.level}`, `report_hash ${reportHash(rebuilt).slice(0, 12)}…`);
  }

  // 2. The contract on testnet runs the code the runs were made against.
  const acct = await rpc("query", { request_type: "view_account", finality: "final", account_id: deploy.contract });
  step(acct.result.code_hash === txs.code_hash, acct.source, `${deploy.contract} runs code ${acct.result.code_hash.slice(0, 10)}…`, `recorded ${txs.code_hash.slice(0, 10)}…`);

  // 3. Each agent's live certificate carries the report_hash its transcripts rebuild; level-0 agents hold none.
  for (const a of agents) {
    const account = deploy.agents[a];
    const r = reports[a];
    if (!account) {
      step(r.level === 0, "LOCAL", `${a}: level ${r.level}, no testnet account configured`, r.level === 0 ? "no certificate expected" : "a certified level needs an account");
      continue;
    }
    const { value: cert, source } = await view<{ level: number; report_hash: string; config_hash: string; expires_ns: string } | null>(
      deploy.contract, "get_cert", { agent: account, signer: deploy.runner });
    if (r.level === 0) {
      step(cert === null || cert.report_hash !== reportHash(r), source, `${a}: level 0 and ${account} holds no certificate from this report`);
      continue;
    }
    const ok = !!cert && cert.report_hash === reportHash(r) && cert.level === r.level && cert.config_hash === r.agent_config_hash;
    const expires = cert ? new Date(Number(BigInt(cert.expires_ns) / 1_000_000n)).toISOString().slice(0, 16) : "-";
    step(ok, source, `${a}: certificate on ${account} = level ${cert?.level ?? "none"}, report_hash matches the rebuild`, `expires ${expires} UTC`);
    const ledger = existsSync(join(ROOT, "reports", `${a}.certs.json`)) ? JSON.parse(readFileSync(join(ROOT, "reports", `${a}.certs.json`), "utf8")) : [];
    const live = ledger.filter((e: { revoked?: unknown }) => !e.revoked).at(-1);
    if (live) {
      step(readme.includes(live.tx.slice(0, 8)), "LOCAL", `README names the live certificate tx`, `${EXPLORER}/txns/${live.tx}`);
      const policyFile = join(ROOT, "policies", `${a}.outlayer.json`);
      if (existsSync(policyFile) && cert) {
        const policy = JSON.parse(readFileSync(policyFile, "utf8"));
        const errors = validatePolicy(policy);
        let level: number | string;
        try {
          level = policyLevel(r, reportHash(r), cert as never, BigInt(Date.now()) * 1_000_000n);
        } catch (e) {
          level = (e as Error).message;
        }
        const perTx = BigInt(policy.rules.limits.per_transaction.native);
        const expected = level === 2 ? 3n * 10n ** 24n : level === 1 ? 10n ** 24n : -1n;
        step(errors.length === 0 && perTx === expected, source, `OutLayer policy for ${a} is valid for level ${level}`, errors[0] ?? `per transaction ${perTx / 10n ** 24n} NEAR`);
      }
    }
  }

  // 4. Every recorded demo transaction ended as expected (refusals by their panic text).
  for (const s of txs.steps) {
    try {
      const { result, source } = await rpc("tx", { tx_hash: s.tx, sender_account_id: s.signer, wait_until: "FINAL" });
      const text = JSON.stringify(result);
      const panic = (text.match(/Smart contract panicked: ([^"\\]+)/) || [])[1] ?? null;
      const failed = result.receipts_outcome.some((o: any) => o.outcome.status.Failure);
      const value = result.status?.SuccessValue;
      const fc = result.transaction.actions.find((x: any) => x.FunctionCall)?.FunctionCall;
      const argsOnChain = fc ? sortKeys(JSON.parse(Buffer.from(fc.args, "base64").toString())) : null;
      const sameArgs = canonical(argsOnChain) === canonical(sortKeys(s.args)) && fc?.method_name === s.method;
      const ok = sameArgs && (s.expect === "failure" ? !!panic && panic.includes(s.error)
        : s.expect === "landed" ? !failed && value === Buffer.from("true").toString("base64")
          : !failed && typeof value === "string");
      step(ok, source, s.step, `${EXPLORER}/txns/${s.tx}`);
    } catch (e) {
      step(false, OFFLINE ? "CACHED" : "LIVE", s.step, (e as Error).message);
    }
  }

  console.log(`\n${failures ? `${failures} step(s) FAILED` : "all steps PASS"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`demo crashed: ${(e as Error).message}`);
  process.exit(2);
});
