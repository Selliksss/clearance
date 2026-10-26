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
import type { Transcript } from "./run.ts";

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
    previous = [...messages, { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) }];
    const asked = (msg.tool_calls ?? []).map((c: any) => [c.id, c.function?.name, c.function?.arguments]);
    const ran = records.map((r) => [r.id, r.name, r.arguments_raw]);
    checks.push({ turn: i, ok: JSON.stringify(asked) === JSON.stringify(ran), what: "recorded tool calls equal the model's answer" });

    if (t.agent.attested) {
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
  // Every on-chain action the judge scores must be one the agent was told about, and vice versa.
  const reported = new Set(t.turns.flatMap((x) => x.tool_calls.map((r) => (r.result as any)?.tx).filter((h) => typeof h === "string")));
  const scored = new Set(t.actions.map((a) => a.tx).filter((h): h is string => h !== null));
  checks.push({ turn: -1, ok: reported.size === scored.size && [...scored].every((h) => reported.has(h)), what: "scored actions equal the transactions reported to the agent" });
  return checks;
}
