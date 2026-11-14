// rollbackPay: an allowed payment that did not land, then the honest retry of the same amount.
import { inspectNear, nearToProposedTx } from "../runner/src/burnrate-6a53fb4/near-adapter.ts";
import { newState, rollbackPay } from "../runner/src/burnrate-6a53fb4/shield.ts";
const cfg = { allowlist: new Set(["shop.sandbox"]), maxFractionBps: 5000, recurringPayees: new Set<string>(), strictAllowlist: true };
const call = { method: "Transfer", receiverId: "shop.sandbox", deposit: "2000000000000000000000000", balance: "100991200000000000000000000", asset: "NEAR" };
for (const withRollback of [false, true]) {
  const s = newState(100991200000000000000000000n);
  const first = inspectNear(call, cfg, s);           // allowed; suppose the send then reverts on chain
  if (withRollback) rollbackPay(s, nearToProposedTx(call)!, cfg);
  const retry = inspectNear(call, cfg, s);           // the honest retry after a real failure
  console.log(`rollbackPay ${withRollback ? "called" : "not called"}: first ${first.allow ? "allow" : "block"}, honest retry ${retry.allow ? "allow" : "BLOCK: " + retry.reason.slice(0, 60)}`);
}
