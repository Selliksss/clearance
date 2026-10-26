// Usage: tsx src/policy.ts <agent> --receivers a.testnet,b.testnet
// Exports an OutLayer Agent Custody policy sized by the agent's certified level.
// The policy is plain JSON for the owner to apply with their own OutLayer
// credentials (encrypt-policy -> sign-policy -> store_wallet_policy); the runner
// never sees the encrypted policy. Refuses unless a live certificate on testnet
// matches the committed report. The link to the certificate goes in a separate
// file, because OutLayer's encrypt-policy may reject unknown fields.
//
//   level 1: <= 1 NEAR per transaction, <= 3 NEAR per day
//   level 2: <= 3 NEAR per transaction, <= 10 NEAR per day
// per_transaction is enforced exactly inside OutLayer's TEE; daily limits are
// best-effort under concurrency (their docs), so per_transaction is the hard stop.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import AjvModule from "ajv";
import { NEAR } from "./chain.ts";
import type { Deploy } from "./certify.ts";
import { buildReport, reportHash } from "./report.ts";
import { createHash } from "node:crypto";
import { checkDeploy } from "./certify.ts";
import { viewTwice } from "./testnet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_FILE = "policies/outlayer-policy-schema.0.1.0-alpha.4.json";
/** sha256 of the pinned schema file as reviewed; a changed file is refused. */
export const SCHEMA_SHA256 = "029e8bc37fffe818d4692ec253886d3056d0ef28dd25a5ab172d2c78fdaf7381";
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const LIMITS: Record<1 | 2, { per_transaction: bigint; daily: bigint }> = {
  1: { per_transaction: 1n * NEAR, daily: 3n * NEAR },
  2: { per_transaction: 3n * NEAR, daily: 10n * NEAR },
};

export function buildPolicy(level: 1 | 2, receivers: string[], agentAccount: string) {
  if (receivers.length < 1 || receivers.length > 10) throw new Error("1 to 10 receivers");
  if (new Set(receivers).size !== receivers.length) throw new Error("duplicate receiver");
  for (const r of receivers) {
    if (!ACCOUNT_RE.test(r) || r.length > 64) throw new Error(`${r} is not a NEAR account id`);
    if (r === agentAccount) throw new Error("the agent cannot be its own receiver");
  }
  const l = LIMITS[level];
  const deny = { allowed: false };
  // "native" is the token key OutLayer's own dashboard writes for NEAR (seen on our test wallet).
  // allowed_tokens is set explicitly: omitting it means "all tokens" in their schema.
  const maxTx = Number((l.daily + l.per_transaction - 1n) / l.per_transaction);
  return {
    rules: {
      transaction_types: ["transfer"],
      allowed_tokens: ["native"],
      addresses: { mode: "whitelist", list: [...receivers].sort() },
      limits: {
        per_transaction: { native: l.per_transaction.toString() },
        hourly: { native: l.daily.toString() },
        daily: { native: l.daily.toString() },
        hourly_tx_count: maxTx,
      },
      rate_limit: { max_per_hour: maxTx },
    },
    // Every primitive the agent does not need is denied explicitly; sign_message is
    // default-allow in OutLayer, so it is switched off too.
    capabilities: {
      raw_sign: deny, confidential: deny, swap: deny, cross_chain_withdraw: deny, limit_order: deny,
      payment_check: deny, sign_message: deny, evm_sign: deny, solana_sign: deny,
    },
  };
}

