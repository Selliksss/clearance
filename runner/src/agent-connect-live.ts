// Live check of the level-2 Agent Connect policy that `make policy` writes, on the real Agent Connect
// API (NEAR Intents Agent API; it runs on NEAR mainnet with real funds). The owner runs it step by
// step; every step that signs or moves money prints what it will do and needs --yes.
//
//   tsx src/agent-connect-live.ts keys                 three fresh implicit accounts: owner, payee, outsider
//   tsx src/agent-connect-live.ts inspect              generate the agent_create intent and print it decoded; signs nothing
//   tsx src/agent-connect-live.ts create --yes         the agent, with the level-2 policy (payee whitelisted)
//   tsx src/agent-connect-live.ts grant --yes          a 24-hour grant for this check (token kept locally, mode 600)
//   tsx src/agent-connect-live.ts fund 4.2 --yes       MONEY: wrap NEAR on the owner account, deposit the wNEAR to the agent
//   tsx src/agent-connect-live.ts check --yes          MONEY: the three transfers below, recorded in evidence/
//   tsx src/agent-connect-live.ts exit --yes           MONEY: allow withdraw to the owner, withdraw the rest as native NEAR, revoke the grant
//   tsx src/agent-connect-live.ts status               agent, policy, balances, saved stage
//
// The check, as the agent under its grant:
//   1. per-transfer limit + 1 NEAR to the whitelisted payee -> must be refused: policy_limit_exceeded
//   2. 0.1 NEAR to an account not on the whitelist          -> must be refused: policy_destination_denied
//   3. 0.1 NEAR to the whitelisted payee                    -> must settle (the policy does not refuse everything)
// Payee and outsider are implicit accounts whose keys stay in the same local file, so even a policy that
// failed would only move money between the owner's own accounts (into their NEAR Intents balances).
//
// Safety, from a security review before any funds moved:
// - every owner intent is checked before it is signed: requested type, signer, agent id, standard,
//   the delegate's contract, methods, deposits and gas, and the policy in the preview equal to ours;
// - the API host is pinned and the network must be mainnet; secrets never leave ~/.config/dopusk/;
// - money steps persist their stage before acting and refuse to repeat a step whose outcome is unknown.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString, actions } from "near-api-js";
import { type DelegatePayload, grantCredential, nearKey, publicKeyString, signNep366, signNep413 } from "./agent-connect-sign.ts";
import { NEAR, formatNear, parseNear } from "./chain.ts";
import { key } from "./model.ts";
import { buildAgentConnectPolicy, validateAgentConnectPolicy } from "./policy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_ORIGINS = ["https://api.demo.agentsonintents.com", "https://api.agentsonintents.com"];
const API = process.env.AGENT_CONNECT_URL ?? API_ORIGINS[0];
const RPC = "https://free.rpc.fastnear.com";
/** The custody contract every Agent Connect delegate action must call (their /v1/network and test vectors). */
const CONTRACT = "outlayer.near";
const MAX_GAS = 300_000_000_000_000n;
const DIR = join(homedir(), ".config", "dopusk", "agent-connect");
const KEYS = join(DIR, "keys.json");
const STATE = join(DIR, "state.json");
const WNEAR = "nep141:wrap.near";
const WRAP = "wrap.near";
const STORAGE = 1_250_000_000_000_000_000_000n;
const HEX64 = /^[0-9a-f]{64}$/;
const YES = process.argv.includes("--yes");

type Keys = Record<"owner" | "payee" | "outsider", { account_id: string; secret_key: string }>;
type Fund = { amount: string; stage: "wrapping" | "wrapped" | "deposit-requested" | "sending" | "sent" | "done"; idem: string; correlation_id?: string; address?: string };
type CheckCase = { idem: string; correlation_id?: string; result?: Record<string, unknown> };
type State = {
  agent_id?: string; create_idem?: string; created?: boolean;
  grant_id?: string; grant_token?: string; pending_grant_token?: string; grant_idem?: string;
  fund?: Fund; check?: Record<string, CheckCase>; exit?: { stage: string; idem?: string; withdrawals?: string[] }; revoked?: boolean;
};

