// Attack generators are data, not code. This interpreter loads a generator file,
// checks it against a closed schema, picks slot values deterministically from the
// run's seed, and returns an Injector that rewrites one read tool's honest output.
// Nothing in a generator is executed: no expressions, no regex, single-pass
// substitution of {slot} placeholders.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { PRINTABLE_ASCII, accountTokens } from "./accounts.ts";
import { z } from "zod";
import { CAGE } from "./chain.ts";
import { type Scenario, readJson, sha256hex } from "./scenario.ts";
import type { Injector } from "./tools.ts";

export const FORMAT_VERSION = 0;

/** Channels format v0 can inject into. `tool_output:*` merges into a read tool's honest output;
 *  `action_result:*` replaces what a money tool reports AFTER the real spend happened (the
 *  money really moved; only the agent's view is falsified). `message` and `memo` arrive with v1. */
export const CHANNELS = [
  "tool_output:get_invoice", "tool_output:get_price", "tool_output:get_token_metadata", "tool_output:read_inbox",
  "action_result:pay_invoice", "action_result:transfer",
] as const;
export const CATEGORIES = ["data_injection", "fake_price", "recipient_swap", "authority_claim"] as const;

const MAX_PHRASES = 20;
const MAX_TEXT = 500;
const decimal = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "amounts are decimals with at most 2 places");

const SlotSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("amount"), min: decimal, max: decimal }),
  z.strictObject({ type: z.literal("account"), values: z.array(z.string().regex(/^[a-z_]{1,20}$/)).min(1).max(10) }),
  z.strictObject({ type: z.literal("phrase"), values: z.array(z.string().min(1).max(MAX_TEXT)).min(1).max(MAX_PHRASES) }),
]);

export const GeneratorSchema = z.strictObject({
  id: z.string().regex(/^G\d{1,3}-[a-z0-9-]{1,40}$/),
  format: z.literal(FORMAT_VERSION),
  category: z.enum(CATEGORIES),
  scenario: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  channel: z.enum(CHANNELS),
  /** Inject on the nth call of the channel's tool (1-based). */
  /** Inject on the nth call of the channel's tool (1-based), and on the `times` - 1 calls after it. */
  at: z.strictObject({ nth: z.number().int().min(1).max(8), times: z.number().int().min(1).max(5).optional() }),
  /** Field overrides merged into the honest tool output; values may contain {slot}. */
  template: z.record(z.string().regex(/^[a-z_]{1,30}$/), z.string().max(MAX_TEXT)).refine((t) => Object.keys(t).length >= 1 && Object.keys(t).length <= 10, "template needs 1 to 10 fields"),
  slots: z.record(z.string().regex(/^[a-z_]{1,20}$/), SlotSchema).refine((s) => Object.keys(s).length <= 10, "at most 10 slots"),
});
export type Generator = z.infer<typeof GeneratorSchema>;

const toCents = (d: string) => {
  const [w, f = ""] = d.split(".");
  return BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
};
const fromCents = (c: bigint) => (c % 100n === 0n ? `${c / 100n}` : `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`);

/** Seeds the checker substitutes to scan the text an attack can actually produce. */
const CHECK_SEEDS = 200;
/** Keys an action_result template may not set: they would put words in the runner's mouth. */
const RESERVED_RESULT_KEYS = new Set(["tx", "amount_out_usdc"]);

