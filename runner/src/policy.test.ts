import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NEAR } from "./chain.ts";
import { SCHEMA_FILE, buildPolicy, policyLevel, validatePolicy } from "./policy.ts";

const root = new URL("../../", import.meta.url).pathname;
const h = (c: string) => c.repeat(64);
const report = { level: 2, agent_config_hash: h("c"), suite_hash: h("s") };
const now = 1_000n * 10n ** 9n;
const cert = (over: Record<string, unknown> = {}) => ({ level: 2, report_hash: h("r"), config_hash: h("c"), suite_hash: h("s"), expires_ns: (now + 10n ** 12n).toString(), ...over });

describe("OutLayer policy export", () => {
  it("the pinned schema is the file we reviewed", () => {
    const sha = createHash("sha256").update(readFileSync(`${root}${SCHEMA_FILE}`)).digest("hex");
    expect(sha).toBe("029e8bc37fffe818d4692ec253886d3056d0ef28dd25a5ab172d2c78fdaf7381");
  });
  it("level 1 and level 2 policies pass OutLayer's schema and carry the right limits", () => {
    for (const level of [1, 2] as const) {
      const p = buildPolicy(level, ["shop.testnet"], "agent.testnet");
      expect(validatePolicy(p)).toEqual([]);
      const per = BigInt(p.rules.limits.per_transaction.native);
      expect(per).toBe((level === 1 ? 1n : 3n) * NEAR);
    }
  });
  it("the restrictive fields are asserted, not just the schema shape", async () => {
    const p = buildPolicy(2, ["shop.testnet"], "agent.testnet");
    (p.rules.addresses as { mode: string }).mode = "blacklist";
    (p.capabilities as Record<string, { allowed: boolean }>).swap = { allowed: true };
    const errors = validatePolicy(p);
    expect(errors).toContain("addresses must be a whitelist");
    expect(errors).toContain("every capability must be denied");
  });
  it("transaction count per hour follows the daily budget", () => {
    expect(buildPolicy(1, ["s.testnet"], "a.testnet").rules.rate_limit.max_per_hour).toBe(3);
    expect(buildPolicy(2, ["s.testnet"], "a.testnet").rules.rate_limit.max_per_hour).toBe(4);
  });
  it("rejects bad receiver lists", () => {
    expect(() => buildPolicy(2, [], "a.testnet")).toThrow();
    expect(() => buildPolicy(2, ["x.testnet", "x.testnet"], "a.testnet")).toThrow(/duplicate/);
    expect(() => buildPolicy(2, ["a.testnet"], "a.testnet")).toThrow(/own receiver/);
    expect(() => buildPolicy(2, ["Not Valid"], "a.testnet")).toThrow(/account id/);
  });
  it("a policy needs a live certificate that matches the report", () => {
    expect(policyLevel(report, h("r"), cert(), now)).toBe(2);
    expect(policyLevel(report, h("r"), cert({ level: 1 }), now)).toBe(1);
    expect(() => policyLevel(report, h("r"), null, now)).toThrow(/no certificate/);
    expect(() => policyLevel(report, h("r"), cert({ expires_ns: "1" }), now)).toThrow(/expired/);
    expect(() => policyLevel(report, h("x"), cert(), now)).toThrow(/does not match/);
    expect(() => policyLevel({ ...report, level: 0 }, h("r"), cert(), now)).toThrow(/no policy/);
  });
});
