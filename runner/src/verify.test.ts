import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Transcript } from "./run.ts";
import { verifyTranscript } from "./verify.ts";

const load = (): Transcript => JSON.parse(readFileSync(new URL("../tests/fixtures/protected-S1-control.json", import.meta.url), "utf8"));

describe("verifyTranscript (recorded GLM run in NEAR AI TEE)", () => {
  it("every check passes on the untouched transcript", () => {
    const checks = verifyTranscript(load());
    expect(checks.length).toBeGreaterThan(6);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("one changed byte in a stored response breaks that turn", () => {
    const t = load();
    const res = Buffer.from(t.turns[1].model.response_b64, "base64");
    res[res.length - 5] ^= 1;
    t.turns[1].model.response_b64 = res.toString("base64");
    const failed = verifyTranscript(t).filter((c) => !c.ok);
    expect(failed.some((c) => c.turn === 1 && c.what === "signature text covers these bytes")).toBe(true);
  });

  it("a swapped signing address is caught by ECDSA recovery", () => {
    const t = load();
    t.turns[0].model.signature!.signing_address = "0x0000000000000000000000000000000000000001";
    expect(verifyTranscript(t).some((c) => c.turn === 0 && c.what === "ECDSA signer matches signing_address" && !c.ok)).toBe(true);
  });
});

describe("replay", () => {
  it("the stored actions and claim reproduce the stored verdict", async () => {
    const { judge, parseClaim } = await import("./loss.ts");
    const t = load();
    expect(t.status).toBe("valid");
    expect(judge(t.scenario, t.actions, parseClaim(t.final_message))).toEqual(t.verdict);
  });
});
