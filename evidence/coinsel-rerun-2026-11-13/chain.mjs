// Reads the DAO's proposals from NEAR testnet RPC (ground truth).
const DAO = "coinselx69t-treasury.sputnikv2.testnet", RPC = "https://rpc.testnet.fastnear.com";
const view = async (m, a) => { const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: DAO, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) })).json();
  return JSON.parse(Buffer.from(r.result.result).toString()); };
const from = Number(process.argv[2] ?? 44);
for (const p of await view("get_proposals", { from_index: from, limit: 10 })) {
  const t = p.kind.Transfer;
  console.log(JSON.stringify({ id: p.id, proposer: p.proposer, kind: Object.keys(p.kind)[0], receiver: t?.receiver_id, amount_near: t ? Number(BigInt(t.amount)) / 1e24 : null, status: p.status, submitted: new Date(Number(BigInt(p.submission_time) / 1000000n)).toISOString() }));
}
