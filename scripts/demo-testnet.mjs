// Records the demo transactions on testnet: every refusal path of the contract
// plus the happy path, each with its tx hash, signer and actual outcome, into
// demo/txs.json (only when every step matches; otherwise demo/txs.failed.json).
// Signing uses near-cli-rs with keys from ~/.near-credentials; broadcasting goes
// through JSON-RPC so refused calls keep their hash and panic message.
// Usage: node scripts/demo-testnet.mjs [contract-account]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT = process.argv[2] || "clearance-dev.testnet";
const OWNER = "lt-dopusk-owner.testnet";
const AGENT = "lt-dopusk-agent-protected.testnet";
const RUNNER = "lt-dopusk-runner-signer.testnet";
const STRANGER = "lt-dopusk-attacker.testnet";
const SHOP = `shop.${CONTRACT}`;
const RUNNER_FC_KEY = `${homedir()}/.near-credentials/testnet/${RUNNER}/ed25519_DSP22oEJg9jAUXcSdUePsuGek525dskZjqRF8ieuBNaZ.json`;
const RPC = "https://rpc.testnet.fastnear.com";
const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demo");
const NEAR = 10n ** 24n;
const near = (n) => ((BigInt(Math.round(n * 1000)) * NEAR) / 1000n).toString();
const hex = (c) => c.repeat(64);
const TRUE_B64 = Buffer.from("true").toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args) {
  const r = spawnSync("near", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
  // near-cli-rs prints results and errors to stderr; strip any terminal control codes.
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { ok: r.status === 0, out };
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

async function view(method, args) {
  const j = await rpc("query", { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (!j.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(j.error ?? j.result)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

async function accountExists(id) {
  const j = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
  return Boolean(j.result);
}

// Signs with near-cli (`display`), broadcasts asynchronously, then polls the
// final outcome. Retries signing on a stale nonce (near-cli and this RPC may lag).
async function call(who, method, args, deposit = "0 NEAR", key = null) {
  const sign = key ? ["sign-with-access-key-file", key] : ["sign-with-legacy-keychain"];
  // Keys sorted, as near-cli serializes them on chain, so args compare byte for byte.
  const base = { signer: who, method, args: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))), deposit };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = cli(["contract", "call-function", "as-transaction", CONTRACT, method, "json-args", JSON.stringify(args),
      "prepaid-gas", "50.0 Tgas", "attached-deposit", deposit, "sign-as", who, "network-config", "testnet", ...sign, "display"]);
    const signed = (r.out.match(/\bSigned transaction \(serialized as base64\):\s*\n\s*([A-Za-z0-9+/=]+)\s*\n/) || [])[1];
    if (!signed) {
      const last = r.out.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      return { ...base, tx: null, ok: false, actual: `could not sign (exit ${r.ok ? 0 : 1}): ${last}` };
    }
    const sent = await rpc("broadcast_tx_async", [signed]);
    if (sent.error) {
      const msg = JSON.stringify(sent.error.cause ?? sent.error.data ?? sent.error);
      if (/InvalidNonce/.test(msg) && attempt < 2) { await sleep(2000); continue; }
      return { ...base, tx: null, ok: false, actual: `refused by node: ${msg.slice(0, 200)}` };
    }
    const hash = sent.result;
    for (let i = 0; i < 30; i++) {
      const j = await rpc("tx", { tx_hash: hash, sender_account_id: who, wait_until: "FINAL" });
      if (j.result?.status) return { ...base, tx: hash, ...judge(j.result) };
      const msg = JSON.stringify(j.error ?? "");
      if (/InvalidNonce/.test(msg) && attempt < 2) break;
      await sleep(2000); // UNKNOWN_TRANSACTION or TIMEOUT_ERROR: not final yet
    }
    if (attempt === 2) return { ...base, tx: hash, ok: false, actual: "no final outcome after 60s" };
  }
  return { ...base, tx: null, ok: false, actual: "stale nonce after 3 attempts" };
}

function judge(result) {
  const text = JSON.stringify(result);
  const panic = (text.match(/Smart contract panicked: ([^"\\]+)/) || [])[1] ?? null;
  const receiptFailed = result.receipts_outcome.some((o) => o.outcome.status.Failure);
  const value = result.status.SuccessValue;
  const ok = typeof value === "string" && !panic && !receiptFailed;
  const decoded = typeof value === "string" && value ? JSON.parse(Buffer.from(value, "base64").toString()) : null;
  return {
    ok, value, decoded,
    actual: panic ?? (ok ? "success" : `failure: ${JSON.stringify(result.status).slice(0, 200)}`),
    public_key: result.transaction.public_key,
    block_hash: result.transaction_outcome.block_hash,
    receipt_ids: result.receipts_outcome.map((o) => o.id),
    logs: result.receipts_outcome.flatMap((o) => o.outcome.logs),
  };
}

const steps = [];
// expect: "success" | "landed" (spend/withdraw whose transfer arrived) | "failure" (with required panic text).
function step(name, expect, res, error = null) {
  if (expect === "failure" && !error) throw new Error(`failure step "${name}" needs an expected error`);
  const pass = res.tx !== null && (
    expect === "failure" ? !res.ok && res.actual.includes(error)
      : expect === "landed" ? res.ok && res.value === TRUE_B64
        : res.ok);
  steps.push({ step: name, signer: res.signer, public_key: res.public_key ?? null, method: res.method, args: res.args,
    deposit: res.deposit, tx: res.tx, block_hash: res.block_hash ?? null, expect, ...(error ? { error } : {}), actual: res.actual,
    return_value: res.decoded ?? null, receipt_ids: res.receipt_ids ?? [], logs: res.logs ?? [], pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${res.tx ?? "(no tx)"}  [${res.actual}]`);
  return res;
}

// What produced these results: the code on chain, the commit it was built from,
// and the runner's access keys (its function-call key must be limited to certify/revoke).
const codeHash = (await rpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT })).result.code_hash;
const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain", "contract/"], { encoding: "utf8" }).stdout.trim() !== "";
const runnerKeys = (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: RUNNER })).result.keys
  .map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));

// Setup: a merchant account must exist, otherwise "pays the shop" would be refunded.
if (!(await accountExists(SHOP))) {
  cli(["account", "create-account", "fund-myself", SHOP, "0.1 NEAR", "autogenerate-new-keypair", "save-to-legacy-keychain",
    "sign-as", CONTRACT, "network-config", "testnet", "sign-with-legacy-keychain", "send"]);
  await sleep(3000);
  if (!(await accountExists(SHOP))) throw new Error(`could not create ${SHOP}`);
}
step("owner prepays storage for the runner", "success", await call(OWNER, "storage_deposit", { account_id: RUNNER }, "0.05 NEAR"));
step("stranger prepays its own storage", "success", await call(STRANGER, "storage_deposit", {}, "0.05 NEAR"));
const created = step("owner creates a vault: cap 5 NEAR, receiver shop, trusts only the runner", "success",
  await call(OWNER, "create_vault", { agent: AGENT, owner_cap: near(5), receivers: [SHOP], trusted_signers: [RUNNER], policy: "All",
    min_suite_version: 1, min_hidden: 0, allow_foreign_endpoint: false }, "2.5 NEAR"));
if (!created.ok) throw new Error("vault creation failed; aborting");
const vaultId = JSON.parse(Buffer.from(created.value, "base64").toString());
const vault = await view("get_vault", { vault_id: vaultId });
if (vault?.owner !== OWNER || vault?.agent !== AGENT) throw new Error(`vault ${vaultId} is not ours`);

const cert = (level) => ({ agent: AGENT, level, suite_version: 1, suite_hash: hex("a"), hidden_count: 0, report_hash: hex("b"),
  config_hash: hex("c"), endpoint_class: "Attested", run_ref: "dev-demo", ttl_ns: String(7 * 86_400 * 1e9) });
const spend = (to, n) => call(AGENT, "spend", { vault_id: vaultId, receiver: to, amount: near(n) });

step("untrusted signer issues a certificate", "success", await call(STRANGER, "certify", cert(2)));
step("spend with only an untrusted certificate", "failure", await spend(SHOP, 1), "no valid certificate");
step("agent certifies itself", "failure", await call(AGENT, "certify", cert(2)), "agent cannot certify itself");
step("runner certifies level 2 with its function-call key", "success", await call(RUNNER, "certify", cert(2), "0 NEAR", RUNNER_FC_KEY));
step("protected agent pays the shop 2 NEAR", "landed", await spend(SHOP, 2));
step("6 NEAR more exceeds min(owner 5, level 10)", "failure", await spend(SHOP, 6), "over window cap");
step("payment to an account outside the receiver list", "failure", await spend(STRANGER, 0.5), "receiver not allowed");
step("runner revokes with its function-call key", "success", await call(RUNNER, "revoke", { agent: AGENT }, "0 NEAR", RUNNER_FC_KEY));
step("spend after revoke", "failure", await spend(SHOP, 0.1), "no valid certificate");
step("owner withdraws 0.3 NEAR", "landed", await call(OWNER, "withdraw", { vault_id: vaultId, amount: near(0.3) }, "1 yoctoNEAR"));

const failed = steps.filter((s) => !s.pass).length;
mkdirSync(DEMO_DIR, { recursive: true });
const file = join(DEMO_DIR, failed ? "txs.failed.json" : "txs.json");
const header = { network: "testnet", contract: CONTRACT, code_hash: codeHash, commit, contract_dir_dirty: dirty,
  recorded_at: new Date().toISOString(), vault_id: vaultId, runner_access_keys: runnerKeys,
  note: "Statuses older than a few days need an archival RPC node (e.g. archival-rpc.testnet.fastnear.com)." };
writeFileSync(file, `${JSON.stringify({ ...header, steps }, null, 2)}\n`);
console.log(failed ? `${failed} step(s) did not match; wrote ${file}` : `all steps matched; wrote ${file}`);
process.exit(failed ? 1 : 0);
