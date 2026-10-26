// Usage: tsx src/certify.ts <agent> [--force]
// Issues the agent's certificate on the dev contract from its committed report,
// signed by the runner's function-call key (certify/revoke only). Refuses unless
// the tree is clean, the committed report equals a rebuild, the level is 1 or 2
// with enough runs, and the contract on testnet runs the same code as the runs.
// Idempotent: a live certificate with the same level and hashes is left alone.
// The tx is appended to reports/<agent>.certs.json (kept out of the report so
// report_hash does not depend on it).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, reportHash } from "./report.ts";
import { accessKey, callWithKeyFile, codeHash, view } from "./testnet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The contract's maximum (30 days), so a certificate issued before submission outlives judging. */
export const TTL_NS = 30n * 86_400n * 1_000_000_000n;

export type Deploy = { network: "testnet"; contract: string; runner: string; runner_fc_public_key: string; agents: Record<string, string> };
export type CertifyArgs = {
  agent: string; level: number; suite_version: number; suite_hash: string; hidden_count: number;
  report_hash: string; config_hash: string; endpoint_class: string; run_ref: string; ttl_ns: string;
};
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ED25519_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/;
const CERT_METHODS = new Set(["certify", "revoke"]);

export function checkDeploy(d: Deploy): void {
  for (const [k, v] of [["contract", d.contract], ["runner", d.runner], ...Object.entries(d.agents)]) {
    if (typeof v !== "string" || !ACCOUNT_RE.test(v) || v.length > 64) throw new Error(`deploy/testnet.json: ${k} is not a NEAR account id`);
  }
  if (!ED25519_RE.test(d.runner_fc_public_key)) throw new Error("deploy/testnet.json: runner_fc_public_key is not an ed25519 key");
}

/** The signing key file must be the runner's function-call key for this contract, limited to certify/revoke. */
export async function fcKeyFile(d: Deploy): Promise<string> {
  const dir = resolve(homedir(), ".near-credentials", "testnet", d.runner);
  const file = resolve(dir, `${d.runner_fc_public_key.replace("ed25519:", "ed25519_")}.json`);
  if (!file.startsWith(dir + sep)) throw new Error("key file path escapes ~/.near-credentials");
  const content = JSON.parse(readFileSync(file, "utf8"));
  if (content.public_key !== d.runner_fc_public_key) throw new Error("key file does not hold the configured public key");
  const key = await accessKey(d.runner, d.runner_fc_public_key);
  const fc = key.permission?.FunctionCall;
  if (!fc || fc.receiver_id !== d.contract || !fc.method_names?.length || !fc.method_names.every((m: string) => CERT_METHODS.has(m))) {
    throw new Error("the configured key is not a function-call key limited to certify/revoke on the contract");
  }
  return file;
}

type OnChainCert = { level: number; suite_hash: string; report_hash: string; config_hash: string; endpoint_class: string; expires_ns: string } | null;