if (!API_ORIGINS.includes(API)) throw new Error(`AGENT_CONNECT_URL must be one of ${API_ORIGINS.join(", ")}`);

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback);
function writeSecret(p: string, v: unknown) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}
const keys = () => {
  if (!existsSync(KEYS)) throw new Error("run `keys` first");
  return readJson<Keys>(KEYS, {} as Keys);
};
const state = () => readJson<State>(STATE, {});
const patch = (p: Partial<State>) => writeSecret(STATE, { ...state(), ...p });
const provider = new JsonRpcProvider({ url: RPC });
const ownerKey = () => nearKey(keys().owner.account_id, keys().owner.secret_key);
const localPolicy = () => buildAgentConnectPolicy(2, [keys().payee.account_id], keys().owner.account_id);
const policyHash = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const need = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

type ApiResult = { status: number; body: Record<string, unknown> };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": key("NEAR_INTENTS_AGENT_API_KEY"), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}
const errorCodes = (b: Record<string, unknown>) => ((b.errors as { code?: string }[] | undefined) ?? []).map((e) => e.code ?? "?");
function must(r: ApiResult, what: string): Record<string, unknown> {
  if (r.status >= 400) throw new Error(`${what}: HTTP ${r.status} ${errorCodes(r.body).join(",")} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const idOk = (id: unknown, re: RegExp, what: string) => {
  need(typeof id === "string" && re.test(id), `${what} has an unexpected format: ${String(id).slice(0, 80)}`);
  return id as string;
};

async function assertMainnet() {
  const n = must(await api("GET", "/v1/network"), "network");
  need(n.network === "mainnet" && n.contract_id === CONTRACT, `unexpected deployment: network ${n.network}, contract ${n.contract_id}`);
}

const POLLING = new Set(["PROCESSING", "QUEUED", "PENDING_DEPOSIT"]);
/** Polls to a resting status. Never throws on a transient read error: it reports UNKNOWN instead. */
async function waitStatus(correlationId: string, deadlineMs = 5 * 60_000): Promise<Record<string, unknown>> {
  idOk(correlationId, /^(op|intent)_[A-Za-z0-9_-]{4,120}$/, "correlation id");
  const end = Date.now() + deadlineMs;
  let last: Record<string, unknown> = { status: "UNKNOWN" };
  while (Date.now() < end) {
    const r = await api("GET", `/v1/status?correlation_id=${encodeURIComponent(correlationId)}&wait_ms=30000`).catch(() => null);
    if (r && r.status < 400) {
      last = r.body;
      if (!POLLING.has(String(last.status))) return last;
    }
    await sleep(2000);
  }
  return last;
}

/** Everything the owner signs is checked first; anything unexpected is refused, not signed. */
function assertSafeIntent(g: Record<string, unknown>, want: { type: string; standard: string; agentId?: string; policy?: unknown; credential?: string; methods: string[] }) {
  const k = ownerKey();
  need(g.type === want.type, `API returned intent type ${g.type}, asked for ${want.type}`);
  const signer = g.signer as { type?: string; account_id?: string; public_key?: string } | undefined;
  need(signer?.type === "near" && signer.account_id === k.accountId && signer.public_key === publicKeyString(k), "intent names a different signer");
  if (want.agentId) need(g.agent_id === want.agentId, "intent is for a different agent");
  idOk(g.agent_id, HEX64, "agent id");
  const intent = g.intent as { standard?: string; payload?: unknown } | undefined;
  need(intent?.standard === want.standard, `expected a ${want.standard} intent, got ${intent?.standard}`);
  const preview = (g.preview ?? {}) as { policy?: unknown; summary?: unknown };
  if (want.policy !== undefined) need(isDeepStrictEqual(preview.policy, want.policy), "the policy in the preview is not the policy we sent");
  if (want.standard === "nep366") {
    const p = intent!.payload as DelegatePayload;
    need(p.receiverId === CONTRACT, `delegate calls ${p.receiverId}, expected ${CONTRACT}`);
    let gas = 0n;
    for (const a of p.actions) {
      need(a.type === "FunctionCall", `delegate action ${a.type} refused`);
      need(want.methods.includes(a.params.methodName), `delegate method ${a.params.methodName} is not in the allowlist ${want.methods.join(",")}`);
      // store_wallet_policy pays the contract's storage for the encrypted policy (0.01626 NEAR seen in `inspect`); nothing else may attach more than 1 yocto.
      const cap = a.params.methodName === "store_wallet_policy" ? MAX_POLICY_STORAGE : 1n;
      need(/^[0-9]+$/.test(a.params.deposit) && BigInt(a.params.deposit) <= cap, `delegate attaches a deposit of ${a.params.deposit} yocto to ${a.params.methodName}`);
      need(/^[0-9]+$/.test(a.params.gas), "delegate gas is not an integer");
      gas += BigInt(a.params.gas);
    }
    need(gas <= MAX_GAS, "delegate asks for more than 300 Tgas");
  } else {
    const p = intent!.payload as { message?: string; recipient?: string };
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(p.message ?? "");
    } catch {
      throw new Error("nep413 message is not JSON");
    }
    const text = JSON.stringify(m);
    if (want.agentId) need(text.includes(want.agentId), "nep413 message does not name the agent");
    if (want.credential) need(text.includes(want.credential), "nep413 message does not carry our grant commitment");
    need(typeof p.recipient === "string" && p.recipient.length > 0, "nep413 recipient missing");
  }
}

function describeIntent(g: Record<string, unknown>) {
  const intent = g.intent as { standard: string; payload: Record<string, unknown> };
  console.log(`  type ${g.type}, standard ${intent.standard}, agent ${g.agent_id}, expires ${g.expires_at}`);
  console.log(`  summary: ${String((g.preview as { summary?: unknown } | undefined)?.summary ?? "").slice(0, 400)}`);
  if (intent.standard === "nep366") {
    const p = intent.payload as unknown as DelegatePayload;
    console.log(`  delegate to ${p.receiverId}`);
    for (const a of p.actions) console.log(`    ${a.params.methodName}  deposit ${a.params.deposit}  gas ${a.params.gas}  args ${JSON.stringify(a.params.args).slice(0, 300)}`);
  } else {
    console.log(`  nep413 recipient ${intent.payload.recipient}; message ${String(intent.payload.message).slice(0, 400)}`);
  }
}

async function signAndSubmit(g: Record<string, unknown>): Promise<Record<string, unknown>> {
  const owner = ownerKey();
  const intent = g.intent as { standard: string; payload: unknown };
  let extra: Record<string, unknown>;
  if (intent.standard === "nep413") {
    extra = signNep413(owner, intent.payload as { message: string; recipient: string; nonce: string });
  } else {
    const ak = (await provider.query({ request_type: "view_access_key", finality: "final", account_id: owner.accountId, public_key: publicKeyString(owner) })) as unknown as { nonce: number | string; block_height: number | string };
    extra = { signed_delegate: signNep366(owner, intent.payload as DelegatePayload, BigInt(ak.nonce), BigInt(ak.block_height)).signed_delegate };
  }
  must(await api("POST", "/v1/submit-intent", { type: g.type, correlation_id: g.correlation_id, signed_data: { ...intent, ...extra } }), "submit-intent");
  return waitStatus(String(g.correlation_id));
}

/** Generates, checks and (with --yes) signs one owner intent. */
async function ownerIntent(body: Record<string, unknown>, idem: string, want: Parameters<typeof assertSafeIntent>[1]) {
  const g = must(await api("POST", "/v1/generate-intent", body, { "idempotency-key": idem }), `generate ${body.type}`);
  describeIntent(g);
  assertSafeIntent(g, want);
  if (!YES) {
    console.log("checked; nothing signed. Rerun with --yes to sign.");
    return null;
  }
  return { generated: g, status: await signAndSubmit(g) };
}

async function accountExists(id: string): Promise<boolean | null> {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch (e) {
    return /does not exist|UNKNOWN_ACCOUNT/i.test(String((e as Error).message)) ? false : null;
  }
}

async function appliedPolicy(agentId: string) {
  const p = must(await api("GET", `/v1/agents/${idOk(agentId, HEX64, "agent id")}/policy`), "policy");
  return p as { status?: string; provider_policy_synced?: boolean; policy?: unknown; policy_hash?: string; revision?: number; transaction_hash?: string };
}
async function requireOurPolicy(agentId: string, policy: unknown = localPolicy()) {
  const p = await appliedPolicy(agentId);
  need(p.status === "APPLIED" && p.provider_policy_synced === true, `policy not in force yet (${p.status}, synced ${p.provider_policy_synced})`);
  need(isDeepStrictEqual(p.policy, policy), "the applied policy is not the one `make policy` writes");
  return p;
}

async function cmdKeys() {
  need(!existsSync(KEYS), `${KEYS} exists; refusing to overwrite keys that may hold funds`);
  const make = () => {
    const kp = KeyPair.fromRandom("ed25519");
    return { account_id: Buffer.from(kp.getPublicKey().data).toString("hex"), secret_key: kp.toString() };
  };
  writeSecret(KEYS, { owner: make(), payee: make(), outsider: make() });
  for (const [role, v] of Object.entries(keys())) console.log(`${role.padEnd(8)} ${v.account_id}`);
}

function createBody() {
  const k = ownerKey();
  return { type: "agent_create", name: "Clearance live policy check", external_user_id: "clearance-live-check",
    owner: { type: "near", account_id: k.accountId, public_key: publicKeyString(k) }, policy: localPolicy() };
}

async function cmdInspect() {
  await assertMainnet();
  need(await accountExists(keys().owner.account_id), "owner account does not exist on mainnet yet: send it a little NEAR first");
  const g = must(await api("POST", "/v1/generate-intent", createBody(), { "idempotency-key": randomUUID() }), "generate agent_create");
  describeIntent(g);
  console.log("inspect only: nothing was signed (this reserves a PENDING agent that expires unsigned).");
}

async function cmdCreate() {
  const s = state();
  need(!s.created, `agent ${s.agent_id} already created`);
  await assertMainnet();
  need(await accountExists(keys().owner.account_id), "owner account does not exist on mainnet yet");
  const errors = validateAgentConnectPolicy(localPolicy(), 2);
  need(errors.length === 0, errors.join("; "));
  // A dry run (no --yes) keeps no key: the intent it generated expires in minutes.
  const idem = YES ? (s.create_idem ?? randomUUID()) : randomUUID();
  if (YES) patch({ create_idem: idem });
  const r = await ownerIntent(createBody(), idem, { type: "agent_create", standard: "nep366", policy: localPolicy(), methods: CREATE_METHODS });
  if (!r) return;
  patch({ agent_id: String(r.generated.agent_id) });
  console.log(`agent_create: ${r.status.status}${r.status.failure_code ? ` (${r.status.failure_code})` : ""}`);
  need(r.status.status === "SUCCESS", "agent_create did not succeed; run `status` before retrying");
  const p = await requireOurPolicy(String(r.generated.agent_id));
  patch({ created: true });
  console.log(`policy APPLIED, synced, identical to make policy's; revision ${p.revision}, hash ${p.policy_hash}`);
}

async function cmdGrant() {
  const s = state();
  need(s.created && s.agent_id, "run `create` first");
  need(!s.grant_id, `grant ${s.grant_id} already issued`);
  const cred = s.pending_grant_token ? grantCredential(s.pending_grant_token) : grantCredential();
  const idem = YES ? (s.grant_idem ?? randomUUID()) : randomUUID();
  if (YES) patch({ pending_grant_token: cred.token, grant_idem: idem }); // kept before the owner signs, as their docs require
  const r = await ownerIntent({ type: "grant_issue", agent_id: s.agent_id, label: "clearance live policy check", credential: cred.commitment,
    expires_at: new Date(Date.now() + 86_400_000).toISOString() }, idem,
  { type: "grant_issue", standard: "nep413", agentId: s.agent_id, credential: cred.commitment, methods: [] });
  if (!r) return;
  const grantId = (r.status.details as { grant?: { grant_id?: string } } | undefined)?.grant?.grant_id;
  need(r.status.status === "SUCCESS" && grantId, `grant_issue: ${r.status.status} ${r.status.failure_code ?? ""}`);
  patch({ grant_id: grantId, grant_token: cred.token, pending_grant_token: undefined });
  console.log(`grant ${grantId} issued for 24 hours (token kept in ${STATE})`);
}

async function ftBalance(id: string): Promise<bigint> {
  return BigInt((await provider.callFunction({ contractId: WRAP, method: "ft_balance_of", args: { account_id: id } })) as string);
}
async function agentBalance(agentId: string): Promise<bigint> {
  const b = must(await api("GET", `/v1/agents/${idOk(agentId, HEX64, "agent id")}/balances?source=public`), "balances");
  const row = ((b.balances as { asset_id: string; balance_raw?: string }[]) ?? []).find((x) => x.asset_id === WNEAR);
  return BigInt(row?.balance_raw ?? "0");
}

async function cmdFund(amountNear: string) {
  const s = state();
  need(s.created && s.agent_id && s.grant_id, "run `create` and `grant` first");
  need(/^\d+(\.\d+)?$/.test(amountNear), "usage: fund <NEAR>");
  const amount = parseNear(amountNear);
  need(amount > 0n && amount <= 6n * NEAR, "fund between 0 and 6 NEAR");
  await assertMainnet();
  await requireOurPolicy(s.agent_id!);
  let f: Fund = s.fund ?? { amount: amount.toString(), stage: "wrapping", idem: randomUUID() };
  need(f.amount === amount.toString(), `a fund of ${formatNear(BigInt(f.amount))} NEAR is already in progress`);
  need(f.stage !== "done", "already funded");
  need(f.stage !== "sending", `a transfer to ${f.address} may already have been sent. Check the deposit ${f.correlation_id} with \`status\`; do not rerun fund`);
  const k = keys().owner;
  const owner = new Account(k.account_id, provider, k.secret_key as KeyPairString);
  const call = (method: string, args: Record<string, unknown>, deposit: bigint) =>
    owner.signAndSendTransaction({ receiverId: WRAP, actions: [actions.functionCall(method, args, 50_000_000_000_000n, deposit)], waitUntil: "FINAL" });
  const registered = async (id: string) => (await provider.callFunction({ contractId: WRAP, method: "storage_balance_of", args: { account_id: id } })) !== null;
  const save = (next: Partial<Fund>) => {
    f = { ...f, ...next };
    patch({ fund: f });
  };
  const wallet = must(await api("GET", `/v1/agents/${s.agent_id}/wallet`), "wallet") as { near_account_id?: string };
  console.log(`will wrap ${formatNear(amount)} NEAR on ${k.account_id} and deposit it to agent ${s.agent_id} (NEAR account ${wallet.near_account_id})`);
  need(YES, "rerun with --yes to move the money");
  save({});
  if (f.stage === "wrapping") {
    if (!(await registered(k.account_id))) await call("storage_deposit", { account_id: k.account_id, registration_only: true }, STORAGE);
    const have = await ftBalance(k.account_id);
    if (have < amount) await call("near_deposit", {}, amount - have);
    save({ stage: "wrapped" });
  }
  if (f.stage === "wrapped" || f.stage === "deposit-requested") {
    // The same Idempotency-Key gives the same deposit address on a rerun.
    const dep = must(await api("POST", `/v1/agents/${s.agent_id}/deposit`, { origin_asset: WNEAR, amount: amount.toString() }, { "idempotency-key": f.idem }), "deposit");
    const d = (dep.details ?? {}) as { deposit_address?: string; memo?: string | null; refund_to?: string; expires_at?: string; min_amount?: string };
    idOk(d.deposit_address, HEX64, "deposit address");
    need(d.refund_to === undefined || d.refund_to === wallet.near_account_id || d.refund_to === s.agent_id, `deposit refunds to ${d.refund_to}, not the agent`);
    need(!d.expires_at || Date.parse(d.expires_at) > Date.now() + 60_000, "deposit address expires too soon");
    need(!d.min_amount || BigInt(d.min_amount) <= amount, `deposit minimum ${d.min_amount} is above the amount`);
    save({ stage: "deposit-requested", correlation_id: String(dep.correlation_id), address: d.deposit_address });
    if (!(await registered(d.deposit_address!))) await call("storage_deposit", { account_id: d.deposit_address, registration_only: true }, STORAGE);
    save({ stage: "sending" });
    await call("ft_transfer", { receiver_id: d.deposit_address, amount: amount.toString(), ...(d.memo ? { memo: d.memo } : {}) }, 1n);
    save({ stage: "sent" });
  }
  const st = await waitStatus(f.correlation_id!, 10 * 60_000);
  console.log(`deposit ${f.correlation_id}: ${st.status}`);
  if (st.status === "SUCCESS") save({ stage: "done" });
  else console.log("not settled yet: run `status` later; do not rerun fund");
}

async function cmdCheck() {
  const k = keys();
  const s = state();
  need(s.agent_id && s.grant_token && s.fund?.stage === "done", "run `create`, `grant` and `fund` first");
  await assertMainnet();
  const policy = localPolicy();
  const applied = await requireOurPolicy(s.agent_id!, policy);
  const perTx = BigInt(policy.limits.per_transaction[WNEAR]);
  const over = perTx + NEAR;
  const balance = await agentBalance(s.agent_id!);
  need(balance >= over + parseNear("0.2"), `agent holds ${formatNear(balance)} wNEAR; it needs ${formatNear(over + parseNear("0.2"))} so case 1 can only be refused by the policy`);
  const cases = [
    { id: "over-limit", name: "over the per-transfer limit, to the whitelisted payee", recipient: k.payee.account_id, amount: over, expect: "policy_limit_exceeded" },
    { id: "not-listed", name: "to an account not on the whitelist", recipient: k.outsider.account_id, amount: parseNear("0.1"), expect: "policy_destination_denied" },
    { id: "allowed", name: "within the limit, to the whitelisted payee", recipient: k.payee.account_id, amount: parseNear("0.1"), expect: "SUCCESS" },
  ];
  for (const c of cases) console.log(`will send ${formatNear(c.amount)} wNEAR to ${c.recipient} (${c.name}); expected ${c.expect}`);
  need(YES, "rerun with --yes to send them");
  const saved = { ...(s.check ?? {}) };
  for (const c of cases) {
    if (saved[c.id]?.result) continue;
    saved[c.id] = saved[c.id] ?? { idem: randomUUID() };
    patch({ check: saved });
    const at = new Date().toISOString();
    let outcome: string;
    let http = 0;
    let details: Record<string, unknown> = {};
    if (saved[c.id].correlation_id) {
      details = await waitStatus(saved[c.id].correlation_id!);
      outcome = String(details.status);
    } else {
      const r = await api("POST", `/v1/agents/${s.agent_id}/transfer`, { asset: WNEAR, amount: c.amount.toString(), recipient: c.recipient },
        { "x-grant-token": s.grant_token!, "idempotency-key": saved[c.id].idem });
      http = r.status;
      if (r.status >= 400) outcome = errorCodes(r.body).join(",") || `HTTP ${r.status}`;
      else {
        saved[c.id].correlation_id = String(r.body.correlation_id);
        patch({ check: saved });
        details = await waitStatus(saved[c.id].correlation_id!);
        outcome = String(details.status);
      }
    }
    if (["PROCESSING", "QUEUED", "UNKNOWN"].includes(outcome)) {
      console.log(`${c.id}: still ${outcome}; rerun check later (it resumes this case, it does not resend)`);
      return;
    }
    const failure = String(details.failure_code ?? "");
    const pass = c.expect === "SUCCESS" ? outcome === "SUCCESS" : outcome.split(",").includes(c.expect) || failure === c.expect;
    const d = (details.details ?? {}) as Record<string, unknown>;
    saved[c.id].result = { case: c.name, amount_near: formatNear(c.amount), recipient: c.recipient, http_status: http || null, outcome, failure_code: failure || null,
      expected: c.expect, pass, correlation_id: saved[c.id].correlation_id ?? null, tx_hash: d.tx_hash ?? d.intent_hash ?? null, at };
    patch({ check: saved });
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}: ${outcome}${failure ? ` (${failure})` : ""} (expected ${c.expect})`);
  }
  const results = cases.map((c) => saved[c.id].result);
  const evidence = {
    what: "Live check of the level-2 Agent Connect policy written by `make policy`, on the Agent Connect API",
    api: API, network: "mainnet", contract: CONTRACT, agent_id: s.agent_id,
    local_policy_sha256: policyHash(policy), applied_policy_identical: true, policy_status: applied.status, policy_revision: applied.revision ?? null,
    policy_hash: applied.policy_hash ?? null, policy_transaction_hash: applied.transaction_hash ?? null,
    owner: k.owner.account_id, payee: k.payee.account_id, outsider: k.outsider.account_id,
    all_pass: results.every((r) => r?.pass === true), results,
  };
  mkdirSync(join(ROOT, "evidence"), { recursive: true });
  const out = join(ROOT, "evidence", `agent-connect-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`evidence written to ${out}; all_pass ${evidence.all_pass}`);
}

