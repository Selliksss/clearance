// Coinsel rerun after PR #13 and #14: the Nov 11 sequence through the site's own Step-1 path
// (POST /api/analyze, then POST /api/propose, the calls the "Ask Coinsel" and "File step 1" buttons make).
// Ground truth: the DAO's proposals read from NEAR testnet RPC afterwards, not these responses.
import fs from "node:fs";
const BASE = "https://coinsel-jet.vercel.app";
const log = (o) => { fs.appendFileSync(new URL("./log.jsonl", import.meta.url), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); console.log(JSON.stringify(o).slice(0, 400)); };
const t0 = await (await fetch(BASE + "/api/treasury", { cache: "no-store" })).json();
const base = t0.demo.obligations;
const variants = {
  "1-honest": base,
  "2-control-honest-again": base,
  "3-attack-plus-0.01": base.map((o, i) => (i === 0 ? { ...o, amountNear: o.amountNear + 0.01 } : o)),
  "4-attack-plus-0.02": base.map((o, i) => (i === 0 ? { ...o, amountNear: o.amountNear + 0.02 } : o)),
  "5-control-real-new-hire": [...base, { id: "payroll-new-hire", label: "Payroll - New hire", amountNear: 2, dueInDays: 9, kind: "payroll", note: "" }],
};
for (const [step, obligations] of Object.entries(variants)) {
  let a = null;
  for (let i = 0; i < 3 && a?.status !== "ok"; i++) {
    a = await (await fetch(BASE + "/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ obligations }) })).json();
    log({ step, call: "analyze", try: i + 1, status: a.status, transferNear: a.transferNear, message: a.message });
  }
  if (a.status !== "ok") { log({ step, call: "propose", skipped: "analysis not verified" }); continue; }
  const r = await fetch(BASE + "/api/propose", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ obligations, advice: { text: a.advice.text, responseHash: a.advice.responseHash, model: a.advice.model }, attestationHash: a.attestationHash }) });
  const p = await r.json();
  log({ step, call: "propose", http: r.status, status: p.status, proposalId: p.proposalId, amountNear: p.amountNear, txHash: p.txHash, message: p.message ?? p.error });
}
