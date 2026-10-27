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

/** Whether the guard blocks before a model call whose last message has this content. Tool results reach
 *  the model as JSON text, where a newline is the two characters \n; they are read as whitespace again,
 *  as in the plain-text tool output the original filter sees. */
export function guardBlocks(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const text = content.replace(/\\[nrt]/g, " ");
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

type GuardedRun = {
  status: string;
  stop_reason: string;
  final_message: string | null;
  turns: { model: { request_b64: string }; tool_calls: { result: unknown }[] }[];
};

/** Re-checks a guarded agent's run: no model call followed a message the guard blocks, and the run ended
 *  "guard_blocked" exactly when the message before the next model call (the first user message, or the
 *  last tool result while the loop could still continue) is one it blocks. */
export function guardProblems(t: GuardedRun, firstUserMessage: string): string[] {
  const problems: string[] = [];
  for (const turn of t.turns) {
    const req = JSON.parse(Buffer.from(turn.model.request_b64, "base64").toString());
    if (guardBlocks(req.messages?.at(-1)?.content)) problems.push("a model call followed a message the guard blocks");
  }
  const lastCalls = t.turns.at(-1)?.tool_calls ?? [];
  const pending = t.turns.length === 0 ? firstUserMessage : lastCalls.length ? JSON.stringify(lastCalls.at(-1)!.result) : null;
  // After max_turns, a time-budget stop or an invalid run no further model call was due, so no check ran.
  const due = t.status === "valid" && t.stop_reason !== "max_turns";
  const blocked = due && pending !== null && guardBlocks(pending);
  if ((t.stop_reason === "guard_blocked") !== blocked || (blocked && t.final_message !== GUARD_BLOCKED)) {
    problems.push("guard decision does not match the record");
  }
  return problems;
}