export function buildCertifyArgs(report: ReturnType<typeof buildReport>, agentAccount: string, commit: string): CertifyArgs {
  if (report.level === 0 || report.insufficient.length) throw new Error(`level ${report.level}${report.insufficient.length ? ` (insufficient: ${report.insufficient.join(", ")})` : ""}: no certificate`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a 40-hex git sha");
  return {
    agent: agentAccount,
    level: report.level,
    suite_version: report.suite_version,
    suite_hash: report.suite_hash,
    hidden_count: report.hidden_count,
    report_hash: reportHash(report),
    config_hash: report.agent_config_hash,
    endpoint_class: report.endpoint_class,
    run_ref: `local@${commit}`,
    ttl_ns: TTL_NS.toString(),
  };
}

/** "noop" if the live certificate already says the same thing and is not about to expire. */
export function needsCertify(existing: OnChainCert, args: CertifyArgs, nowNs: bigint): "issue" | "noop" {
  if (!existing) return "issue";
  const same = existing.level === args.level && existing.report_hash === args.report_hash
    && existing.suite_hash === args.suite_hash && existing.config_hash === args.config_hash && existing.endpoint_class === args.endpoint_class;
  const freshEnough = BigInt(existing.expires_ns) > nowNs + 86_400n * 1_000_000_000n;
  return same && freshEnough ? "noop" : "issue";
}

async function main() {
  const agentName = process.argv[2];
  if (!agentName || !/^[a-z0-9-]+$/.test(agentName)) throw new Error("usage: certify.ts <agent> [--force]");
  const force = process.argv.includes("--force");
  const deploy: Deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8"));
  checkDeploy(deploy);
  const agentAccount = deploy.agents[agentName];
  if (!agentAccount) throw new Error(`deploy/testnet.json has no account for agent ${agentName}`);

  const inputs = ["runner/src", "runner/package.json", "runner/package-lock.json", "agents", "attacks", "scenarios", "suites", "transcripts", "reports", "deploy", "demo", "contract/src"];
  const state = () => ({
    dirty: spawnSync("git", ["-C", ROOT, "status", "--porcelain", ...inputs], { encoding: "utf8" }).stdout.trim(),
    commit: spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  });
  const before = state();
  if (before.dirty) throw new Error("uncommitted changes: commit the transcripts and report first");
  const commit = before.commit;

  const report = buildReport(ROOT, agentName);
  const committed = readFileSync(join(ROOT, "reports", `${agentName}.json`), "utf8");
  if (committed !== `${JSON.stringify(report, null, 2)}\n`) throw new Error(`reports/${agentName}.json is stale; run make report AGENT=${agentName}`);
  const args = buildCertifyArgs(report, agentAccount, commit);

  const recorded = JSON.parse(readFileSync(join(ROOT, "demo", "txs.json"), "utf8")).code_hash;
  const onChain = await codeHash(deploy.contract);
  if (onChain !== recorded) throw new Error(`${deploy.contract} runs code ${onChain}, the runs were made against ${recorded}`);

  const storage = BigInt(await view<string>(deploy.contract, "storage_balance_of", { account_id: deploy.runner }));
  if (storage < 10n ** 22n) {
    throw new Error(`runner storage balance too low; the owner can top it up:\n  near contract call-function as-transaction ${deploy.contract} storage_deposit json-args '{"account_id":"${deploy.runner}"}' prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' sign-as <owner> network-config testnet sign-with-legacy-keychain send`);
  }

  const existing = await view<OnChainCert>(deploy.contract, "get_cert", { agent: agentAccount, signer: deploy.runner });
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  if (!force && needsCertify(existing, args, nowNs) === "noop") {
    console.log(`noop: ${agentAccount} already holds level ${args.level} with report_hash ${args.report_hash}`);
    return;
  }

  const keyFile = await fcKeyFile(deploy);
  const ledger = join(ROOT, "reports", `${agentName}.certs.json`);
  const entries = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
  const now = state();
  if (now.dirty || now.commit !== commit) throw new Error("the repository changed while preparing the certificate");
  const tx = await callWithKeyFile(deploy.contract, deploy.runner, keyFile, "certify", args);
  if (!tx.ok) throw new Error(`certify failed: ${tx.panic} (tx ${tx.hash})`);
  if (tx.publicKey !== deploy.runner_fc_public_key) throw new Error(`signed with ${tx.publicKey}, expected the function-call key`);
  const event = tx.logs.find((l) => l.startsWith("EVENT_JSON:") && l.includes('"certify"'));
  if (!event || !event.includes(args.report_hash)) throw new Error("certify event missing or without the report hash");
  const after = await view<OnChainCert>(deploy.contract, "get_cert", { agent: agentAccount, signer: deploy.runner });
  if (!after || after.report_hash !== args.report_hash || after.level !== args.level) throw new Error("get_cert does not show the new certificate");

  // Self-reported convenience record; the evidence is the transaction on chain.
  entries.push({ tx: tx.hash, block_hash: tx.blockHash, contract: deploy.contract, signer: deploy.runner, public_key: tx.publicKey, args, expires_ns: after.expires_ns, commit });
  writeFileSync(`${ledger}.tmp`, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(`${ledger}.tmp`, ledger);
  console.log(`certified ${agentAccount}: level ${args.level} (${args.endpoint_class}), report_hash ${args.report_hash}\n  tx https://testnet.nearblocks.io/txns/${tx.hash}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`refused: ${(e as Error).message}`);
    process.exit(1);
  });
}
