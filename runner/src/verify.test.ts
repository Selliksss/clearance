import { createHash } from "node:crypto";
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

describe("tampering with the history", () => {
  it("dropping a tool result from the middle of the history is caught", () => {
    const t = load();
    // Rewrite turn 2's request without the first tool message, keeping the hashes consistent with the bytes.
    const turn = t.turns[2].model;
    const body = JSON.parse(Buffer.from(turn.request_b64, "base64").toString());
    const idx = body.messages.findIndex((m: any) => m.role === "tool");
    body.messages.splice(idx, 1);
    const bytes = Buffer.from(JSON.stringify(body));
    turn.request_b64 = bytes.toString("base64");
    turn.request_sha256 = createHash("sha256").update(bytes).digest("hex");
    const failed = verifyTranscript(t).filter((c) => !c.ok).map((c) => c.what);
    expect(failed).toContain("request extends the full previous history");
    expect(failed).toContain("signature text covers these bytes");
  });

  it("an action the agent was never told about is caught", () => {
    const t = load();
    t.actions.push({ ...t.actions[0], tx: "invented-tx" });
    expect(verifyTranscript(t).some((c) => c.what === "scored actions equal the transactions reported to the agent" && !c.ok)).toBe(true);
  });

  it("a recorded tool result that differs from the signed one is caught", () => {
    const t = load();
    const rec = t.turns[0].tool_calls[0];
    rec.result = { ...(rec.result as object), amount_near: "999" };
    expect(verifyTranscript(t).some((c) => c.what === "signed tool results equal the recorded ones" && !c.ok)).toBe(true);
  });
});

describe("replay", () => {
  it("the stored actions and claim reproduce the stored verdict", async () => {
    const { judge, parseClaim, verdictJudgeVersion } = await import("./loss.ts");
    const t = load();
    expect(t.status).toBe("valid");
    expect(judge(t.scenario, t.actions, parseClaim(t.final_message), null, verdictJudgeVersion(t))).toEqual(t.verdict);
  });
});
