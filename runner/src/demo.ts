// Usage: tsx src/demo.ts [--offline]
// One command for judges. Needs only Node >= 20 (no Rust, no keys). Every step
// prints PASS, FAIL or INFO and where its evidence came from:
//   LOCAL   computed from the repo (transcripts, reports, policy files, git)
//   LIVE    read from NEAR testnet just now (archival RPC, retried)
//   CACHED  a testnet answer saved in demo/rpc-cache/, shown with the block it was
//           read at (used offline or once the network fails; it means "matches
//           what was saved at that block", not "still true now")
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTranscript } from "./integrity.ts";
import { policyLevel, validatePolicy } from "./policy.ts";
import { buildReport, reportHash } from "./report.ts";
import type { Transcript } from "./run.ts";
import { canonical, loadAgent } from "./scenario.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFLINE = process.argv.includes("--offline");
/** Live answers refresh demo/rpc-cache/ only when asked, so a judge's run leaves the checkout clean. */
const RECORD = process.argv.includes("--record-cache");
const CACHE = join(ROOT, "demo", "rpc-cache");
const ENDPOINTS = ["https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const EXPLORER = "https://testnet.nearblocks.io";
const NEAR = 10n ** 24n;

type Source = "LOCAL" | "LIVE" | "CACHED";
type Answer = { result: any; source: Source; label: string };
const counts = { PASS: 0, FAIL: 0, LIVE: 0, CACHED: 0 };
let networkDown = OFFLINE;

function step(ok: boolean, a: { source: Source; label?: string } | Source, name: string, detail = "") {
  const src = typeof a === "string" ? { source: a, label: a } : { source: a.source, label: a.label ?? a.source };
  counts[ok ? "PASS" : "FAIL"]++;
  if (src.source !== "LOCAL") counts[src.source]++;
  console.log(`${ok ? "PASS" : "FAIL"} [${src.label}] ${name}${detail ? `  ${detail}` : ""}`);
}
const info = (name: string, detail = "") => console.log(`INFO [LOCAL] ${name}${detail ? `  ${detail}` : ""}`);

/** Accepts only answers that carry what the step needs, so an error never gets cached. */
function usable(method: string, params: any, result: any): boolean {
  if (method === "tx") return !!result?.status && !!result?.transaction;
  if (params?.request_type === "view_account") return typeof result?.code_hash === "string";
  if (params?.request_type === "call_function") return Array.isArray(result?.result);
  return result !== undefined;
}

/** A JSON-RPC call answered live (retries over several providers, one overall deadline) or from the cache. */
async function rpc(method: string, params: unknown): Promise<Answer> {
  const key = createHash("sha256").update(canonical({ method, params })).digest("hex").slice(0, 32);
  const file = join(CACHE, `${key}.json`);
  if (!networkDown) {
    const deadline = Date.now() + 45_000;
    for (const url of ENDPOINTS) {
      for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
        try {
          const r = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000),
          });
          if (r.status === 429) {
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
            continue;
          }
          const j = await r.json();
          if (usable(method, params, j.result)) {
            if (RECORD || !existsSync(file)) {
              mkdirSync(CACHE, { recursive: true });
              writeFileSync(file, `${JSON.stringify({ method, params, result: j.result }, null, 1)}\n`);
            }
            return { result: j.result, source: "LIVE", label: "LIVE" };
          }
          break; // a definite error from this provider: try the next one
        } catch {
          await new Promise((res) => setTimeout(res, 800));
        }
      }
    }
    networkDown = true; // one fully failed call: use the cache for the rest instead of waiting again
    console.log("INFO [LOCAL] testnet unreachable; the remaining testnet steps use demo/rpc-cache/");
  }
  if (existsSync(file)) {
    const result = JSON.parse(readFileSync(file, "utf8")).result;
    const height = result.block_height ?? result.transaction_outcome?.block_hash?.slice(0, 8);
    return { result, source: "CACHED", label: `CACHED @${height ?? "?"}` };
  }
  throw new Error(`no answer for ${method} (testnet unreachable and not cached)`);
}

