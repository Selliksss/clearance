// Talking to NEAR testnet from the runner: read-only RPC views, and transactions
// signed by near-cli-rs (`display`, keys from ~/.near-credentials) then broadcast
// through JSON-RPC so a refused call still yields its hash and panic message.
import { spawnSync } from "node:child_process";

export const RPC = "https://rpc.testnet.fastnear.com";
/** A second, independent provider for reads that grant something (policy export). */
export const RPC_SECOND = "https://rpc.testnet.near.org";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rpc(method: string, params: unknown, url = RPC): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  return r.json();
}

export async function view<T>(contract: string, method: string, args: Record<string, unknown>, url = RPC): Promise<T> {
  const j = await rpc("query", {
    request_type: "call_function", finality: "final", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  }, url);
  if (!j.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(j.error ?? j.result).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString()) as T;
}

/** The same view from two independent RPC providers; refuses if they disagree. */
export async function viewTwice<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T> {
  const [a, b] = await Promise.all([view<T>(contract, method, args, RPC), view<T>(contract, method, args, RPC_SECOND)]);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`RPC providers disagree on ${method}`);
  return a;
}

export async function accessKey(account: string, publicKey: string): Promise<any> {
  const j = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
  if (!j.result) throw new Error(`no access key ${publicKey} on ${account}`);
  return j.result;
}

export async function codeHash(account: string): Promise<string> {
  const j = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
  if (!j.result) throw new Error(`view_account ${account} failed`);
  return j.result.code_hash;
}

export type SentTx = { hash: string; ok: boolean; panic: string | null; publicKey: string; logs: string[]; blockHash: string };

/** Signs a function call with near-cli (a specific access-key file) and broadcasts it. */
export async function callWithKeyFile(contract: string, signer: string, keyFile: string, method: string, args: Record<string, unknown>): Promise<SentTx> {
  const r = spawnSync("near", [
    "contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "50.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", signer, "network-config", "testnet",
    "sign-with-access-key-file", keyFile, "display",
  ], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" } });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const signed = (out.match(/\bSigned transaction \(serialized as base64\):\s*\n\s*([A-Za-z0-9+/=]+)\s*\n/) || [])[1];
  if (!signed) throw new Error(`near-cli could not sign: ${out.trim().split("\n").slice(-2).join(" | ")}`);
  const sent = await rpc("broadcast_tx_async", [signed]);
  if (sent.error) throw new Error(`refused by node: ${JSON.stringify(sent.error.cause ?? sent.error).slice(0, 200)}`);
  for (let i = 0; i < 30; i++) {
    const j = await rpc("tx", { tx_hash: sent.result, sender_account_id: signer, wait_until: "FINAL" });
    if (j.result?.status) {
      const res = j.result;
      const failure = res.receipts_outcome.find((o: any) => o.outcome.status.Failure)?.outcome.status.Failure;
      const panic = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? (failure ? JSON.stringify(failure).slice(0, 200) : null);
      return {
        hash: sent.result,
        ok: typeof res.status.SuccessValue === "string" && !failure,
        panic,
        publicKey: res.transaction.public_key,
        logs: res.receipts_outcome.flatMap((o: any) => o.outcome.logs),
        blockHash: res.transaction_outcome.block_hash,
      };
    }
    await sleep(2000);
  }
  throw new Error(`no final outcome for ${sent.result} after 60 s`);
}
