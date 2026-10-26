// Records the demo transactions on testnet: every refusal path of the contract
// plus the happy path, each with its tx hash and expected outcome, into
// demo/txs.json. Uses near-cli-rs with keys from ~/.near-credentials.
// Usage: node scripts/demo-testnet.mjs <contract-account>
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CONTRACT = process.argv[2] || "clearance-dev.testnet";
const OWNER = "lt-dopusk-owner.testnet";
const AGENT = "lt-dopusk-agent-protected.testnet";
const RUNNER = "lt-dopusk-runner-signer.testnet";
const STRANGER = "lt-dopusk-attacker.testnet";
const SHOP = `shop.${CONTRACT}`;
const RUNNER_FC_KEY = `${homedir()}/.near-credentials/testnet/${RUNNER}/ed25519_DSP22oEJg9jAUXcSdUePsuGek525dskZjqRF8ieuBNaZ.json`;
const NEAR = 10n ** 24n;
const near = (n) => ((BigInt(Math.round(n * 1000)) * NEAR) / 1000n).toString();
const hex = (c) => c.repeat(64);

// near-cli-rs prints the transaction id and errors to stderr, so read both.
function cli(args) {
  const r = spawnSync("near", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

async function view(method, args) {
  const r = await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final",
      account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
  const j = await r.json();
  if (!j.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(j.error ?? j.result)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

const RPC = "https://rpc.testnet.fastnear.com";

// near-cli-rs signs (`display`), we broadcast: the RPC returns the tx hash and
// the panic message even when the call fails, which near-cli does not print.
async function call(who, method, args, deposit = "0 NEAR", key = null) {
  const sign = key ? ["sign-with-access-key-file", key] : ["sign-with-legacy-keychain"];
  const r = cli(["contract", "call-function", "as-transaction", CONTRACT, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "50.0 Tgas", "attached-deposit", deposit, "sign-as", who, "network-config", "testnet", ...sign, "display"]);
  const signed = (r.out.replace(/\x1b\[[0-9;]*m/g, "").match(/serialized as base64\):\s*\n(\S+)/) || [])[1];
  if (!signed) return { tx: null, ok: false, error: "could not sign" };
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: { signed_tx_base64: signed, wait_until: "FINAL" } }) });
  const j = await res.json();
  if (j.error) return { tx: null, ok: false, error: JSON.stringify(j.error.cause ?? j.error).slice(0, 200) };
  const text = JSON.stringify(j.result);
  const panic = (text.match(/Smart contract panicked: ([^"\\]+)/) || [])[1] ?? null;
  return { tx: j.result.transaction.hash, ok: !j.result.status.Failure && !panic, error: panic };
}

const steps = [];
function step(name, expect, res, error = null) {
  const pass = expect === "success" ? res.ok : !res.ok && (!error || (res.error ?? "").includes(error));
  const recorded = pass && res.tx !== null;
  steps.push({ step: name, tx: res.tx, expect, ...(error ? { error } : {}), pass: recorded });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${res.tx ?? "(no tx)"}${res.error ? `  [${res.error}]` : ""}`);
}

// Setup: a merchant account, prepaid storage for both signers, the vault.
cli(["account", "create-account", "fund-myself", SHOP, "0.1 NEAR", "autogenerate-new-keypair", "save-to-legacy-keychain",
  "sign-as", CONTRACT, "network-config", "testnet", "sign-with-legacy-keychain", "send"]);
step("owner prepays storage for the runner", "success", await call(OWNER, "storage_deposit", { account_id: RUNNER }, "0.05 NEAR"));
step("stranger prepays its own storage", "success", await call(STRANGER, "storage_deposit", {}, "0.05 NEAR"));
const vaultId = (await view("get_config", {})).next_vault_id;
step("owner creates a vault: cap 5 NEAR, receiver shop, trusts only the runner", "success",
  await call(OWNER, "create_vault", { agent: AGENT, owner_cap: near(5), receivers: [SHOP], trusted_signers: [RUNNER], policy: "All",
    min_suite_version: 1, min_hidden: 0, allow_foreign_endpoint: false }, "2.5 NEAR"));

const cert = (level) => ({ agent: AGENT, level, suite_version: 1, suite_hash: hex("a"), hidden_count: 0, report_hash: hex("b"),
  config_hash: hex("c"), endpoint_class: "Attested", run_ref: "dev-demo", ttl_ns: String(7 * 86_400 * 1e9) });
const spend = (to, n) => call(AGENT, "spend", { vault_id: vaultId, receiver: to, amount: near(n) });

step("untrusted signer issues a certificate", "success", await call(STRANGER, "certify", cert(2)));
step("spend with only an untrusted certificate", "failure", await spend(SHOP, 1), "no valid certificate");
step("agent certifies itself", "failure", await call(AGENT, "certify", cert(2)), "agent cannot certify itself");
step("runner certifies level 2 with its function-call key", "success", await call(RUNNER, "certify", cert(2), "0 NEAR", RUNNER_FC_KEY));
step("protected agent pays the shop 2 NEAR", "success", await spend(SHOP, 2));
step("6 NEAR more exceeds min(owner 5, level 10)", "failure", await spend(SHOP, 6), "over window cap");
step("payment to an account outside the receiver list", "failure", await spend(STRANGER, 0.5), "receiver not allowed");
step("runner revokes with its function-call key", "success", await call(RUNNER, "revoke", { agent: AGENT }, "0 NEAR", RUNNER_FC_KEY));
step("spend after revoke", "failure", await spend(SHOP, 0.1), "no valid certificate");
step("owner withdraws 0.3 NEAR", "success", await call(OWNER, "withdraw", { vault_id: vaultId, amount: near(0.3) }, "1 yoctoNEAR"));

mkdirSync("demo", { recursive: true });
writeFileSync("demo/txs.json", `${JSON.stringify({ network: "testnet", contract: CONTRACT, vault_id: vaultId, steps }, null, 2)}\n`);
const failed = steps.filter((s) => !s.pass).length;
console.log(failed ? `${failed} step(s) did not match` : "all steps matched");
process.exit(failed ? 1 : 0);
