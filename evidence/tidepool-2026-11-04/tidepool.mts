// Shared Tidepool Agent API client for the runs in this folder (outside the judge: nothing here is in JUDGE_PATHS).
// Tidepool (https://www.usetidepool.tech, community-built, not affiliated with NEAR) is a testnet implementation of
// the NEAR Intents Agent API: policy-bound agent wallets on NEAR testnet, settled by NEAR's Intents verifier.
// Secrets (API key, owner key, grant token) live in ~/.config/dopusk/tidepool.json and are never printed.
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE = "https://www.usetidepool.tech";
const STATE = join(homedir(), ".config", "dopusk", "tidepool.json");

export type State = {
  key: string; owner_pkcs8: string; owner_account: string; owner_public_key: string;
  agent_id: string; grant_token: string; usdc: string; shop: string;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf: Buffer) => { let n = BigInt(`0x${buf.toString("hex")}`), s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b) break; s = `1${s}`; } return s; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = (s: string) => { const x = Buffer.from(s); return Buffer.concat([u32(x.length), x]); };

export function loadState(): State | null {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
}
export function saveState(s: State) {
  writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export async function api(key: string | null, method: string, path: string, opts: { body?: unknown; grant?: string; idem?: string } = {}) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(opts.grant ? { "x-grant-token": opts.grant } : {}),
      ...(opts.idem ? { "idempotency-key": opts.idem } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

/** NEP-413 owner intent: generate, sign with the owner key, submit, wait. */
export async function ownerIntent(s: Pick<State, "key" | "owner_pkcs8" | "owner_public_key">, type: string, body: Record<string, unknown>) {
  const g = await api(s.key, "POST", "/generate-intent", { body: { type, ...body }, idem: `clr-${crypto.randomUUID()}` });
  if (g.status !== 201) throw new Error(`generate-intent ${type}: ${g.status} ${JSON.stringify(g.json).slice(0, 300)}`);
  const p = g.json.intent.payload;
  const priv = crypto.createPrivateKey({ key: Buffer.from(s.owner_pkcs8, "base64"), format: "der", type: "pkcs8" });
  const hash = crypto.createHash("sha256").update(Buffer.concat([u32(2 ** 31 + 413), bstr(p.message), Buffer.from(p.nonce, "base64"), bstr(p.recipient), Buffer.from([0])])).digest();
  const signature = crypto.sign(null, hash, priv).toString("base64");
  const sub = await api(s.key, "POST", "/submit-intent", { body: { type, correlation_id: g.json.correlation_id, signed_data: { standard: "nep413", payload: p, public_key: s.owner_public_key, signature } } });
  if (sub.status !== 202) throw new Error(`submit-intent ${type}: ${sub.status} ${JSON.stringify(sub.json).slice(0, 300)}`);
  const st = await api(s.key, "GET", `/status?correlation_id=${g.json.correlation_id}&wait_ms=20000`);
  if (st.json.status !== "SUCCESS") throw new Error(`${type}: ${st.json.status} ${st.json.failure_code}`);
  return st.json;
}

export function newOwner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    owner_pkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
    owner_account: raw.toString("hex"),
    owner_public_key: `ed25519:${b58(raw)}`,
  };
}

/** Polls an agent action to a final status. */
export async function waitStatus(key: string, correlationId: string) {
  for (let i = 0; i < 6; i++) {
    const st = await api(key, "GET", `/status?correlation_id=${correlationId}&wait_ms=30000`);
    if (["SUCCESS", "FAILED", "REFUNDED"].includes(st.json.status)) return st.json;
  }
  throw new Error(`status of ${correlationId} did not settle`);
}

export async function usdcBalance(s: State): Promise<bigint> {
  const b = await api(s.key, "GET", `/agents/${s.agent_id}/balances`);
  const row = (b.json.balances ?? []).find((x: any) => x.asset_id === s.usdc);
  return BigInt(row?.balance_raw ?? "0");
}

export const fmtUsdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(2);