async function view<T>(contract: string, method: string, args: Record<string, unknown>): Promise<Answer & { value: T }> {
  const a = await rpc("query", {
    request_type: "call_function", finality: "final", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return { ...a, value: JSON.parse(Buffer.from(a.result.result).toString()) as T };
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** "0.05 NEAR" / "1 yoctoNEAR" / "0 NEAR" -> yocto string. */
function depositYocto(d: string | undefined): string {
  if (!d) return "0";
  const m = d.trim().match(/^([\d.]+)\s*(NEAR|yoctoNEAR)$/);
  if (!m) return "?";
  if (m[2] === "yoctoNEAR") return m[1];
  const [w, f = ""] = m[1].split(".");
  return (BigInt(w) * NEAR + BigInt(f.padEnd(24, "0"))).toString();
}

type Cert = { level: number; report_hash: string; config_hash: string; suite_hash: string; expires_ns: string } | null;

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error(`Node >= 20 required, found ${process.versions.node}`);
  console.log(`Clearance demo${OFFLINE ? " (offline: testnet answers come from demo/rpc-cache/)" : ""}\n`);
  const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8"));
  const txs = JSON.parse(readFileSync(join(ROOT, "demo", "txs.json"), "utf8"));
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const nowNs = BigInt(Date.now()) * 1_000_000n;

  // 1. Transcripts and reports.
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

  // 2. Contract code: on testnet now, and the source it was built from.
  try {
    const acct = await rpc("query", { request_type: "view_account", finality: "final", account_id: deploy.contract });
    step(acct.result.code_hash === txs.code_hash, acct, `${deploy.contract} runs code ${acct.result.code_hash.slice(0, 10)}…`, `recorded ${txs.code_hash.slice(0, 10)}…`);
  } catch (e) {
    step(false, "LIVE", `${deploy.contract} code hash`, (e as Error).message);
  }
  // Everything the wasm is built from; unit tests (cfg(test)) are not part of it.
  const sources = ["contract/src", ":(exclude)contract/src/tests.rs", "contract/Cargo.toml", "contract/Cargo.lock", "contract/rust-toolchain.toml"];
  const git = spawnSync("git", ["-C", ROOT, "diff", "--quiet", txs.commit, "--", ...sources], { encoding: "utf8" });
  if (git.status === 0) step(true, "LOCAL", `the contract sources are unchanged since commit ${txs.commit.slice(0, 8)}, which built the recorded code`);
  else if (git.status === 1) step(false, "LOCAL", `the contract sources changed since commit ${txs.commit.slice(0, 8)}, which built the recorded code`);
  else info("git unavailable: cannot compare contract/src with the commit that built the recorded code");
  info("the wasm is built non-reproducibly, so its hash cannot be rebuilt from source; the final contract will use a reproducible build (NEP-330)");

  // 3. Certificates: the live one carries the report_hash its transcripts rebuild; level-0 agents hold none.
  for (const a of agents) {
    const account = deploy.agents[a];
    const r = reports[a];
    if (!account) {
      step(r.level === 0, "LOCAL", `${a}: level ${r.level}, no testnet account configured`, r.level === 0 ? "no certificate expected" : "a certified level needs an account");
      continue;
    }
    let got: Answer & { value: Cert };
    try {
      got = await view<Cert>(deploy.contract, "get_cert", { agent: account, signer: deploy.runner });
    } catch (e) {
      step(false, "LIVE", `${a}: certificate on ${account}`, (e as Error).message);
      continue;
    }
    const cert = got.value;
    const live = !!cert && BigInt(cert.expires_ns) > nowNs;
    if (r.level === 0) {
      step(!live, got, `${a}: level 0, and ${account} holds no live certificate from ${deploy.runner}`);
      continue;
    }
    const matches = !!cert && cert.report_hash === reportHash(r) && cert.level === r.level
      && cert.config_hash === r.agent_config_hash && cert.suite_hash === r.suite_hash;
    step(matches, got, `${a}: certificate on ${account} = level ${cert?.level ?? "none"}; report, config and suite hashes match the rebuild`);
    const daysLeft = cert ? Number((BigInt(cert.expires_ns) - nowNs) / 86_400_000_000_000n) : 0;
    step(live, got, `${a}: certificate is live`, live ? `${daysLeft} day(s) left` : "expired: certificates last at most 30 days by design; the author re-issues with make certify");
    const ledgerFile = join(ROOT, "reports", `${a}.certs.json`);
    const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : [];
    const entry = ledger.filter((e: { revoked?: unknown }) => !e.revoked).at(-1);
    step(!!entry && entry.args.report_hash === cert?.report_hash && readme.includes(entry.tx), "LOCAL",
      `README links the certificate transaction for this report`, entry ? `${EXPLORER}/txns/${entry.tx}` : "no ledger entry");
    // A stale cache would vouch for an older certificate: the one on chain must be the latest one issued.
    const latest = !!entry && !!cert && String(entry.expires_ns) === String(cert.expires_ns);
    step(latest, got, `${a}: the certificate on testnet is the latest one issued (ledger ${entry?.tx?.slice(0, 8) ?? "-"}…)`,
      !latest && got.source === "CACHED" ? "cache is older than the last make certify: run make demo ARGS=--record-cache" : "");
    const policyFile = join(ROOT, "policies", `${a}.outlayer.json`);
    if (!existsSync(policyFile)) {
      step(false, "LOCAL", `OutLayer policy for ${a}`, "missing");
    } else if (!live) {
      info(`OutLayer policy check for ${a} skipped: the certificate has expired`);
    } else {
      const policy = JSON.parse(readFileSync(policyFile, "utf8"));
      const link = existsSync(join(ROOT, "policies", `${a}.clearance.json`)) ? JSON.parse(readFileSync(join(ROOT, "policies", `${a}.clearance.json`), "utf8")) : null;
      const errors = validatePolicy(policy);
      const level = policyLevel(r, reportHash(r), cert, nowNs);
      const limits = { 1: [1n, 3n], 2: [3n, 10n] }[level]!;
      const ok = errors.length === 0 && BigInt(policy.rules.limits.per_transaction.native) === limits[0] * NEAR
        && BigInt(policy.rules.limits.daily.native) === limits[1] * NEAR && link?.agent === account && link?.report_hash === reportHash(r);
      step(ok, got, `OutLayer policy for ${a} matches level ${level}`, errors[0] ?? `${limits[0]} NEAR per transfer, ${limits[1]} per day, whitelist`);
    }
  }

  // 4. Recorded demo transactions: right contract, signer, method, args, deposit and outcome.
  for (const [i, s] of txs.steps.entries()) {
    try {
      if (!["success", "landed", "failure"].includes(s.expect)) throw new Error(`unknown expectation ${s.expect}`);
      const got = await rpc("tx", { tx_hash: s.tx, sender_account_id: s.signer, wait_until: "FINAL" });
      const res = got.result;
      const fc = res.transaction.actions.find((x: any) => x.FunctionCall)?.FunctionCall;
      const argsOnChain = fc ? sortKeys(JSON.parse(Buffer.from(fc.args, "base64").toString())) : null;
      const same = res.transaction.receiver_id === deploy.contract && res.transaction.signer_id === s.signer
        && fc?.method_name === s.method && canonical(argsOnChain) === canonical(sortKeys(s.args)) && String(fc?.deposit) === depositYocto(s.deposit);
      const contractFailure = res.receipts_outcome.find((o: any) => o.outcome.executor_id === deploy.contract && o.outcome.status.Failure);
      const panic = contractFailure?.outcome.status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? null;
      const anyFailure = res.receipts_outcome.some((o: any) => o.outcome.status.Failure);
      const value = res.status?.SuccessValue;
      const decoded = typeof value === "string" && value ? JSON.parse(Buffer.from(value, "base64").toString()) : null;
      const outcome = s.expect === "failure"
        ? !!res.status?.Failure && typeof panic === "string" && panic.includes(s.error)
        : !anyFailure && typeof value === "string" && (s.expect !== "landed" || decoded === true)
          && (s.return_value === undefined || s.return_value === null || canonical(decoded) === canonical(s.return_value));
      step(same && outcome, got, s.step, `${EXPLORER}/txns/${s.tx}`);
      // The code at the time of the first and last recorded transaction was the recorded code.
      if (i === 0 || i === txs.steps.length - 1) {
        const then = await rpc("query", { request_type: "view_account", block_id: s.block_hash, account_id: deploy.contract });
        step(then.result.code_hash === txs.code_hash, then, `  contract code at that block was ${txs.code_hash.slice(0, 10)}…`);
      }
    } catch (e) {
      step(false, networkDown ? "CACHED" : "LIVE", s.step, (e as Error).message);
    }
  }

  console.log(`\n${counts.FAIL ? `${counts.FAIL} step(s) FAILED` : "all steps PASS"}  (${counts.PASS} pass; testnet evidence: ${counts.LIVE} live, ${counts.CACHED} cached)`);
  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error(`demo crashed: ${(e as Error).message}`);
  process.exit(2);
});