async function cmdExit() {
  const s = state();
  const k = keys();
  need(s.agent_id && s.grant_token, "nothing to exit");
  const agentId = s.agent_id!;
  await assertMainnet();
  const exit = s.exit ?? { stage: "policy" };
  const policy = localPolicy();
  const exitPolicy = { ...policy, actions: ["transfer", "withdraw"],
    destinations: { mode: "only", list: [...policy.destinations.list, { action: "withdraw", chain: "near", address: k.owner.account_id, memo: null }] } };
  if (exit.stage === "policy") {
    const current = await appliedPolicy(s.agent_id!);
    if (!isDeepStrictEqual(current.policy, exitPolicy)) {
      const idem = exit.idem ?? randomUUID();
      patch({ exit: { ...exit, idem } });
      console.log("policy change: also allow withdraw of wNEAR to the owner's own NEAR account (limits unchanged)");
      const r = await ownerIntent({ type: "policy_update", agent_id: s.agent_id, policy: exitPolicy, expected_revision: current.revision }, idem,
        { type: "policy_update", standard: "nep366", agentId: s.agent_id, policy: exitPolicy, methods: POLICY_METHODS });
      if (!r) return;
      need(r.status.status === "SUCCESS", `policy_update: ${r.status.status} ${r.status.failure_code ?? ""} (a 10-minute cooldown applies after a change)`);
    }
    await requireOurPolicy(agentId, exitPolicy);
    patch({ exit: { stage: "withdraw", withdrawals: [] } });
  }
  const perTx = BigInt(policy.limits.per_transaction[WNEAR]);
  let left = await agentBalance(agentId);
  const withdrawals = state().exit?.withdrawals ?? [];
  while (left > parseNear("0.01")) {
    const chunk = left > perTx ? perTx : left;
    const body = { asset: WNEAR, amount: chunk.toString(), chain: "near", recipient: k.owner.account_id };
    const dry = await api("POST", `/v1/agents/${s.agent_id}/withdraw`, { ...body, dry: true }, { "x-grant-token": s.grant_token!, "idempotency-key": randomUUID() });
    const warnings = JSON.stringify(dry.body.warnings ?? []);
    console.log(`withdraw ${formatNear(chunk)} NEAR to ${k.owner.account_id}: preview HTTP ${dry.status}, warnings ${warnings.slice(0, 200)}`);
    need(YES, "rerun with --yes to withdraw");
    need(dry.status < 400, `withdraw preview refused: ${errorCodes(dry.body).join(",")}`);
    const r = must(await api("POST", `/v1/agents/${s.agent_id}/withdraw`, body, { "x-grant-token": s.grant_token!, "idempotency-key": randomUUID() }), "withdraw");
    withdrawals.push(String(r.correlation_id));
    patch({ exit: { stage: "withdraw", withdrawals } });
    const st = await waitStatus(String(r.correlation_id), 10 * 60_000);
    console.log(`  ${r.correlation_id}: ${st.status}`);
    need(st.status === "SUCCESS", "withdrawal not settled; run `status`, then `exit --yes` again");
    left = await agentBalance(agentId);
  }
  if (!state().revoked && state().grant_id) {
    const r = await ownerIntent({ type: "grant_revoke", agent_id: s.agent_id, grant_id: state().grant_id }, randomUUID(),
      { type: "grant_revoke", standard: "nep413", agentId: s.agent_id, methods: [] });
    if (r?.status.status === "SUCCESS") patch({ revoked: true });
  }
  console.log(`exit done: agent wNEAR left ${formatNear(await agentBalance(agentId))}; owner native NEAR is on ${k.owner.account_id}`);
}

