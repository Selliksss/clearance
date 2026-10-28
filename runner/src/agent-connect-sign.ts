// Owner-side signing for Agent Connect (NEAR Intents Agent API) owner intents, written from the
// byte formats in their published signing reference: nep413 (off-chain message) and nep366 (gasless
// delegate action), plus the grant credential. No code is copied from their repositories.
// Checked against their test vectors in agent-connect-sign.test.ts.
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, unbase58 } from "./base58.ts";

export type NearKey = { accountId: string; secret: Uint8Array; publicKey: Uint8Array };

/** A near-cli / near-api-js secret key "ed25519:<base58(seed32 || pub32)>". */
export function nearKey(accountId: string, secretKey: string): NearKey {
  if (!secretKey.startsWith("ed25519:")) throw new Error("only ed25519 keys");
  const raw = unbase58(secretKey.slice(8));
  if (raw.length !== 64) throw new Error("expected a 64-byte ed25519 secret key");
  const seed = raw.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (Buffer.compare(Buffer.from(publicKey), Buffer.from(raw.slice(32))) !== 0) throw new Error("secret key does not match its public half");
  return { accountId, secret: seed, publicKey };
}
export const publicKeyString = (k: NearKey) => `ed25519:${base58(k.publicKey)}`;

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const borshString = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };

/** nep413: sign { message, recipient, nonce(base64 32 bytes) }; returns the fields added to signed_data. */
export function signNep413(key: NearKey, payload: { message: string; recipient: string; nonce: string }) {
  const nonce = Buffer.from(payload.nonce, "base64");
  if (nonce.length !== 32) throw new Error("nep413 nonce must be 32 bytes");
  const tag = u32(2 ** 31 + 413);
  const body = Buffer.concat([borshString(payload.message), nonce, borshString(payload.recipient), Buffer.from([0])]);
  const sig = ed25519.sign(sha256(Buffer.concat([tag, body])), key.secret);
  return { public_key: publicKeyString(key), signature: Buffer.from(sig).toString("base64") };
}

type FunctionCall = { type: "FunctionCall"; params: { methodName: string; args: unknown; gas: string; deposit: string } };
export type DelegatePayload = { receiverId: string; actions: FunctionCall[] };

/** The borsh DelegateAction bytes. `args` must serialize exactly as JSON.stringify of the parsed response (key order kept). */
export function encodeDelegateAction(key: NearKey, payload: DelegatePayload, nonce: bigint, maxBlockHeight: bigint): Buffer {
  if (payload.actions.length < 1 || payload.actions.length > 2) throw new Error("1 or 2 actions");
  const actions = payload.actions.map((a) => {
    if (a.type !== "FunctionCall") throw new Error(`unsupported action ${a.type}`);
    const args = Buffer.from(JSON.stringify(a.params.args), "utf8");
    return Buffer.concat([Buffer.from([2]), borshString(a.params.methodName), u32(args.length), args, u64(BigInt(a.params.gas)), u128(BigInt(a.params.deposit))]);
  });
  return Buffer.concat([
    borshString(key.accountId), borshString(payload.receiverId), u32(actions.length), ...actions,
    u64(nonce), u64(maxBlockHeight), Buffer.from([0]), Buffer.from(key.publicKey),
  ]);
}

/** nep366: SignedDelegate = DelegateAction || 0x00 || sig, signed over sha256(NEP-461 prefix || DelegateAction). */
export function signNep366(key: NearKey, payload: DelegatePayload, accessKeyNonce: bigint, blockHeight: bigint) {
  const da = encodeDelegateAction(key, payload, accessKeyNonce + 1n, blockHeight + 120n);
  const sig = ed25519.sign(sha256(Buffer.concat([u32(2 ** 30 + 366), da])), key.secret);
  return { encoded: da, signed_delegate: Buffer.concat([da, Buffer.from([0]), Buffer.from(sig)]).toString("base64") };
}

/** A grant token and its commitment (sha256 hex of the token string). */
export function grantCredential(token = `ngt_${randomBytes(32).toString("base64url")}`) {
  return { token, commitment: createHash("sha256").update(token, "utf8").digest("hex") };
}
