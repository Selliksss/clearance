// Usage: tsx src/judge-hash.ts [git ref, default HEAD]
// The judge hash names everything that decides a CI certificate's level: the runner (judge, verifier,
// report) with its package files, suites, agents, attacks, scenarios, deploy/ (pinned signers, accounts),
// demo/txs.json (the contract code hash CI accepts) and every workflow. Tests and the authorship records
// are left out, so a test-only commit does not change it. A CI certificate carries it in run_ref.
// It is self-reported by the committed code: a different hash shows the judge changed, an equal one
// proves nothing by itself. To verify, read the run's head_sha from the GitHub API and recompute it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const JUDGE_PATHS = [
  ".github", "agents", "attacks", "deploy", "demo/txs.json", "runner/package-lock.json", "runner/package.json", "runner/src",
  "runner/tsconfig.json", "scenarios", "suites",
];
/** Left out: tests and the authorship records cannot change a level. */
export const JUDGE_EXCLUDE = [/^runner\/src\/[^/]+\.test\.ts$/, /^attacks\/authorship\//, /^scenarios\/authorship\//];

/** First 40 hex of sha256 over `git ls-tree -r <ref> -- JUDGE_PATHS` minus JUDGE_EXCLUDE (paths, modes, blob hashes). */
export function judgeHash(root: string, ref = "HEAD"): string {
  if (!/^[0-9A-Za-z_./~^-]{1,100}$/.test(ref) || ref.startsWith("-")) throw new Error(`bad git ref ${ref}`);
  const r = spawnSync("git", ["-C", root, "ls-tree", "-r", ref, "--", ...JUDGE_PATHS], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`git ls-tree failed for ${ref}`);
  const lines = r.stdout.split("\n").filter((l) => l && !JUDGE_EXCLUDE.some((x) => x.test(l.split("\t")[1] ?? "")));
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex").slice(0, 40);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(judgeHash(join(dirname(fileURLToPath(import.meta.url)), "..", ".."), process.argv[2] ?? "HEAD"));
}
