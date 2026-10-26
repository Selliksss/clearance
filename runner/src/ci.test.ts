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
