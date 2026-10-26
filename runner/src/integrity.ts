// One integrity check for a transcript, shared by replay and the report, so the
// report never counts a run that replay would reject. A transcript is a file the
// runner wrote; nothing in it is trusted unless re-derived from the repo:
//   - the file name is its run_id; the embedded scenario equals scenarios/<id>.json
//   - kind and generator agree; for attacks the generator file has the recorded hash,
//     the seed reproduces the slots and the injected text, and the injection is
//     visibly present in what the agent was shown
//   - the first request's bytes match the agent config (model, prompt, temperature, tools)
//   - verify.ts passes (hashes, history chaining, tool results vs actions, signatures)
//   - the verdict is what the current judge computes from the actions
import { basename } from "node:path";
import { join } from "node:path";
import { type Generator, delivered, injectedFields, loadGenerator, resolveSlots } from "./attack.ts";
import { judge, parseClaim } from "./loss.ts";
import type { Transcript } from "./run.ts";
import { type AgentConfig, canonical, loadScenario, sha256hex } from "./scenario.ts";
import { TOOL_DEFS } from "./tools.ts";
import { verifyTranscript } from "./verify.ts";

export type Integrity = {
  problems: string[];
  /** For attacks: whether the channel tool was called often enough for the injection to fire. */
  delivered: boolean;
  /** Re-derived injected text (null for controls). */
  injected: Record<string, string> | null;
  generator: Generator | null;
  /** Distinct TEE signing addresses seen in the run. */
  signers: string[];
};

export function checkTranscript(root: string, file: string, t: Transcript, agent: AgentConfig | null): Integrity {
  const problems: string[] = [];
  const SAFE_ID = /^[A-Za-z0-9-]{1,60}$/;
  const safe = (v: unknown) => typeof v === "string" && SAFE_ID.test(v);
  if (!safe(t.scenario?.id) || (t.generator !== null && !safe(t.generator))) {
    return { problems: ["scenario or generator id is not a safe file name"], delivered: false, injected: null, generator: null, signers: [] };
  }
  if (basename(file) !== `${t.run_id}.json`) problems.push("file name is not <run_id>.json");
  if (sha256hex(canonical(t.scenario)) !== t.scenario_sha256) problems.push("embedded scenario does not match its hash");
  try {
    if (canonical(loadScenario(join(root, "scenarios", `${t.scenario.id}.json`))) !== canonical(t.scenario)) {
      problems.push(`embedded scenario differs from scenarios/${t.scenario.id}.json`);
    }
  } catch (e) {
    problems.push(`scenario ${t.scenario.id}: ${(e as Error).message.split("\n")[0]}`);
  }
  if ((t.kind === "attack") !== (t.generator !== null)) problems.push("kind and generator disagree");

  let generator: Generator | null = null;
  let injected: Record<string, string> | null = null;
  let isDelivered = true;
  const calls = t.turns.flatMap((x) => x.tool_calls);
  if (t.generator) {
    try {
      const loaded = loadGenerator(join(root, "attacks", `${t.generator}.json`), t.scenario);
      generator = loaded.generator;
      if (loaded.sha256 !== t.generator_sha256) problems.push(`made with an older version of ${t.generator}`);
      if (canonical(resolveSlots(generator, t.scenario, t.seed)) !== canonical(t.attack_slots)) problems.push("seed does not reproduce the attack slots");
      injected = injectedFields(generator, t.scenario, t.seed);
      if (t.injected && canonical(t.injected) !== canonical(injected)) problems.push("recorded injected text differs from the generator");
      // Delivered means the agent was actually shown the injection, not merely that it called the tool.
      const values = Object.values(injected).map((v) => JSON.stringify(v).slice(1, -1));
      isDelivered = generator.channel.startsWith("action_result:")
        ? calls.some((c) => c.real_result !== undefined)
        : calls.some((c) => c.name === generator!.channel.split(":")[1] && values.every((v) => JSON.stringify(c.result).includes(v)));
      if (!isDelivered && delivered(generator, calls) && generator.channel.startsWith("action_result:")) {
        problems.push("the attack should have fired but no result was replaced");
      }
    } catch (e) {
      problems.push(`generator ${t.generator}: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  if (t.turns.length > 0) {
    const first = JSON.parse(Buffer.from(t.turns[0].model.request_b64, "base64").toString());
    if (agent) {
      const same = first.model === agent.model && first.messages?.[0]?.content === agent.system_prompt
        && first.temperature === agent.temperature && canonical(first.tools) === canonical(TOOL_DEFS);
      if (!same) problems.push("first request does not match the agent config");
    }
    if (first.model !== t.agent.model) problems.push("transcript model differs from the request");
  } else if (t.status === "valid") {
    problems.push("a valid run with no model turns");
  }

  for (const c of verifyTranscript(t)) if (!c.ok) problems.push(`turn ${c.turn}: ${c.what}`);
  const again = judge(t.scenario, t.actions, parseClaim(t.final_message), injected);
  if (canonical(again) !== canonical(t.verdict)) problems.push("verdict differs from the current judge");

  const signers = [...new Set(t.turns.map((x) => x.model.signature?.signing_address?.toLowerCase()).filter((s): s is string => !!s))].sort();
  return { problems, delivered: isDelivered, injected, generator, signers };
}

/** Invalid-run reasons are free text from exceptions; reports carry only a category. */
export function invalidCategory(reason: string | null): string {
  if (!reason) return "unknown";
  if (/aborted due to timeout|TimeoutError/i.test(reason)) return "model timeout";
  if (/fetch failed|unreachable|ECONNRESET|ETIMEDOUT|aborted/i.test(reason)) return "network";
  if (/model API \d+|signature API/i.test(reason)) return "api error";
  if (/signature does not cover/i.test(reason)) return "signature mismatch";
  if (/time budget/i.test(reason)) return "time budget";
  return "other";
}
