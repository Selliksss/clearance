import { describe, expect, it } from "vitest";
import { type CertifyArgs, TTL_NS, buildCertifyArgs, checkDeploy, needsCertify } from "./certify.ts";

const h = (c: string) => c.repeat(64);
const report = (level: number, insufficient: string[] = []) => ({
  level, insufficient, suite_version: 1, suite_hash: h("a"), hidden_count: 0, agent_config_hash: h("c"), endpoint_class: "Attested",
}) as unknown as Parameters<typeof buildCertifyArgs>[0];
const args = (over: Partial<CertifyArgs> = {}): CertifyArgs => ({
  agent: "a.testnet", level: 2, suite_version: 1, suite_hash: h("a"), hidden_count: 0, report_hash: h("b"),
  config_hash: h("c"), endpoint_class: "Attested", run_ref: "local@x", ttl_ns: TTL_NS.toString(), ...over,
});
const now = 1_000_000n * 10n ** 9n;
const DAY = 86_400n * 10n ** 9n;
const cert = (over: Record<string, unknown> = {}) => ({ level: 2, suite_hash: h("a"), report_hash: h("b"), config_hash: h("c"), endpoint_class: "Attested", expires_ns: (now + 3n * DAY).toString(), ...over });

describe("certify", () => {
  it("level 0 or too few runs never gets a certificate", () => {
    expect(() => buildCertifyArgs(report(0), "a.testnet", "f".repeat(40))).toThrow(/no certificate/);
    expect(() => buildCertifyArgs(report(2, ["G1: 2/3"]), "a.testnet", "f".repeat(40))).toThrow(/insufficient/);
  });
  it("run_ref names the commit; a bad sha is refused", () => {
    expect(buildCertifyArgs(report(2), "a.testnet", "f".repeat(40)).run_ref).toBe(`local@${"f".repeat(40)}`);
    expect(() => buildCertifyArgs(report(2), "a.testnet", "HEAD")).toThrow(/sha/);
  });
  it("is idempotent for a live identical certificate and reissues otherwise", () => {
    expect(needsCertify(null, args(), now)).toBe("issue");
    expect(needsCertify(cert(), args(), now)).toBe("noop");
    expect(needsCertify(cert({ report_hash: h("d") }), args(), now)).toBe("issue");
    expect(needsCertify(cert({ level: 1 }), args(), now)).toBe("issue");
    expect(needsCertify(cert({ expires_ns: (now + DAY / 2n).toString() }), args(), now)).toBe("issue");
  });
});

describe("deploy config", () => {
  const ok = { network: "testnet" as const, contract: "c.testnet", runner: "r.testnet", runner_fc_public_key: "ed25519:DSP22oEJg9jAUXcSdUePsuGek525dskZjqRF8ieuBNaZ", agents: { protected: "p.testnet" } };
  it("accepts the real shape and refuses path tricks", () => {
    expect(() => checkDeploy(ok)).not.toThrow();
    expect(() => checkDeploy({ ...ok, runner: "../../etc" })).toThrow(/account id/);
    expect(() => checkDeploy({ ...ok, runner_fc_public_key: "ed25519:../../x" })).toThrow(/ed25519/);
  });
});
