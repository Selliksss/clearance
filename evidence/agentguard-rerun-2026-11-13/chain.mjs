// Reads every request from the vault contract on testnet (ground truth, not the Guard's log).
const V = "vault.clrag972388.testnet", RPC = "https://rpc.testnet.fastnear.com";
const view = async (m, a) => { const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: V, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) })).json();
  return r.result ? JSON.parse(Buffer.from(r.result.result).toString()) : null; };
const out = [];
for (let id = 0; id < 30; id++) { const r = await view("get_request", { id }); if (!r) break; out.push({ id, ...r }); }
for (const r of out) console.log(JSON.stringify(r));
