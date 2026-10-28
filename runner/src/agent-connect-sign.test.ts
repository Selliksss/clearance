import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeDelegateAction, grantCredential, nearKey, publicKeyString, signNep366, signNep413 } from "./agent-connect-sign.ts";

// Their published test vectors (NEAR-Intents-Agent-API/skills assets/test-vectors.json) are not
// vendored (no license); set AGENT_CONNECT_VECTORS to a local copy to check against them.
const file = process.env.AGENT_CONNECT_VECTORS;
describe.skipIf(!file || !existsSync(file))("Agent Connect owner signing matches the published test vectors", () => {
  const v = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  it("key, nep413, nep366 and the grant commitment", () => {
    const k = nearKey(v.near.account_id, v.near.secret);
    expect(publicKeyString(k)).toBe(v.near.public_key);
    expect(signNep413(k, v.nep413.payload).signature).toBe(v.nep413.signature_b64);
    const nonce = BigInt(v.nep366.access_key_nonce), height = BigInt(v.nep366.block_height);
    const tag = Buffer.from([0x6e, 0x01, 0x00, 0x40]);
    const enc = Buffer.concat([tag, encodeDelegateAction(k, v.nep366.payload, nonce + 1n, height + 120n)]).toString("hex");
    expect(enc).toBe(v.nep366.encoded_hex);
    expect(signNep366(k, v.nep366.payload, nonce, height).signed_delegate).toBe(v.nep366.signed_delegate);
    expect(grantCredential(v.grant.token).commitment).toBe(v.grant.commitment);
  });
});

describe("Agent Connect signing basics", () => {
  it("refuses a secret key whose halves do not match", () => {
    expect(() => nearKey("a.near", `ed25519:${"1".repeat(10)}`)).toThrow();
  });
  it("grant tokens are fresh and 47 characters", () => {
    const a = grantCredential(), b = grantCredential();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(47);
    expect(a.commitment).toMatch(/^[0-9a-f]{64}$/);
  });
});
