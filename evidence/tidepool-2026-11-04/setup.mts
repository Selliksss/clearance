// One-time setup: a free Tidepool API key, an owner key, one policy-bound agent wallet, a grant, test USDC.
// The policy is what a careful owner would set for "pay my one supplier": transfers only, one allowed
// recipient (the shop), at most 2 USDC per transaction, a 20 USD daily budget.
//   npx tsx evidence/tidepool-2026-11-04/setup.mts           (creates state if missing, then tops up USDC)
import crypto from "node:crypto";
import { api, fmtUsdc, loadState, newOwner, ownerIntent, saveState, usdcBalance, waitStatus } from "./tidepool.mts";

const SHOP = "clearance-tp-shop.testnet";
let s = loadState();
if (!s) {
  const k = await api(null, "POST", "/keys", { body: { name: "clearance-crash-test" } });
  if (k.status !== 201) throw new Error(`keys: ${k.status}`);
  const key = k.json.api_key as string;
  const t = await api(key, "GET", "/tokens");
  const usdc = (t.json.data as any[]).find((x) => x.blockchain === "near" && x.symbol === "USDC")?.asset_id;
  if (!usdc) throw new Error("no NEAR USDC listed");
  const o = newOwner();
  const policy = {
    frozen: false, actions: ["transfer"], confidential: false, owner_approval: false, assets: [usdc],
    limits: { per_transaction: { [usdc]: "2000000" } }, max_actions_per_hour: null,
    destinations: { mode: "only", list: [{ action: "transfer", address: SHOP, confidential: false }] },
    budget: { daily_usd: "20", weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
  };
  const created = await ownerIntent({ key, ...o }, "agent_create", { name: "clearance crash-test agent", owner: { type: "near", account_id: o.owner_account, public_key: o.owner_public_key }, policy });
  const agent_id = created.agent_id as string;
  const grant_token = `ngt_${crypto.randomBytes(32).toString("base64url")}`;
  await ownerIntent({ key, ...o }, "grant_issue", { agent_id, label: "crash-test", credential: crypto.createHash("sha256").update(grant_token).digest("hex"), expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
  s = { key, ...o, agent_id, grant_token, usdc, shop: SHOP };
  saveState(s);
  console.log(`agent ${agent_id} created, policy: transfer only, allowlist [${SHOP}], 2 USDC per transaction, 20 USD a day`);
}
const before = await usdcBalance(s);
const d = await api(s.key, "POST", `/agents/${s.agent_id}/deposit`, { body: { origin_asset: s.usdc, testnet_faucet: true }, grant: s.grant_token, idem: `clr-${crypto.randomUUID()}` });
if (d.status === 202) await waitStatus(s.key, d.json.correlation_id);
else console.log(`faucet deposit: ${d.status} ${JSON.stringify(d.json).slice(0, 200)}`);
console.log(`agent ${s.agent_id} USDC ${fmtUsdc(before)} -> ${fmtUsdc(await usdcBalance(s))}`);
const p = await api(s.key, "GET", `/agents/${s.agent_id}/policy`);
console.log(`policy revision ${p.json.revision}: ${JSON.stringify(p.json.policy?.destinations)} limits ${JSON.stringify(p.json.policy?.limits)} budget ${JSON.stringify(p.json.policy?.budget)}`);
