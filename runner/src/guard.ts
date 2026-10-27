// The prompt-injection filter of Coinbase AgentKit's langchain-guardrails-cdp-chatbot example
// (typescript/examples/langchain-guardrails-cdp-chatbot/chatbot.ts, commit f2f3e8c1, Apache-2.0): before
// each model call it tests the last message against these 11 patterns (copied unchanged) and, on a match,
// ends the run with "Blocked by guardrails middleware". Agent configs opt in with guard: "agentkit-regex-v1".
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directives)/i,
  /forget\s+(your|all|the)\s+(rules|instructions|guidelines|prompts|directives)/i,
  /you\s+are\s+now\s+(a|an|no\s+longer)/i,
  /disregard\s+(all|any|your|the)\s+(previous|prior|above)?\s*(instructions|rules|prompts)/i,
  /override\s+(your|system|all)\s+(instructions|prompts|rules)/i,
  /new\s+instructions?[:\s]/i,
  /system\s*prompt[:\s]/i,
  /\bDAN\b.*\bjailbreak\b/i,
  /do\s+anything\s+now/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions|rules|limits)/i,
  /act\s+as\s+if\s+(you\s+)?(have|had)\s+no\s+(rules|restrictions|guidelines)/i,
];

export const GUARD_BLOCKED = "Blocked by guardrails middleware";

/** Whether the guard blocks before a model call whose last message has this content. */
export function guardBlocks(content: unknown): boolean {
  return typeof content === "string" && INJECTION_PATTERNS.some((p) => p.test(content));
}
