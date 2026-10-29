// Asks NEAR AI again for the TEE signature of a transcript turn, one request per turn, no retries.
// Used for the one run cut off while fetching its signature (transcripts/iqai-near-intents-glm/bda0daa1…):
// if the signature still 404s while a turn from a neighbouring run is served, the record was never
// created, rather than late. Prints the HTTP status and body (the key is never printed).
// Key: NEARAI_API_KEY from the environment, or from ~/.config/dopusk/.env (same as the runner).
// Run: make signature-recheck   (or: cd runner && npx tsx ../scripts/signature-recheck.mts <transcript.json>[:turn] ... [--save])
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, key } from "../runner/src/model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // import.meta.dirname needs Node 20.11
const DEFAULT = [
  "transcripts/iqai-near-intents-glm/bda0daa1-1c9a-486b-9c33-e2f214549619.json", // cut off: last turn unsigned
  "transcripts/iqai-near-intents-glm/1740d8cf-d9c2-4cc6-884d-c48ba9b25f27.json:0", // started 13 s earlier, same agent and model
];

const args = process.argv.slice(2);
const save = args.includes("--save");
const targets = args.filter((a) => a !== "--save");

const results = [];
for (const target of targets.length ? targets : DEFAULT) {
  const [file, turnArg] = target.split(":");
  const t = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  const i = turnArg === undefined ? t.turns.length - 1 : Number(turnArg);
  const m = t.turns[i].model;
  const completion = JSON.parse(Buffer.from(m.response_b64, "base64").toString()).id as string;
  const model = JSON.parse(Buffer.from(m.request_b64, "base64").toString()).model as string;
  const url = `${ENDPOINTS.nearai.base}/signature/${encodeURIComponent(completion)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  const at = new Date().toISOString();
  const res = await fetch(url, { headers: { authorization: `Bearer ${key(ENDPOINTS.nearai.keyVar)}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const body = res.status === 401 || res.status === 403 ? "(auth error body withheld)" : await res.text();
  const r = { transcript: basename(file), run_started_at: t.started_at, turn: i, completion_id: completion, model, requested_at: at, status: res.status, body };
  results.push(r);
  console.log(`${r.status}  ${r.transcript} turn ${i}  completion ${completion}  (run ${t.started_at}, asked ${at})`);
  console.log(`     ${body.slice(0, 300)}`);
}
if (save) {
  const out = join(ROOT, "evidence", `signature-recheck-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  console.log(`saved ${out}`);
}
