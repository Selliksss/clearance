// Usage (GitHub Actions, sign job): tsx src/certify-ci.ts <agent> <artifact dir>
// The second job of the CI signer. It executes nothing from the first job's artifact: it parses the
// transcripts and manifest, rebuilds the CI report with the code of this commit, and checks it equals
// the report the first job wrote. Then, with the CI signer's function-call key (env CI_SIGNER_KEY,
// limited on chain to certify/revoke on the contract), it certifies the agent with
// run_ref "run:<run id>@<sha>" — or, if the run earned no level, revokes the CI signer's own certificate,
// so its slot always reflects the latest full CI run.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString, actions } from "near-api-js";
import { type Deploy, TTL_NS, checkDeploy } from "./certify.ts";
import { ciReport, reportHash } from "./report.ts";
import { configHash, loadAgent } from "./scenario.ts";
import { RPC, accessKey, view } from "./testnet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE_RE = /^([0-9a-f-]{36}|manifest)\.json$/;
export const RUN_REF_RE = /^run:\d{1,20}@[0-9a-f]{40}$/;

/** Only plain JSON files with expected names, no symlinks, bounded size. */
export function checkArtifact(dir: string): void {
  for (const f of readdirSync(dir)) {
    const st = lstatSync(join(dir, f));
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`artifact entry ${f} is not a regular file`);
    if (!FILE_RE.test(f)) throw new Error(`unexpected artifact file ${f}`);
    if (st.size > 2_000_000) throw new Error(`artifact file ${f} is too large`);
  }
}

type CiDeploy = Deploy & { ci_signer: string; ci_signer_fc_public_key: string };

async function main() {
  const [agentName, artifactDir] = process.argv.slice(2);
  if (!agentName || !/^[a-z0-9-]+$/.test(agentName) || !artifactDir) throw new Error("usage: certify-ci.ts <agent> <artifact dir>");
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  if (process.env.GITHUB_RUN_ATTEMPT !== "1") throw new Error("re-run attempts never sign: start a new workflow run instead");
  const runRef = `run:${runId}@${sha}`;
  if (!RUN_REF_RE.test(runRef)) throw new Error("GITHUB_RUN_ID / GITHUB_SHA missing or malformed");

  const deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8")) as CiDeploy;
  checkDeploy({ ...deploy, runner: deploy.ci_signer, runner_fc_public_key: deploy.ci_signer_fc_public_key });
  const agentAccount = deploy.agents[agentName];
  if (!agentAccount) throw new Error(`deploy/testnet.json has no account for ${agentName}`);

  const dir = resolve(artifactDir, agentName);
  checkArtifact(dir);
  const agent = loadAgent(join(ROOT, "agents", `${agentName}.json`));
  const report = ciReport(ROOT, agentName, dir);
  if (report.ci.run_id !== runId || report.ci.sha !== sha) throw new Error("the artifact belongs to another run or commit");
  if (report.agent_config_hash !== configHash(agent)) throw new Error("agent config differs from this commit");
  const committed = readFileSync(resolve(artifactDir, "report.json"), "utf8");
  if (committed !== `${JSON.stringify(report, null, 2)}\n`) throw new Error("the first job's report differs from the rebuild");
  const rHash = reportHash(report);

  const secret = process.env.CI_SIGNER_KEY ?? "";
  const kp = KeyPair.fromString(secret as KeyPairString);
  if (kp.getPublicKey().toString() !== deploy.ci_signer_fc_public_key) throw new Error("CI_SIGNER_KEY is not the configured function-call key");
  const key = await accessKey(deploy.ci_signer, deploy.ci_signer_fc_public_key);
  const fc = key.permission?.FunctionCall;
  if (!fc || fc.receiver_id !== deploy.contract || !fc.method_names.every((m: string) => m === "certify" || m === "revoke")) {
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

  if (report.level === 0) {
    const existing = await view<unknown>(deploy.contract, "get_cert", { agent: agentAccount, signer: deploy.ci_signer });
    const tx = existing ? await call("revoke", { agent: agentAccount }) : null;
    console.log(`level=0 report_hash=${rHash} run_ref=${runRef} revoke_tx=${tx ?? "none"}`);
    return;
  }
  const tx = await call("certify", {
    agent: agentAccount, level: report.level, suite_version: report.suite_version, suite_hash: report.suite_hash,
    hidden_count: report.hidden_count, report_hash: rHash, config_hash: report.agent_config_hash,
    endpoint_class: report.endpoint_class, run_ref: runRef, ttl_ns: TTL_NS.toString(),
  });
  console.log(`level=${report.level} report_hash=${rHash} run_ref=${runRef} certify_tx=${tx}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`refused: ${(e as Error).message.replace(/[^\x20-\x7E]/g, "").slice(0, 300)}`);
    process.exit(1);
  });
}
