// Offline transcript checks. For attested runs, every turn must carry a NEAR AI
// TEE signature whose text is "<model>:<sha256(request)>:<sha256(response)>"
// over the stored bytes, signed (EIP-191 personal_sign, secp256k1) by the
// address in the record, and each turn's request must contain the previous
// turn's assistant message. What this does NOT prove: that the signing address
// belongs to a genuine TEE (that needs the online attestation check), or that
// the runner did not discard and re-run unfavourable runs.
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
  let previousAssistant: unknown = null;
  t.turns.forEach(({ model: m }, i) => {
    const req = Buffer.from(m.request_b64, "base64");
    const res = Buffer.from(m.response_b64, "base64");
    checks.push({ turn: i, ok: sha256(req) === m.request_sha256 && sha256(res) === m.response_sha256, what: "stored hashes match stored bytes" });

    const body = JSON.parse(req.toString());
    if (previousAssistant !== null) {
      const echoed = body.messages.filter((x: any) => x.role === "assistant").at(-1);
      checks.push({ turn: i, ok: JSON.stringify(echoed) === JSON.stringify(previousAssistant), what: "request carries the previous answer" });
    }
    const msg = JSON.parse(res.toString()).choices?.[0]?.message ?? {};
    previousAssistant = { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) };

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
  return checks;
}
