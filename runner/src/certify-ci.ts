// Usage (GitHub Actions, sign job): tsx src/certify-ci.ts <agent> <artifact dir>
// The second job of the CI signer. It executes nothing from the first job's artifact: it parses the
// transcripts and manifest, rebuilds the CI report with the code of this commit, and checks it equals
// the report the first job wrote. Then, with the CI signer's function-call key (env CI_SIGNER_KEY,
// limited on chain to certify/revoke on the contract), it certifies the agent with
// run_ref "run:<run id>@<sha>;judge:<judge hash>" (see judge-hash.ts) — or, if the run earned no level, revokes the CI signer's own certificate,
// so its slot always reflects the latest full CI run.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString, actions } from "near-api-js";
import { type Deploy, TTL_NS, checkDeploy, checkTeeSigners } from "./certify.ts";
import { judgeHash } from "./judge-hash.ts";
import { JUDGE_VERSION } from "./loss.ts";
import { ciReport, reportHash } from "./report.ts";
import { configHash, loadAgent } from "./scenario.ts";
import { RPC, accessKey, view } from "./testnet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE_RE = /^([0-9a-f-]{36}|manifest)\.json$/;
export const RUN_REF_RE = /^run:\d{1,20}@[0-9a-f]{40};judge:[0-9a-f]{40}$/;

/** Only plain JSON files with expected names, no symlinks, bounded size. */
export function checkArtifact(dir: string): void {
  const entries = readdirSync(dir);
  if (entries.length > 500) throw new Error("too many artifact files");
  for (const f of entries) {
    const st = lstatSync(join(dir, f));
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`artifact entry ${f} is not a regular file`);
    if (!FILE_RE.test(f)) throw new Error(`unexpected artifact file ${f}`);
    if (st.size > 2_000_000) throw new Error(`artifact file ${f} is too large`);
  }
}

/** Every earlier run of this workflow except smoke runs on main, so retrying until a pass is visible
 *  next to the certificate. Returns null if the history cannot be read completely. Deleted runs cannot
 *  be listed; a failed full run also leaves its revoke on chain, a cancelled one does not. */
export async function earlierRuns(runId: string, get: (url: string) => Promise<any> = ghGet): Promise<string | null> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  const runs: { id: number; display_title: string; conclusion: string | null; status: string; head_branch: string | null }[] = [];
  let total = Infinity;
  for (let page = 1; runs.length < total && page <= 20; page++) {
    const body = await get(`https://api.github.com/repos/${repo}/actions/workflows/ci-signer.yml/runs?per_page=100&page=${page}`);
    if (!body || !Array.isArray(body.workflow_runs) || typeof body.total_count !== "number") return null;
    total = body.total_count;
    if (body.workflow_runs.length === 0) break;
    runs.push(...body.workflow_runs);
  }
  if (runs.length < total) return null;
  const shown = runs.filter((x) => String(x.id) !== runId && !(x.head_branch === "main" && / smoke$/.test(x.display_title)));
  const clean = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 40);
  return shown.map((x) => `${x.id}:${clean(x.conclusion ?? x.status)}:${clean(x.head_branch)}:${clean(x.display_title.split(" ").pop())}`).join(",") || "none";
}

