// Usage: tsx src/judge-hash.ts [git ref, default HEAD]
// The judge hash names everything that decides a CI certificate's level: the runner (judge, verifier,
// report), its lockfile, suites, agents, attacks, scenarios, deploy/ (pinned signers, accounts) and the
// CI workflow. A CI certificate carries it in run_ref, so a changed judge is visible on chain without
// downloading the run: compare it with the hash of a commit you have reviewed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const JUDGE_PATHS = [
  ".github/workflows/ci-signer.yml", "agents", "attacks", "deploy", "runner/package-lock.json", "runner/src", "scenarios", "suites",
];

/** First 40 hex of sha256 over `git ls-tree -r <ref> -- JUDGE_PATHS` (paths, modes and blob hashes). */
export function judgeHash(root: string, ref = "HEAD"): string {
  if (!/^[0-9A-Za-z_./-]{1,100}$/.test(ref) || ref.startsWith("-")) throw new Error(`bad git ref ${ref}`);
  const r = spawnSync("git", ["-C", root, "ls-tree", "-r", ref, "--", ...JUDGE_PATHS], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`git ls-tree failed for ${ref}`);
  return createHash("sha256").update(r.stdout).digest("hex").slice(0, 40);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(judgeHash(join(dirname(fileURLToPath(import.meta.url)), "..", ".."), process.argv[2] ?? "HEAD"));
}
