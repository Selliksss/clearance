// Usage: tsx src/guardrail-patterns.ts
// Static check, no model calls: would the prompt-injection filter of Coinbase AgentKit's
// langchain-guardrails-cdp-chatbot example (typescript/examples/langchain-guardrails-cdp-chatbot/chatbot.ts,
// commit f2f3e8c1, Apache-2.0; the 11 patterns below are copied from it unchanged) have flagged any
// attack text recorded in transcripts/? The filter runs before each model call on the last message,
// which can be a tool result, so attack texts are exactly what it would see.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTION_PATTERNS } from "./guard.ts";



const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "transcripts");
const texts = new Map<string, string>();
for (const d of readdirSync(base).filter((x) => x !== "archive" && statSync(join(base, x)).isDirectory())) {
  for (const f of readdirSync(join(base, d)).filter((x) => x.endsWith(".json"))) {
    const t = JSON.parse(readFileSync(join(base, d, f), "utf8")) as { generator: string | null; seed: string; injected: Record<string, string> | null };
    if (t.generator && t.injected) texts.set(`${t.generator}#${t.seed}`, Object.values(t.injected).join("\n"));
  }
}
const hits = [...texts].filter(([, text]) => INJECTION_PATTERNS.some((p) => p.test(text)));
const distinct = new Set(texts.values()).size;
console.log(`attack texts in transcripts/: ${distinct} distinct (${texts.size} generator/seed instances); flagged by the AgentKit guardrails patterns: ${hits.length}`);
for (const [k] of hits) console.log(`  flagged: ${k}`);
