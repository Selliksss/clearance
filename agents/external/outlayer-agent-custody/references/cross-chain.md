# Cross-chain deposit and withdraw

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

### Supported chains

Every chain the 1Click token catalog lists — `GET /wallet/v1/tokens`, the `chains` of its entries (37 chains on 2026-10-14: NEAR, Ethereum, Bitcoin, Solana, Arbitrum, Base, Polygon, Optimism, Avalanche, BSC, HyperCore, TON, Aptos, Sui, StarkNet, Tron, Stellar, Dogecoin, XRP, Zcash, Litecoin, Bitcoin Cash, Berachain, Aleo, Cardano, Dash, Monad, Scroll, X Layer, …). The set is read from 1Click every hour: a chain 1Click adds is served without a release. Spell `chain` as 1Click's id (`eth`, `sol`, `ton`, `xrp`) or, where one exists, the long name (`ethereum`, `solana`, `zcash`); case does not matter. A chain the catalog does not list is `400 unsupported_chain`, and the message names what it does list — never retry it as sent.

Addresses: on the chains the wallet derives an address on (EVM, Solana, NEAR, Bitcoin) `to` is checked for shape before the quote; on every other chain 1Click judges it at the quote, before anything moves, and a bad one comes back `400 upstream_rejected` in 1Click's words.

## Cross-Chain Deposit & Withdraw

Deposit tokens from any supported chain (Solana, Ethereum, Base, Arbitrum, etc.) into intents balance, or withdraw from intents to any chain. No gas tokens needed on source/destination chains - 1Click handles execution.

Chains: the catalog's, as above. The returned `deposit_address` is always on the chain that matches the source asset (64-char hex for NEAR, `0x…` for EVM, base58 for Solana, `bc1…`/`1…`/`3…` for Bitcoin, the chain's own format elsewhere).

> **NEAR source? Use `/wallet/v1/intents/deposit` instead.** When the funds
> are already on NEAR (in the agent's wallet), skip this endpoint and call
> `POST /wallet/v1/intents/deposit` (see "Move FT from wallet into Intents"
> in `api-index.md`; the curl is in `intents-withdraw.md`). It signs a direct
> `ft_transfer_call(token, receiver=intents.near, amount)` in one
> transaction, ~3 seconds, no 1Click solver hop. `/deposit-intent` still
> accepts a NEAR-source asset for symmetry, but adds a solver hop and
> ~5 seconds for no benefit — and the response carries a `hint` field
> nudging you to `/intents/deposit`.

### Deposit from another chain → intents

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "source_asset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "amount": "1000000"
  }' \
  "https://api.outlayer.ai/wallet/v1/deposit-intent"
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `source_asset` | yes | - | Defuse asset id (e.g. `nep141:eth-…omft.near`) from `GET /wallet/v1/tokens`. The source chain is derived from the prefix; supported prefixes cover `near`, `solana`, `ethereum`, `base`, `arbitrum`, `bitcoin`, `bsc`, `polygon`, `optimism`, `avalanche`, plus the omft natives (`zcash`, `dogecoin`, `litecoin`, `bitcoincash`, `xrp`, `dash`, `cardano`, `tron`, `sui`, `aptos`, `aleo`, `gnosis`, `berachain`, `movement`, `plasma`, `starknet`). |
| `amount` | yes | - | Amount in minimal units. USDC: 6 decimals (`"1000000"` = 1 USDC). |
| `refund_address` | no | - | Address on the source chain a failed bridge refunds to, format-checked for the chain. With a wallet policy, the owner decides: its `refund_addresses.<chain>` entry, else the wallet's own address on that chain (NEAR, Solana, EVM chains, HyperCore) — your `refund_address` is then ignored and `hint` says so. It is used without a policy, and on a chain the wallet has no address of its own on (Bitcoin, Zcash, Tron, …) that the policy names no entry for — there it is required: without it the request fails with HTTP 400. |
| `destination_asset` | no | NEAR USDC | Defuse asset id for destination token. Override to receive wNEAR etc. |

Response:
```json
{
  "intent_id": "uuid",
  "deposit_address": "7szyqKsG3SC4XvrEaF128DHCYEmy7n7SvM4DSoW1e5jZ",
  "amount": "1000000",
  "amount_out": "999998",
  "min_amount_out": "989998",
  "expires_at": "2026-03-26T17:25:45.914Z",
  "estimated_time_secs": 20
}
```

**2. User sends tokens** to `deposit_address` on the source chain.

**3. Poll status:**
```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/intents/deposit/cross-chain/status?id={intent_id}"
```

Status transitions: `pending` → `bridging` → `success`. On `success`, tokens are in intents balance - create payment checks, swap, or withdraw as usual.

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for deposit on source chain |
| `bridging` | 1Click detected deposit, settling to NEAR intents |
| `success` | Tokens in intents balance |
| `failed` | Error or refund |
| `expired` | No deposit before deadline |

**4. List all deposits:**
```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/deposits?limit=20"
```

### Withdraw from intents → another chain

Send tokens from intents balance to any supported chain. Uses `/intents/withdraw` with `chain` param. Gasless - 1Click solver handles execution.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "token": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "amount": "1000000", "chain": "solana"}' \
  "https://api.outlayer.ai/wallet/v1/intents/withdraw"
```

| Param | Required | Description |
|-------|----------|-------------|
| `to` | yes | Destination address on target chain |
| `token` | yes | Intents token (defuse asset ID, e.g. `nep141:17208628f...a1` for USDC) |
| `amount` | yes | Amount in minimal units |
| `chain` | yes | `"solana"`, `"ethereum"`, `"base"`, etc. |

Response: `{"request_id": "uuid", "status": "success"}`

### Cross-chain limitations

- **Minimum deposit/withdraw**: ~$0.10. 1Click returns clear error with exact minimum if too low.
- **Fee**: ~0.2% (shown in `amount_out` / `min_amount_out`).
- **Settlement time**: ~15-30 seconds depending on chain.
- **Deposit address**: unique per intent, valid ~30 min. Each `deposit-intent` call creates a new address. Amount sent must match exactly.
- **Supported tokens**: use `GET /wallet/v1/tokens` to check available tokens per chain.
