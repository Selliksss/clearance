// Scenario and agent config files: loading, schema checks, placeholder filling.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const account = z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).max(64);
const decimal = z.string().regex(/^\d{1,9}(\.\d{1,24})?$/);

export const ScenarioSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  task: z.string().max(500),
  participants: z.record(z.string().regex(/^[a-z_]{1,20}$/), account),
  honest_invoice: z.strictObject({
    invoice_id: z.string().max(40), merchant: z.string().max(80), item: z.string().max(80),
    amount_near: decimal, memo: z.string().max(500),
  }).optional(),
  honest_price: z.strictObject({ pair: z.string().max(20), price: decimal, source: z.string().max(20) }).optional(),
  token_metadata: z.record(z.string(), z.unknown()).optional(),
  inbox: z.array(z.strictObject({ from: z.string().max(80), subject: z.string().max(200), body: z.string().max(2000) })).max(10).optional(),
  correct: z.discriminatedUnion("tool", [
    z.strictObject({ tool: z.literal("pay_invoice"), receiver: z.string(), amount_near_max: decimal }),
    z.strictObject({ tool: z.literal("transfer"), receiver: z.string(), amount_near_max: decimal }),
    z.strictObject({ tool: z.literal("swap"), amount_in_near_max: decimal, min_out_ge: decimal }),
  ]),
  honest_payment_near: decimal,
}).superRefine((s, ctx) => {
  if ("receiver" in s.correct && !(s.correct.receiver in s.participants)) {
    ctx.addIssue({ code: "custom", message: `correct.receiver ${s.correct.receiver} is not a participant` });
  }
  if (s.correct.tool === "swap" && !s.honest_price) ctx.addIssue({ code: "custom", message: "swap scenario needs honest_price" });
  if (s.correct.tool === "swap" && !s.participants.dex) ctx.addIssue({ code: "custom", message: "swap scenario needs a dex participant" });
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const AgentSchema = z.strictObject({
  model: z.string().max(80),
  endpoint: z.enum(["nearai", "openai"]),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.enum(["clearance-v1"]),
  system_prompt: z.string().max(8000),
});
export type AgentConfig = z.infer<typeof AgentSchema>;

/** Models served from NEAR AI Confidential TEE with per-response signatures. */
export const ATTESTED_MODELS = new Set(["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"]);

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (text.length > 16 * 1024) throw new Error(`${path} is larger than 16 KB`);
  return JSON.parse(text, (k, v) => {
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw new Error(`${path}: forbidden key ${k}`);
    return v;
  });
}

export function loadScenario(path: string): Scenario {
  return ScenarioSchema.parse(readJson(path));
}

export function loadAgent(path: string): AgentConfig {
  return AgentSchema.parse(readJson(path));
}

/** Replaces {role} with the participant account, single pass. */
export function fill(text: string, participants: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (m, role) => participants[role] ?? m);
}

/** RFC 8785 canonical JSON for the value shapes used here (objects, arrays, strings, finite numbers, booleans, null). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** config_hash = sha256(JCS({model, system_prompt, temperature, tools})); endpoint and keys excluded. */
export function configHash(a: AgentConfig): string {
  return sha256hex(canonical({ model: a.model, system_prompt: a.system_prompt, temperature: a.temperature, tools: a.tools }));
}
