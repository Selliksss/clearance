import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciReport } from "./report.ts";

const root = new URL("../../", import.meta.url).pathname;
const fixture = new URL("../tests/fixtures/protected-S1-control.json", import.meta.url).pathname;
const t = JSON.parse(readFileSync(fixture, "utf8"));

function runDir(slots: object[], mode = "full", extraFile = false) {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  copyFileSync(fixture, join(dir, `${t.run_id}.json`));
  if (extraFile) copyFileSync(fixture, join(dir, "00000000-0000-0000-0000-000000000000.json"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: 1, ci_run_id: "1", sha: "x", agent: "protected-v1", mode, seeds: 1, slots }));
  return dir;
}
const written = { kind: "control", id: "S1-invoice", i: 0, status: "written", run_id: t.run_id };

describe("ciReport", () => {
  it("a smoke run never certifies", () => {
    const r = ciReport(root, "protected-v1", runDir([written], "smoke"));
    expect(r.level).toBe(0);
    expect(r.insufficient).toContain("smoke run: never certifies");
  });
  it("a planned slot without a transcript forces level 0 and is listed", () => {
    const r = ciReport(root, "protected-v1", runDir([written, { kind: "attack", id: "G1-invoice-inflate", i: 0, status: "setup_failed", category: "network" }]));
    expect(r.level).toBe(0);
    expect(r.ci.missing).toEqual(["attack:G1-invoice-inflate#0:setup_failed(network)"]);
  });
  it("a transcript that is not in the manifest forces level 0", () => {
    const r = ciReport(root, "protected-v1", runDir([written], "full", true));
    expect(r.ci.extra).toHaveLength(1);
    expect(r.level).toBe(0);
  });
  it("a manifest for another agent is refused", () => {
    expect(() => ciReport(root, "naive", runDir([written]))).toThrow(/manifest is for/);
  });
});

describe("certify-ci guards", () => {
  it("run_ref must be run:<digits>@<40 hex>;judge:<40 hex>", async () => {
    const { RUN_REF_RE } = await import("./certify-ci.ts");
    expect(RUN_REF_RE.test(`run:123@${"a".repeat(40)};judge:${"b".repeat(40)}`)).toBe(true);
    expect(RUN_REF_RE.test(`run:123@${"a".repeat(40)}`)).toBe(false);
    expect(RUN_REF_RE.test("run:abc@HEAD")).toBe(false);
  });
  it("the artifact may only hold transcripts and the manifest", async () => {
    const { checkArtifact } = await import("./certify-ci.ts");
    const dir = runDir([written]);
    expect(() => checkArtifact(dir)).not.toThrow();
    writeFileSync(join(dir, "evil.sh"), "#!/bin/sh");
    expect(() => checkArtifact(dir)).toThrow(/unexpected artifact file/);
  });
});

describe("TEE signer allowlist", () => {
  const root = join(import.meta.dirname, "..", "..");
  const v3 = JSON.parse(readFileSync(join(root, "reports", "protected-v3.json"), "utf8"));
  it("the certified protected-v3 report passes", async () => {
    const { checkTeeSigners } = await import("./certify.ts");
    expect(() => checkTeeSigners(root, v3)).not.toThrow();
  });
  it("an unpinned or missing signer is refused for Attested", async () => {
    const { checkTeeSigners } = await import("./certify.ts");
    expect(() => checkTeeSigners(root, { ...v3, tee_signers: ["0x" + "1".repeat(40)] })).toThrow(/not all pinned/);
    expect(() => checkTeeSigners(root, { ...v3, tee_signers: [] })).toThrow(/not all pinned/);
    expect(() => checkTeeSigners(root, { ...v3, model: "other/model" })).toThrow(/not all pinned/);
  });
  it("non-Attested reports are not checked", async () => {
    const { checkTeeSigners } = await import("./certify.ts");
    expect(() => checkTeeSigners(root, { ...v3, endpoint_class: "Allowlist", tee_signers: [] })).not.toThrow();
  });
});

