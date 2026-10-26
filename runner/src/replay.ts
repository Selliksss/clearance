// Usage: tsx src/replay.ts [transcripts/<agent> ...]
// Offline, no keys, no sandbox. For every transcript:
//   - the verdict recomputed from its actions and final claim equals the stored one
//   - for attacks, the generator file in attacks/ still has the recorded hash and the
//     seed reproduces the recorded slot values (so the injected text is reproducible)
//   - verify.ts checks pass (hashes, history chaining, tool results, signatures)
// Exits non-zero on any mismatch.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenerator, resolveSlots } from "./attack.ts";
import { JUDGE_VERSION, judge, parseClaim } from "./loss.ts";
import type { Transcript } from "./run.ts";
import { canonical, sha256hex } from "./scenario.ts";
import { verifyTranscript } from "./verify.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(ROOT, "transcripts")).map((d) => join(ROOT, "transcripts", d)).filter((d) => statSync(d).isDirectory());

const genFiles = readdirSync(join(ROOT, "attacks")).filter((f) => f.endsWith(".json"));
let checked = 0;
let stale = 0;
const problems: string[] = [];

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const t: Transcript = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const where = `${dir.split("/").pop()}/${f}`;
    checked++;
    if (sha256hex(canonical(t.scenario)) !== t.scenario_sha256) problems.push(`${where}: embedded scenario does not match its hash`);

    if (t.env.judge_version === JUDGE_VERSION) {
      const again = judge(t.scenario, t.actions, parseClaim(t.final_message));
      if (canonical(again) !== canonical(t.verdict)) problems.push(`${where}: verdict differs on replay`);
    } else {
      stale++; // judged by an older rule; recorded as is, not re-scored silently
    }

    if (t.generator) {
      const file = genFiles.find((g) => g.startsWith(`${t.generator}.`) || g === `${t.generator}.json`);
      if (!file) {
        problems.push(`${where}: generator ${t.generator} not in attacks/`);
      } else {
        const { generator, sha256 } = loadGenerator(join(ROOT, "attacks", file), t.scenario);
        if (sha256 !== t.generator_sha256) {
          stale++;
        } else if (canonical(resolveSlots(generator, t.scenario, t.seed)) !== canonical(t.attack_slots)) {
          problems.push(`${where}: seed does not reproduce the recorded attack slots`);
        }
      }
    }

    for (const c of verifyTranscript(t)) if (!c.ok) problems.push(`${where}: turn ${c.turn}: ${c.what}`);
  }
}

console.log(`replayed ${checked} transcripts; ${stale} recorded under an older judge or generator version (kept as is)`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : "all reproducible");
process.exit(problems.length ? 1 : 0);