/** Validates a policy against the pinned OutLayer schemas (PolicyRules + Capabilities). */
export function validatePolicy(policy: ReturnType<typeof buildPolicy>, schemaPath = join(ROOT, SCHEMA_FILE)): string[] {
  const bytes = readFileSync(schemaPath);
  if (createHash("sha256").update(bytes).digest("hex") !== SCHEMA_SHA256) return ["pinned OutLayer schema file changed"];
  const pinned = JSON.parse(bytes.toString());
  // ajv ships CommonJS; under nodenext the default import is the module namespace.
  const Ajv = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
  const ajv = new (Ajv as unknown as new (o: object) => import("ajv").default)({ strict: false, allErrors: true });
  const defs = Object.fromEntries(Object.entries(pinned.schemas).map(([k, v]) => [k, v]));
  const wrap = (name: string) => ({ $id: `ol:${name}`, components: { schemas: defs }, $ref: `#/components/schemas/${name}` });
  const errors: string[] = [];
  for (const [name, value] of [["PolicyRules", policy.rules], ["Capabilities", policy.capabilities]] as const) {
    const validate = ajv.compile(wrap(name));
    if (!validate(value)) errors.push(...(validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${name}${e.instancePath}: ${e.message}`));
  }
  // Their schema allows unknown keys in places; ours must only use keys their schema names.
  for (const k of Object.keys(policy.capabilities)) if (!(k in pinned.schemas.Capabilities.properties)) errors.push(`unknown capability ${k}`);
  for (const k of Object.keys(policy.rules)) if (!(k in pinned.schemas.PolicyRules.properties)) errors.push(`unknown rule ${k}`);
  for (const k of Object.keys(policy.rules.limits)) if (!(k in pinned.schemas.PolicyLimits.properties)) errors.push(`unknown limit ${k}`);
  // Shape is not safety: assert the fields that make the policy restrictive.
  const r = policy.rules;
  if (r.addresses.mode !== "whitelist") errors.push("addresses must be a whitelist");
  if (JSON.stringify(r.transaction_types) !== JSON.stringify(["transfer"])) errors.push("only transfer may be allowed");
  if (JSON.stringify(r.allowed_tokens) !== JSON.stringify(["native"])) errors.push("only native NEAR may be allowed");
  if (!Object.values(policy.capabilities).every((c) => c.allowed === false)) errors.push("every capability must be denied");
  const per = BigInt(r.limits.per_transaction.native);
  if (per > LIMITS[2].per_transaction || BigInt(r.limits.daily.native) > LIMITS[2].daily) errors.push("limits above level 2");
  return errors;
}

type OnChainCert = { level: number; report_hash: string; config_hash: string; suite_hash: string; expires_ns: string } | null;

/** The level a policy may use: the certificate's, and only if it is live and matches the report. */
export function policyLevel(report: { level: number; agent_config_hash: string; suite_hash: string }, rHash: string, cert: OnChainCert, nowNs: bigint): 1 | 2 {
  if (!cert) throw new Error("no certificate on testnet: run make certify first");
  if (BigInt(cert.expires_ns) <= nowNs) throw new Error("the certificate has expired");
  if (cert.report_hash !== rHash || cert.config_hash !== report.agent_config_hash || cert.suite_hash !== report.suite_hash) {
    throw new Error("the certificate on testnet does not match the committed report");
  }
  const level = Math.min(cert.level, report.level);
  if (level !== 1 && level !== 2) throw new Error(`level ${level}: no policy`);
  return level;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { receivers: { type: "string" } } });
  const agentName = positionals[0];
  if (!agentName || !/^[a-z0-9-]+$/.test(agentName) || !values.receivers) throw new Error("usage: policy.ts <agent> --receivers a.testnet,b.testnet");
  const deploy: Deploy = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8"));
  checkDeploy(deploy);
  const agentAccount = deploy.agents[agentName];
  if (!agentAccount) throw new Error(`deploy/testnet.json has no account for agent ${agentName}`);
  const report = buildReport(ROOT, agentName);
  const rHash = reportHash(report);
  // Two independent RPC providers must agree; no cached fallback. If testnet cannot be read, no policy.
  const cert = await viewTwice<OnChainCert>(deploy.contract, "get_cert", { agent: agentAccount, signer: deploy.runner });
  const level = policyLevel(report, rHash, cert, BigInt(Date.now()) * 1_000_000n);
  const policy = buildPolicy(level, values.receivers.split(",").map((s) => s.trim()), agentAccount);
  const errors = validatePolicy(policy);
  if (errors.length) throw new Error(`policy does not match OutLayer's schema:\n  ${errors.join("\n  ")}`);
  mkdirSync(join(ROOT, "policies"), { recursive: true });
  writeFileSync(join(ROOT, "policies", `${agentName}.outlayer.json`), `${JSON.stringify(policy, null, 2)}\n`);
  const link = { agent: agentAccount, level, agent_config_hash: report.agent_config_hash, report_hash: rHash, suite_hash: report.suite_hash,
    certificate: { contract: deploy.contract, signer: deploy.runner, expires_ns: cert!.expires_ns } };
  writeFileSync(join(ROOT, "policies", `${agentName}.clearance.json`), `${JSON.stringify(link, null, 2)}\n`);
  console.log(`policies/${agentName}.outlayer.json: level ${level}, per transaction ${level === 2 ? 3 : 1} NEAR, daily ${level === 2 ? 10 : 3} NEAR, ${policy.rules.addresses.list.length} receiver(s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`refused: ${(e as Error).message}`);
    process.exit(1);
  });
}
