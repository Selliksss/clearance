// A local NEAR sandbox running the same wasm as testnet, set up for one crash-test
// session: wide cage (caps 100/100, 1s buckets), a test signer that certifies the
// agent at level 2, and one fresh vault per run.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString, actions } from "near-api-js";
import { GenesisAccount, Sandbox } from "near-sandbox";

export const NEAR = 10n ** 24n;
const CONTRACT = "clearance.sandbox";
const OWNER = "owner.sandbox";
const SIGNER = "signer.sandbox";
const GAS = 100_000_000_000_000n;
const CAGE_NEAR = 100n;
const HEX = (c: string) => c.repeat(64);

export type TxOutcome = {
  hash: string;
  ok: boolean;
  /** Decoded JSON return value, if any. */
  value: unknown;
  panic: string | null;
  receiptFailures: number;
  logs: string[];
};

/** Parses a decimal NEAR string ("2", "0.5") into yocto without floating point. */
export function parseNear(s: string): bigint {
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(`not a decimal NEAR amount: ${s}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * NEAR + BigInt(frac.padEnd(24, "0"));
}

export function formatNear(y: bigint): string {
  const neg = y < 0n;
  const a = neg ? -y : y;
  const frac = (a % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / NEAR}${frac ? `.${frac}` : ""}`;
}

function outcome(res: any): TxOutcome {
  const text = JSON.stringify(res);
  const panic = (text.match(/Smart contract panicked: ([^"\\]+)/) || [])[1] ?? null;
  const receiptFailures = res.receipts_outcome.filter((o: any) => o.outcome.status.Failure).length;
  const raw = res.status?.SuccessValue;
  let value: unknown = null;
  if (typeof raw === "string" && raw) value = JSON.parse(Buffer.from(raw, "base64").toString());
  return {
    hash: res.transaction.hash,
    ok: typeof raw === "string" && !panic,
    value,
    panic,
    receiptFailures,
    logs: res.receipts_outcome.flatMap((o: any) => o.outcome.logs),
  };
}

export class Chain {
  private constructor(
    readonly sandbox: Sandbox,
    readonly provider: JsonRpcProvider,
    private readonly keys: Map<string, KeyPairString>,
  ) {}

  /** Starts a sandbox whose genesis already holds every account the session needs. */
  static async start(wasmPath: string, participants: string[], agents: string[]): Promise<Chain> {
    const names = [CONTRACT, OWNER, SIGNER, ...agents, ...participants];
    const keys = new Map<string, KeyPairString>();
    const genesis = names.map((id) => {
      const kp = KeyPair.fromRandom("ed25519");
      keys.set(id, kp.toString() as KeyPairString);
      return new GenesisAccount(id, kp.getPublicKey().toString(), kp.toString(), 10_000n * NEAR);
    });
    const sandbox = await Sandbox.start({ config: { additionalAccounts: genesis } });
    const chain = new Chain(sandbox, new JsonRpcProvider({ url: sandbox.rpcUrl }), keys);
    await chain.account(CONTRACT).deployContract(readFileSync(wasmPath));
    await chain.call(CONTRACT, "init", {
      bucket_ns: "1000000000",
      level_caps: [(CAGE_NEAR * NEAR).toString(), (CAGE_NEAR * NEAR).toString()],
      max_cert_ttl_ns: String(30 * 86_400 * 1e9),
    });
    await chain.call(SIGNER, "storage_deposit", {}, NEAR);
    return chain;
  }

  account(id: string): Account {
    const key = this.keys.get(id);
    if (!key) throw new Error(`unknown sandbox account ${id}`);
    return new Account(id, this.provider, key);
  }

  /** Calls the contract as `who`. Never throws on a contract panic; returns the outcome. */
  async call(who: string, method: string, args: object, deposit = 0n): Promise<TxOutcome> {
    const res = await this.account(who).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [actions.functionCall(method, args, GAS, deposit)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return outcome(res);
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return (await this.provider.callFunction({ contractId: CONTRACT, method, args })) as T;
  }

  async balance(id: string): Promise<bigint> {
    return (await this.account(id).getState()).balance.total;
  }

  /** A fresh vault for one run: 100 NEAR cage, every participant allowed, agent certified level 2. */
  async freshVault(agent: string, receivers: string[]): Promise<number> {
    const created = await this.call(OWNER, "create_vault", {
      agent, owner_cap: (CAGE_NEAR * NEAR).toString(), receivers, trusted_signers: [SIGNER], policy: "All",
      min_suite_version: 1, min_hidden: 0, allow_foreign_endpoint: true,
    }, (CAGE_NEAR + 1n) * NEAR);
    if (!created.ok) throw new Error(`create_vault failed: ${created.panic}`);
    const cert = await this.call(SIGNER, "certify", {
      agent, level: 2, suite_version: 1, suite_hash: HEX("0"), hidden_count: 0, report_hash: HEX("0"),
      config_hash: HEX("0"), endpoint_class: "Foreign", run_ref: null, ttl_ns: String(86_400 * 1e9),
    });
    if (!cert.ok) throw new Error(`certify failed: ${cert.panic}`);
    return created.value as number;
  }

  async stop(): Promise<void> {
    await this.sandbox.tearDown();
  }
}
