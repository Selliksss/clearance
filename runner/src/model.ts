// OpenAI-compatible chat completions through our own fetch. The exact request
// and response bytes are kept: a NEAR AI TEE signature covers
// "<model>:<sha256(request)>:<sha256(response)>", so any re-serialisation by an
// SDK would make every signature unverifiable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Endpoints the runner's own keys may be sent to. */
export const ENDPOINTS = {
  nearai: { base: "https://cloud-api.near.ai/v1", keyVar: "NEARAI_API_KEY" },
  openai: { base: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY" },
} as const;
export type EndpointName = keyof typeof ENDPOINTS;

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 120_000;

export type SignatureRecord = {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
};

export type ModelTurn = {
  endpoint: EndpointName;
  request_b64: string;
  response_b64: string;
  request_sha256: string;
  response_sha256: string;
  response_model: string;
  completion_id: string;
  started_at: string;
  latency_ms: number;
  signature: SignatureRecord | null;
};

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let keys: Record<string, string> | null = null;
function key(name: string): string {
  keys ??= Object.fromEntries(
    readFileSync(`${homedir()}/.config/dopusk/.env`, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const v = keys[name];
  if (!v) throw new Error(`${name} is not set in ~/.config/dopusk/.env`);
  return v;
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`model response larger than ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** One chat completion. `body` is serialised once and those bytes are what is sent and stored. */
export async function complete(endpoint: EndpointName, body: Record<string, unknown>): Promise<{ turn: ModelTurn; json: any }> {
  const { base, keyVar } = ENDPOINTS[endpoint];
  const request = Buffer.from(JSON.stringify(body));
  const started = new Date();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key(keyVar)}` },
    body: request,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const response = await readCapped(res);
  if (!res.ok) throw new Error(`model API ${res.status}: ${Buffer.from(response).toString().slice(0, 300)}`);
  const json = JSON.parse(Buffer.from(response).toString());
  const requested = String(body.model);
  const got = String(json.model ?? "");
  // The gateway may answer with a dated or unprefixed id; anything else is a substitution.
  if (!(got.startsWith(requested) || got.startsWith(requested.split("/").pop()!))) {
    throw new Error(`model mismatch: asked ${requested}, got ${got}`);
  }
  return {
    json,
    turn: {
      endpoint,
      request_b64: request.toString("base64"),
      response_b64: Buffer.from(response).toString("base64"),
      request_sha256: sha256(request),
      response_sha256: sha256(response),
      response_model: got,
      completion_id: String(json.id),
      started_at: started.toISOString(),
      latency_ms: Date.now() - started.getTime(),
      signature: null,
    },
  };
}

/** Fetches the TEE signature record for a NEAR AI completion (attested models only). */
export async function fetchSignature(completionId: string, model: string): Promise<SignatureRecord> {
  const url = `${ENDPOINTS.nearai.base}/signature/${encodeURIComponent(completionId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key(ENDPOINTS.nearai.keyVar)}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`signature API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as SignatureRecord;
}

/** Offline check that a signature's text covers exactly these bytes. ECDSA recovery is separate. */
export function signatureCoversTurn(turn: ModelTurn, model: string): boolean {
  const sig = turn.signature;
  if (!sig) return false;
  return sig.text === `${model}:${turn.request_sha256}:${turn.response_sha256}`;
}
