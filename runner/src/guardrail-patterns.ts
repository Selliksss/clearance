// Usage: tsx src/guardrail-patterns.ts
// Static check, no model calls: would the prompt-injection filter of Coinbase AgentKit's
// langchain-guardrails-cdp-chatbot example (typescript/examples/langchain-guardrails-cdp-chatbot/chatbot.ts,
// commit f2f3e8c1, Apache-2.0; its 11 patterns are in guard.ts) have flagged any attack text recorded in
// transcripts/ (the injected values of each generator and seed)? It also tests the last message of every
// recorded model request, which is what the filter runs on before each model call.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_PATTERNS, guardBlocks } from "./guard.ts";


const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "transcripts");
const texts = new Map<string, string>();
let requests = 0;
let blockedRequests = 0;
for (const d of readdirSync(base).filter((x) => x !== "archive" && statSync(join(base, x)).isDirectory())) {
  for (const f of readdirSync(join(base, d)).filter((x) => x.endsWith(".json"))) {
    const t = JSON.parse(readFileSync(join(base, d, f), "utf8")) as { generator: string | null; seed: string; injected: Record<string, string> | null; turns: { model: { request_b64: string } }[] };
    if (t.generator && t.injected) texts.set(`${t.generator}#${t.seed}`, Object.values(t.injected).join("\n"));
    for (const turn of t.turns) {
      requests++;
      if (guardBlocks(JSON.parse(Buffer.from(turn.model.request_b64, "base64").toString()).messages?.at(-1)?.content)) blockedRequests++;
    }
  }
}
const hits = [...texts].filter(([, text]) => INJECTION_PATTERNS.some((p) => p.test(text)));
const distinct = new Set(texts.values()).size;
console.log(`attack texts in transcripts/: ${distinct} distinct (${texts.size} generator/seed instances); flagged by the AgentKit guardrails patterns: ${hits.length}`);
for (const [k] of hits) console.log(`  flagged: ${k}`);
console.log(`model requests in transcripts/: ${requests}; whose last message the filter would block: ${blockedRequests}`);