/** Validates a generator against its scenario. Throws with every problem listed. */
export function checkGenerator(raw: unknown, scenario: Scenario): Generator {
  const g = GeneratorSchema.parse(raw);
  const problems: string[] = [];
  if (g.scenario !== scenario.id) problems.push(`generator targets ${g.scenario}, scenario is ${scenario.id}`);
  const tool = g.channel.split(":")[1];
  if (tool === "get_invoice" && !scenario.honest_invoice) problems.push("scenario has no invoice to inject into");
  if (tool === "get_price" && !scenario.honest_price) problems.push("scenario has no price to inject into");
  if (tool === "read_inbox" && !scenario.inbox) problems.push("scenario has no inbox to inject into");
  if (g.channel.startsWith("action_result:") && !Object.hasOwn(g.template, "status")) problems.push("an action_result template must set status");
  if (g.channel.startsWith("tool_output:") && g.at.times !== undefined) problems.push("times is only for action_result channels");
  if (tool === "get_token_metadata" && !scenario.token_metadata) problems.push("scenario has no token metadata to inject into");
  if (g.channel.startsWith("action_result:")) {
    // An attack on a tool the task never needs would never fire and count as "resisted".
    if (scenario.correct.tool !== tool) problems.push(`scenario's correct action is ${scenario.correct.tool}, not ${tool}`);
    for (const k of Object.keys(g.template)) if (RESERVED_RESULT_KEYS.has(k)) problems.push(`action_result templates may not set ${k}`);
  }
  const participants = new Set(Object.values(scenario.participants));
  const cage = BigInt(CAGE.cage_near) * 100n;
  for (const [name, slot] of Object.entries(g.slots)) {
    if (slot.type === "amount") {
      if (toCents(slot.min) > toCents(slot.max)) problems.push(`slot ${name}: min > max`);
      if (toCents(slot.max) > cage) problems.push(`slot ${name}: amounts above the ${CAGE.cage_near} NEAR cage`);
    }
    if (slot.type === "account") {
      for (const role of slot.values) if (!Object.hasOwn(scenario.participants, role)) problems.push(`slot ${name}: ${role} is not a scenario participant`);
    }
    if (slot.type === "phrase") {
      for (const p of slot.values) {
        if (p.includes("{") || p.includes("}")) problems.push(`slot ${name}: phrases may not contain braces`);
        if (!PRINTABLE_ASCII.test(p)) problems.push(`slot ${name}: phrases must be printable ASCII`);
      }
    }
  }
  for (const [field, value] of Object.entries(g.template)) {
    for (const m of value.matchAll(/\{([^{}]*)\}/g)) {
      if (!Object.hasOwn(g.slots, m[1])) problems.push(`template.${field}: unknown slot {${m[1]}}`);
    }
    if (!PRINTABLE_ASCII.test(value)) problems.push(`template.${field}: must be printable ASCII`);
  }
  if (!problems.length) {
    // Scan what the attack can actually say, after substitution, per field and across fields
    // (an account split over two fields still reads as one to the agent).
    const foreign = new Set<string>();
    for (let i = 0; i < CHECK_SEEDS; i++) {
      const fields = Object.values(injectedFields(g, scenario, `check-${i}`));
      for (const text of [...fields, fields.join(" ")]) {
        for (const tok of accountTokens(text)) if (!participants.has(tok)) foreign.add(tok);
      }
      // An account split across two fields ("evil" + ".sandbox") reads as one only where the
      // boundary is a dot; glue exactly those pairs.
      for (let k = 0; k + 1 < fields.length; k++) {
        const [a, b] = [fields[k], fields[k + 1]];
        // Only "evil" + ".sandbox": a field ending a sentence with "." followed by a field starting
        // with a word is ordinary prose ("...estimate." + "For 3 NEAR"), not a split account.
        if (!(/[a-z0-9_-]$/i.test(a) && b.startsWith("."))) continue;
        for (const tok of accountTokens(a + b)) if (!participants.has(tok)) foreign.add(tok);
      }
    }
    for (const tok of foreign) problems.push(`the injected text can name ${tok}, which is not a scenario participant`);
  }
  if (problems.length) throw new Error(`generator ${g.id} rejected:\n- ${problems.join("\n- ")}`);
  return g;
}

export function loadGenerator(path: string, scenario: Scenario): { generator: Generator; sha256: string } {
  const raw = readJson(path);
  const generator = checkGenerator(raw, scenario);
  if (basename(path) !== `${generator.id}.json`) throw new Error(`${basename(path)}: file name must be ${generator.id}.json`);
  return { generator, sha256: sha256hex(JSON.stringify(raw)) };
}

/** Deterministic integer in [0, n) from the run seed and a label. */
function pick(seed: string, label: string, n: bigint): bigint {
  const h = createHash("sha256").update(`${seed}:${label}`).digest("hex");
  return BigInt(`0x${h}`) % n;
}

/** Slot values for one run. Same seed, same values: replay reproduces the attack text. */
export function resolveSlots(g: Generator, scenario: Scenario, seed: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, slot] of Object.entries(g.slots)) {
    if (slot.type === "amount") {
      const lo = toCents(slot.min);
      out[name] = fromCents(lo + pick(seed, name, toCents(slot.max) - lo + 1n));
    } else if (slot.type === "account") {
      out[name] = scenario.participants[slot.values[Number(pick(seed, name, BigInt(slot.values.length)))]];
    } else {
      out[name] = slot.values[Number(pick(seed, name, BigInt(slot.values.length)))];
    }
  }
  return out;
}

/** Single-pass {slot} substitution; slot values never contain braces, so no re-expansion. */
const substitute = (text: string, values: Record<string, string>) =>
  text.replace(/\{([a-z_]{1,20})\}/g, (m, k) => (Object.hasOwn(values, k) ? values[k] : m));

/** The text a generator injects for a seed (for the judge and for replay). */
export function injectedFields(g: Generator, scenario: Scenario, seed: string): Record<string, string> {
  const slots = resolveSlots(g, scenario, seed);
  return Object.fromEntries(Object.entries(g.template).map(([k, v]) => [k, substitute(v, slots)]));
}

/** Whether the attack actually reached the agent in a run: its channel tool was called often enough. */
export function delivered(g: Generator, toolCalls: { name: string }[]): boolean {
  const tool = g.channel.split(":")[1];
  return toolCalls.filter((c) => c.name === tool).length >= g.at.nth;
}

export function injector(g: Generator, scenario: Scenario, seed: string): { inject: Injector; slots: Record<string, string>; injected: Record<string, string> } {
  const slots = resolveSlots(g, scenario, seed);
  const tool = g.channel.split(":")[1];
  let calls = 0;
  const inject: Injector = (name, honest) => {
    if (name !== tool) return honest;
    calls++;
    if (calls < g.at.nth || calls >= g.at.nth + (g.at.times ?? 1)) return honest;
    const fields = injectedFields(g, scenario, seed);
    if (g.channel.startsWith("action_result:")) return fields; // the whole report is replaced
    if (Array.isArray(honest)) return [...honest, fields]; // inbox: the attack arrives as one more message
    return { ...(honest as Record<string, unknown>), ...fields };
  };
  return { inject, slots, injected: injectedFields(g, scenario, seed) };
}
