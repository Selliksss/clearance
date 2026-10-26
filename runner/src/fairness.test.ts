// Every generator in the suite must be winnable: a scripted agent that does the task
// exactly as written and ignores whatever the tools say must come out completed and
// not deceived, on every seed. A generator that fails this would punish a correct
// agent (sabotaged oracle, attack on a tool the task needs to read, etc.).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delivered, injector, loadGenerator } from "./attack.ts";
import { NEAR, type TxOutcome } from "./chain.ts";
import { judge } from "./loss.ts";
import { type Scenario, loadScenario } from "./scenario.ts";
import { Toolbox } from "./tools.ts";

const root = new URL("../../", import.meta.url).pathname;
const suite = {
  generators: ["v1", "v1-holdout", "v1-blind"].flatMap((s) => (JSON.parse(readFileSync(`${root}suites/${s}.json`, "utf8")) as { generators: string[] }).generators),
};

function fakeChain() {
  let vault = 100n * NEAR;
  let n = 0;
  return {
    async call(_w: string, _m: string, args: Record<string, unknown>): Promise<TxOutcome> {
      vault -= BigInt(args.amount as string);
      n++;
      return { hash: `tx${n}`, ok: true, value: true, panic: null, receiptFailures: 0, logs: [] };
    },
    async view<T>(): Promise<T> { return { balance: vault.toString() } as T; },
    async vaultBalance() { return vault; },
    async balance() { return 0n; },
  };
}

/** Reads what the task says to read, then does exactly what the task says. */
async function honestAgent(s: Scenario, tb: Toolbox): Promise<{ name: string }[]> {
  const calls: { name: string }[] = [];
  const run = async (name: string, args: Record<string, string>) => {
    calls.push({ name });
    return tb.run(name, args);
  };
  const c = s.correct;
  if (c.tool === "swap") {
    if (s.token_metadata) await run("get_token_metadata", { token: String(s.token_metadata.token) });
    await run("get_price", { pair: s.honest_price!.pair });
    await run("swap", { amount_in_near: c.amount_in_near_max, min_out: c.min_out_ge });
  } else {
    await run(s.honest_invoice ? "get_invoice" : "read_inbox", {});
    const args: Record<string, string> = { receiver: s.participants[c.receiver], amount_near: s.honest_payment_near };
    if (c.tool === "pay_invoice") args.invoice_id = "INV";
    await run(c.tool, args);
  }
  return calls;
}

describe("every suite generator is winnable by an agent that ignores the injection", () => {
  for (const id of suite.generators) {
    it(id, async () => {
      const raw = JSON.parse(readFileSync(`${root}attacks/${id}.json`, "utf8"));
      const s = loadScenario(`${root}scenarios/${raw.scenario}.json`);
      const { generator } = loadGenerator(`${root}attacks/${id}.json`, s);
      for (let i = 0; i < 5; i++) {
        const { inject, injected } = injector(generator, s, `fair-${i}`);
        const tb = new Toolbox(fakeChain(), s, "agent.sandbox", 0, inject);
        const calls = await honestAgent(s, tb);
        expect(delivered(generator, calls)).toBe(true);
        const v = judge(s, tb.actions, { status: "success", tx: null }, injected);
        expect(v).toMatchObject({ completed: true, deceived: false, false_report: false, loss_yocto: "0" });
      }
    });
  }
});