async function cmdStatus() {
  const s = state();
  if (existsSync(KEYS)) for (const [role, v] of Object.entries(keys())) console.log(`${role.padEnd(8)} ${v.account_id} exists=${await accountExists(v.account_id)}`);
  if (s.fund) console.log(`fund: ${s.fund.stage}${s.fund.correlation_id ? `, deposit ${s.fund.correlation_id}` : ""}`);
  if (s.fund?.correlation_id && s.fund.stage !== "done") {
    const st = await waitStatus(s.fund.correlation_id, 5_000);
    console.log(`  deposit status ${st.status}`);
    if (st.status === "SUCCESS") patch({ fund: { ...s.fund, stage: "done" } });
  }
  if (!s.agent_id) return console.log("no agent yet");
  const p = await appliedPolicy(s.agent_id);
  console.log(`agent ${s.agent_id}; policy ${p.status}, synced ${p.provider_policy_synced}, revision ${p.revision}; identical to ours ${isDeepStrictEqual(p.policy, localPolicy())}`);
  console.log(`grant ${s.grant_id ?? "none"}${s.revoked ? " (revoked)" : ""}; agent wNEAR ${formatNear(await agentBalance(s.agent_id))}`);
}

/** Delegate methods the owner may sign, pinned from `inspect` output before any signature. */
const CREATE_METHODS = ["store_wallet_policy"];
const POLICY_METHODS = ["store_wallet_policy"];
const MAX_POLICY_STORAGE = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

const [cmd, arg] = process.argv.slice(2).filter((a) => a !== "--yes");
const run: Record<string, () => Promise<void>> = {
  keys: cmdKeys, inspect: cmdInspect, create: cmdCreate, grant: cmdGrant, fund: () => cmdFund(arg ?? ""), check: cmdCheck, exit: cmdExit, status: cmdStatus,
};
if (!run[cmd]) {
  console.error("usage: agent-connect-live.ts keys | inspect | create [--yes] | grant [--yes] | fund <NEAR> [--yes] | check [--yes] | exit [--yes] | status");
  process.exit(1);
}
run[cmd]().catch((e) => {
  console.error(`refused: ${(e as Error).message}`);
  process.exit(1);
});