describe("earlier run history", () => {
  const run = (id: number, title: string, conclusion = "failure", branch = "main") =>
    ({ id, display_title: title, conclusion, status: "completed", head_branch: branch });
  it("pages through the whole history and hides only smoke runs on main", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const { earlierRuns } = await import("./certify-ci.ts");
    const all = [run(9, "ci-signer protected-v3 full", "success"), ...Array.from({ length: 120 }, (_, i) => run(100 + i, "ci-signer protected-v3 smoke")),
      run(5, "ci-signer protected-v3 full"), run(4, "ci-signer protected-v3 smoke", "success", "evil"), run(3, "ci-signer")];
    const get = async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return { total_count: all.length, workflow_runs: all.slice((page - 1) * 100, page * 100) };
    };
    expect(await earlierRuns("9", get)).toBe("5:failure:main:full,4:success:evil:smoke,3:failure:main:ci-signer");
  });
  it("an incomplete or unreadable history is null", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const { earlierRuns } = await import("./certify-ci.ts");
    expect(await earlierRuns("1", async () => ({ total_count: 300, workflow_runs: [] }))).toBeNull();
    expect(await earlierRuns("1", async () => null)).toBeNull();
  });
});

describe("transcript ids", () => {
  it("an id that is not a safe file name stops the integrity check", async () => {
    const { checkTranscript } = await import("./integrity.ts");
    const root = join(import.meta.dirname, "..", "..");
    for (const t of [{ scenario: { id: "../x" }, generator: null }, { generator: null }, { scenario: { id: "G1" }, generator: "a/b" }]) {
      expect(checkTranscript(root, "x.json", t as never, null).problems).toEqual(["scenario or generator id is not a safe file name"]);
    }
  });
});

describe("a run that acted and fails integrity", () => {
  it("forces level 0 instead of being dropped", async () => {
    const { buildReport } = await import("./report.ts");
    const { readdirSync } = await import("node:fs");
    const root = join(import.meta.dirname, "..", "..");
    const src = join(root, "transcripts", "protected-v3");
    const dir = mkdtempSync(join(tmpdir(), "acted-"));
    let tampered = false;
    for (const f of readdirSync(src).filter((x) => x.endsWith(".json"))) {
      const t = JSON.parse(readFileSync(join(src, f), "utf8"));
      if (!tampered && t.actions.length > 0 && t.status === "valid" && /^G[1-8]-/.test(t.generator ?? "")) {
        t.turns[0].model.response_sha256 = "0".repeat(64);
        tampered = true;
      }
      writeFileSync(join(dir, f), JSON.stringify(t));
    }
    expect(tampered).toBe(true);
    const r = buildReport(root, "protected-v3", 1, { dir });
    expect(r.selection.excluded.some((e) => e.reason.startsWith("integrity (run acted)"))).toBe(true);
    expect(r.level).toBe(0);
  });
});

describe("judge hash", () => {
  const root = join(import.meta.dirname, "..", "..");
  const haveHistory = spawnSync("git", ["-C", root, "cat-file", "-e", "a6a6f6e^{commit}"]).status === 0;
  it.skipIf(!haveHistory)("is stable for a commit and changes only with the judge paths", async () => {
    const { judgeHash } = await import("./judge-hash.ts");
    // c3ae12a only touched README.md after a6a6f6e changed the runner.
    expect(judgeHash(root, "c3ae12a")).toBe(judgeHash(root, "85aebc3"));
    expect(judgeHash(root, "85aebc3")).not.toBe(judgeHash(root, "a6a6f6e"));
    expect(judgeHash(root, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(() => judgeHash(root, "--output=x")).toThrow(/bad git ref/);
  });
  it("ignores test files and covers demo/txs.json and every workflow", async () => {
    const { JUDGE_PATHS } = await import("./judge-hash.ts");
    const { JUDGE_EXCLUDE } = await import("./judge-hash.ts");
    expect(JUDGE_PATHS).toEqual(expect.arrayContaining(["demo/txs.json", ".github"]));
    expect(JUDGE_EXCLUDE.some((x) => x.test("runner/src/ci.test.ts"))).toBe(true);
    expect(JUDGE_EXCLUDE.some((x) => x.test("runner/src/report.ts"))).toBe(false);
  });
});
