// Offline transcript checks. For attested runs, every turn must carry a NEAR AI
// TEE signature whose text is "<model>:<sha256(request)>:<sha256(response)>"
// over the stored bytes, signed (EIP-191 personal_sign, secp256k1) by the
// address in the record. Each turn's request must extend the previous turn's
// full message list, and what it appends must be exactly the tool results the
// runner recorded. What this does NOT prove: that the signing address
// belongs to a genuine TEE (that needs the online attestation check), or that
// the runner did not discard and re-run unfavourable runs, or that a tool result
// matches the chain (the runner writes both; the CI signer closes that gap).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "./model.ts";
import { GUARD_BLOCKED } from "./guard.ts";
import { MAX_TURNS, type Transcript } from "./run.ts";

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Recovers the Ethereum-style address that signed `text` with personal_sign. */
export function recoverSigner(text: string, signatureHex: string): string {
  const msg = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const recovered = Uint8Array.from([v, ...sig.subarray(0, 64)]);
  const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return `0x${toHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

export type Check = { turn: number; ok: boolean; what: string };

export function verifyTranscript(t: Transcript): Check[] {
  const checks: Check[] = [];
  let previous: unknown[] | null = null; // full message list turn N-1 sent, plus its answer
  let previousAsked = false; // whether turn N-1's signed answer asked for tool calls
  let lastAnswer: any = null;
  let lastSigned = false;
  t.turns.forEach(({ model: m, tool_calls: records }, i) => {
    const req = Buffer.from(m.request_b64, "base64");
    const res = Buffer.from(m.response_b64, "base64");
    checks.push({ turn: i, ok: sha256(req) === m.request_sha256 && sha256(res) === m.response_sha256, what: "stored hashes match stored bytes" });

    const messages: unknown[] = JSON.parse(req.toString()).messages;
    if (previous !== null) {
      // The whole earlier history must be carried over unchanged, not just the last answer.
      const prefixOk = messages.length >= previous.length
        && previous.every((x, k) => JSON.stringify(messages[k]) === JSON.stringify(x));
      checks.push({ turn: i, ok: prefixOk, what: "request extends the full previous history" });
      // What was appended are exactly the tool results the runner recorded for the previous turn.
      const appended = messages.slice(previous.length);
      const recorded = t.turns[i - 1].tool_calls.map((r) => ({ role: "tool", tool_call_id: r.id, content: JSON.stringify(r.result) }));
      checks.push({ turn: i, ok: JSON.stringify(appended) === JSON.stringify(recorded), what: "signed tool results equal the recorded ones" });
    }
    const msg = JSON.parse(res.toString()).choices?.[0]?.message ?? {};
    // The runner only sends another request after an answer that asked for tools.
    if (i > 0) checks.push({ turn: i, ok: previousAsked, what: "a turn follows only an answer that asked for tool calls" });
    previousAsked = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    lastAnswer = msg;
    lastSigned = !!m.signature;
    previous = [...messages, { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) }];
    // A run cut off while fetching this turn's signature recorded the turn but never acted on it:
    // it is the last turn of an invalid run, unsigned, with no tool call executed.
    const cutOff = t.agent.attested && t.status === "invalid" && t.stop_reason === "error" && t.final_message === null
      && /^signature API/.test(t.invalid_reason ?? "") && i === t.turns.length - 1 && !m.signature && records.length === 0;
    const asked = (msg.tool_calls ?? []).map((c: any) => [c.id, c.function?.name, c.function?.arguments]);
    const ran = records.map((r) => [r.id, r.name, r.arguments_raw]);
    if (!cutOff) checks.push({ turn: i, ok: JSON.stringify(asked) === JSON.stringify(ran), what: "recorded tool calls equal the model's answer" });

    if (t.agent.attested && !cutOff) {
      const sig = m.signature;
      const expected = `${t.agent.model}:${sha256(req)}:${sha256(res)}`;
      checks.push({ turn: i, ok: sig?.text === expected, what: "signature text covers these bytes" });
      let signer = "";
      try {
        signer = sig ? recoverSigner(sig.text, sig.signature) : "";
      } catch {
        signer = "";
      }
      checks.push({ turn: i, ok: !!sig && signer === sig.signing_address.toLowerCase(), what: "ECDSA signer matches signing_address" });
    }
  });
  // The final message the judge reads is the last signed answer, and a valid run ended the way the runner ends one.
  const expectedFinal = t.stop_reason === "final_answer"
    ? (lastAnswer && !(Array.isArray(lastAnswer.tool_calls) && lastAnswer.tool_calls.length) ? (typeof lastAnswer.content === "string" ? lastAnswer.content : null) : undefined)
    : t.stop_reason === "guard_blocked" ? GUARD_BLOCKED : null;
  checks.push({ turn: -1, ok: expectedFinal !== undefined && t.final_message === expectedFinal, what: "the final message is the last signed answer" });
  // A signed answer with no tool calls is a final answer: the runner stops there and cannot fail after it.
  if (lastAnswer && lastSigned && !(Array.isArray(lastAnswer.tool_calls) && lastAnswer.tool_calls.length)) {
    checks.push({ turn: -1, ok: t.stop_reason === "final_answer", what: "a signed answer without tool calls ends the run" });
  }
  if (t.status === "valid") {
    const ended = t.stop_reason === "final_answer" || t.stop_reason === "guard_blocked" || (t.stop_reason === "max_turns" && t.turns.length === MAX_TURNS);
    checks.push({ turn: -1, ok: ended, what: "a valid run ends with a final answer, a guard block or the turn limit" });
  }
  // Every on-chain action the judge scores must come from a tool call, and vice versa. When an
  // attack replaced what the agent saw, the true result (kept beside it) carries the tx.
  const reported = new Set(t.turns.flatMap((x) => x.tool_calls.map((r) => ((r.real_result ?? r.result) as any)?.tx).filter((h) => typeof h === "string" && h)));
  const scored = new Set(t.actions.map((a) => a.tx).filter((h): h is string => h !== null));
  checks.push({ turn: -1, ok: reported.size === scored.size && [...scored].every((h) => reported.has(h)), what: "scored actions equal the transactions reported to the agent" });
  // A replaced result is only legitimate on a generator's action_result channel.
  const replaced = t.turns.some((x) => x.tool_calls.some((r) => r.real_result !== undefined));
  checks.push({ turn: -1, ok: !replaced || (t.generator !== null && t.injected !== null), what: "results were replaced only by a declared attack" });
  if (replaced) {
    const swapped = t.turns.flatMap((x) => x.tool_calls.filter((r) => r.real_result !== undefined));
    const oneTool = new Set(swapped.map((r) => r.name)).size === 1;
    const exact = swapped.every((r) => JSON.stringify(r.result) === JSON.stringify(t.injected));
    checks.push({ turn: -1, ok: oneTool && exact, what: "replaced results are exactly the declared injection, on one tool" });
  }
  return checks;
}