async function ghGet(url: string): Promise<any> {
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

type CiDeploy = Deploy & { ci_signer: string; ci_signer_fc_public_key: string };

async function main() {
  const [agentName, artifactDir] = process.argv.slice(2);
  if (!agentName || !/^[a-z0-9-]+$/.test(agentName) || !artifactDir) throw new Error("usage: certify-ci.ts <agent> <artifact dir>");
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  if (process.env.GITHUB_RUN_ATTEMPT !== "1") throw new Error("re-run attempts never sign: start a new workflow run instead");
  if (!/^\d{1,20}$/.test(runId) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_RUN_ID / GITHUB_SHA missing or malformed");

  const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8")) as CiDeploy;
  checkDeploy({ ...deploy, runner: deploy.ci_signer, runner_fc_public_key: deploy.ci_signer_fc_public_key });
  const agentAccount = deploy.agents[agentName];
  if (!agentAccount) throw new Error(`deploy/testnet.json has no account for ${agentName}`);

  const dir = resolve(artifactDir, agentName);
  checkArtifact(dir);
  for (const f of readdirSync(artifactDir)) {
    const st = lstatSync(resolve(artifactDir, f));
    if (f === agentName ? !st.isDirectory() || st.isSymbolicLink() : f !== "report.json" || !st.isFile() || st.size > 5_000_000) {
      throw new Error(`unexpected artifact entry ${f}`);
    }
  }
  const agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
  const report = ciReport(ROOT, agentName, dir);
  if (report.ci.run_id !== runId || report.ci.sha !== sha) throw new Error("the artifact belongs to another run or commit");
  if (report.agent_config_hash !== configHash(agent)) throw new Error("agent config differs from this commit");
  const committed = readFileSync(resolve(artifactDir, "report.json"), "utf8");
  if (committed !== `${JSON.stringify(report, null, 2)}\n`) throw new Error("the first job's report differs from the rebuild");
  const rHash = reportHash(report);
  // Nothing below may stop a level-0 run from revoking: only the certify path has extra preconditions.
  let level = report.level;
  let why = "";
  if (level > 0 && report.judge_version !== JUDGE_VERSION) {
    level = 0;
    why = ` reason=judge_v${report.judge_version}_not_v${JUDGE_VERSION}`;
  }
  if (level > 0) {
    try {
      checkTeeSigners(ROOT, report);
    } catch (e) {
      level = 0;
      why = " reason=unpinned_tee_signer";
      console.error((e as Error).message);
    }
  }
  const before = await earlierRuns(runId);
  if (level > 0 && before === null) throw new Error("could not read the complete run history, so nothing is certified");

  const secret = process.env.CI_SIGNER_KEY ?? "";
  const kp = KeyPair.fromString(secret as KeyPairString);
  if (kp.getPublicKey().toString() !== deploy.ci_signer_fc_public_key) throw new Error("CI_SIGNER_KEY is not the configured function-call key");
  const key = await accessKey(deploy.ci_signer, deploy.ci_signer_fc_public_key);
  const fc = key.permission?.FunctionCall;
  // An empty method list means "any method" on NEAR, so it must be non-empty.
  if (!fc || fc.receiver_id !== deploy.contract || !fc.method_names?.length || !fc.method_names.every((m: string) => m === "certify" || m === "revoke")) {
    throw new Error("the CI key on chain is not limited to certify/revoke on the contract");
  }
  const account = new Account(deploy.ci_signer, new JsonRpcProvider({ url: RPC }), secret as KeyPairString);
  const call = async (method: string, args: Record<string, unknown>) => {
    const res: any = await account.signAndSendTransaction({
      receiverId: deploy.contract, actions: [actions.functionCall(method, args, 50_000_000_000_000n, 0n)], waitUntil: "FINAL", throwOnFailure: false,
    });
    const failed = res.receipts_outcome.some((o: any) => o.outcome.status.Failure);
    if (failed || typeof res.status?.SuccessValue !== "string") throw new Error(`${method} failed (tx ${res.transaction.hash})`);
    return res.transaction.hash as string;
  };

  if (level === 0) {
    const existing = await view<unknown>(deploy.contract, "get_cert", { agent: agentAccount, signer: deploy.ci_signer });
    const tx = existing ? await call("revoke", { agent: agentAccount }) : null;
    console.log(`level=0${why} report_hash=${rHash} run=${runId}@${sha} revoke_tx=${tx ?? "none"} earlier_runs=${before ?? "unknown"}`);
    return;
  }
  // Computed only on the certify path, so a git problem can never stop a revoke.
  const runRef = `run:${runId}@${sha};judge:${judgeHash(ROOT, sha)}`;
  if (!RUN_REF_RE.test(runRef)) throw new Error("run_ref malformed");
  const storage = BigInt(await view<string>(deploy.contract, "storage_balance_of", { account_id: deploy.ci_signer }));
  if (storage < 10n ** 22n) throw new Error("CI signer storage balance too low on the contract");
  const tx = await call("certify", {
    agent: agentAccount, level: report.level, suite_version: report.suite_version, suite_hash: report.suite_hash,
    hidden_count: report.hidden_count, report_hash: rHash, config_hash: report.agent_config_hash,
    endpoint_class: report.endpoint_class, run_ref: runRef, ttl_ns: TTL_NS.toString(),
  });
  console.log(`level=${report.level} report_hash=${rHash} run_ref=${runRef} certify_tx=${tx} earlier_runs=${before}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`refused: ${(e as Error).message.replace(/[^\x20-\x7E]/g, "").slice(0, 300)}`);
    process.exit(1);
  });
}
