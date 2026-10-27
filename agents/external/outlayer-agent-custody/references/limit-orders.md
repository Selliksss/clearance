# Limit orders

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

## Limit Orders

A limit order is a swap that **waits for your price**. You say what you are selling (or buying), how much, and at what price; the order rests on 1Click and fills — possibly in several slices — when the market reaches it. It ends when it is fully filled, when you cancel it, or at its deadline (7 days unless you set one). MAINNET only, funded from your **intents** balance (deposit first, as for a swap).

Use a swap (`/intents/swap`) when you want the trade now at the market's price. Use a limit order when the price matters more than the timing.

These endpoints are a thin door onto 1Click's orders: you send its order parameters and you get its order back — every attribute of it, field names in snake_case, enumerated values in lower case, **nothing renamed or left out** (1Click's own schema: `https://1click.chaindefuser.com/docs/v0/openapi.yaml`, `LimitOrderAttributes`). If 1Click's own docs say `fillStatus: "PENDING_CANCEL"`, you see `fill_status: "pending_cancel"`.

### Read this before you place one

- **You authorise it once. The payout happens later, without you.** Every other operation here is signed at the moment money moves; a resting order is not. Whatever the policy allowed when you created it is the only check it will ever get.
- **A price through the market fills immediately.** "Limit order" is not a safer kind of withdrawal — a `sell` priced below the market is simply a sale, right now. That is why it is gated like an exit (below), and why you should compute the price from a fresh quote rather than typing one from memory.
- **Freezing the wallet does NOT cancel its resting orders.** A freeze stops new orders (and everything else the policy gates); orders already resting keep filling and paying out. Cancelling is never frozen and your API key keeps working for it: if your wallet gets frozen (`wallet_frozen` on anything new), go and cancel what you left resting - `cancel-all` here, and the equivalent on any other venue you placed orders on. Cancelling is asynchronous - 1Click may still fill a last slice after a cancel is accepted.
- **1Click takes its own fee from your input** (20 bps at the time of writing). OutLayer does not set it; it comes back on every order as `app_fees` so you can see it. Minimum order value is 0.1 USD.

### Policy

Default-DENY. Under a policy, a limit order needs **both** `capabilities.limit_order.allowed = true` **and** `limit_order` in `transaction_types` (the dashboard's single "limit_order" switch sets both). `swap` and `cross_chain_withdraw` do not imply it, and it does not imply them. The address rules apply to `recipient` — where the filled output is paid — and the per-token amount limits apply to what the wallet sends. A wallet with no policy is unrestricted, as everywhere.

On a **multisig** wallet the create call answers `pending_approval` (see "Request Policy" in `funding-and-payment-keys.md`): approvers sign the order's exact terms — the token and amount sent, the token and minimum amount received — and the order is placed only after the threshold.

### Place an order

`quantity` is in the **base** asset's smallest units. `price` is **quote per one whole base**, as a positive decimal string (`"5"`, `"0.25"`; an exponent like `"1.2e1"` is accepted too) — no sign, spaces or separators, at most 64 characters. `quantity` is digits only, at most 65. These are 1Click's own bounds; OutLayer adds none.

| `side` | You send | You receive |
|--------|----------|-------------|
| `sell` | `quantity` of base | at least `quantity × price` of quote |
| `buy` | at most `quantity × price` of quote | `quantity` of base |

```bash
# Sell 1 wNEAR for USDC at 5 USDC per NEAR (or better)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -d '{
    "base_asset":  "nep141:wrap.near",
    "quote_asset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "side": "sell",
    "quantity": "1000000000000000000000000",
    "price": "5"
  }' \
  "https://api.outlayer.ai/wallet/v1/limit-orders"
```

| Param | Required | Description |
|-------|----------|-------------|
| `base_asset` | yes | Defuse asset id of the asset `quantity` is in (from `GET /wallet/v1/tokens`) |
| `quote_asset` | yes | Defuse asset id of the asset `price` is in |
| `side` | yes | `sell` or `buy` (lower case) |
| `quantity` | yes | Base amount, smallest units (string) |
| `price` | yes | Quote per one whole base, positive decimal string (≤ 64 chars) |
| `recipient` | no | Where the filled output goes. Omitted → your own intents balance. The policy's address rules apply either way: under a `whitelist`, your own intents account must be on the list for the default to pass |
| `recipient_type` | no | 1Click's `recipientType`, lower-cased: `intents` (default — `recipient` is a NEAR account inside intents), `confidential_intents` (the same, on the confidential shard - the policy must then permit the `confidential` capability too) or `destination_chain` (`recipient` is an address on the output asset's own chain, and is then required) |
| `deadline` | no | RFC 3339 expiry. Omitted → 7 days |

The unfilled remainder **always** comes back to your own intents balance, whoever the `recipient` is.

Response — 1Click's order **as it stood when it was created**, plus `request_id` and `transfer_intent_hash` (the transfer that funds it). It says `awaiting_deposit` with a zero `deposited_amount`: 1Click picks the deposit up within seconds, so read the order once to see it `open`.
```json
{
  "request_id": "uuid",
  "order_id": "order_7A9J0b3TP4yjYvGDL3xy9",
  "order_type": "limit",
  "deposit_address": "5a56efb1…",
  "deposit_mode": "simple",
  "deposit_type": "intents",
  "fill_status": "awaiting_deposit",
  "payout_status": "not_started",
  "is_payout_status_final": false,
  "payouts": { "withdrawal": null, "allWithdrawals": [], "refund": null },
  "partial_fills": null,
  "deposited_amount": "0",
  "deposited_amount_formatted": "0.0",
  "base_asset": "nep141:wrap.near",
  "quote_asset": "nep141:1720…",
  "side": "sell",
  "quantity": "1000000000000000000000000",
  "price": "5",
  "swap_view": { "origin_asset": "nep141:wrap.near", "destination_asset": "nep141:1720…", "swap_type": "exact_input", "amount_in": "1000000000000000000000000", "min_amount_out": "5000000" },
  "app_fees": [{ "recipient": "…", "fee": 20 }],
  "recipient": "<your intents account>", "recipient_type": "intents",
  "refund_to": "<your intents account>", "refund_type": "intents",
  "estimated_withdraw_fee": "0", "estimated_withdraw_fee_formatted": "0.0",
  "estimated_refund_fee": "0",   "estimated_refund_fee_formatted": "0.0",
  "confidentiality": "basic",
  "time_in_force": "gtc",
  "deadline": "2026-09-28T10:21:30.812Z",
  "created_at": "2026-09-21T10:21:30.812Z",
  "transfer_intent_hash": "…"
}
```

If the funding transfer is not confirmed in time, the order exists but the answer is
```json
{ "request_id": "uuid", "status": "processing", "order_id": "order_…", "poll_url": "/wallet/v1/requests/uuid" }
```
That is not an error and **must not be retried** — the transfer may land, and a retry
rests and funds a second order. Poll `poll_url`: `success` once the transfer executed,
or `failed` with `never_executed: true` once its deadline passed unused (nothing moved;
the order is then cancelled). Follow the order itself by `order_id` as usual.

| Field | What it tells you |
|-------|-------------------|
| `fill_status`, `payout_status`, `is_payout_status_final` | Where the order stands — see "Is it done?" below |
| `partial_fills` | Fills that already executed (`[{id, amountIn, amountOut, createdAt, updatedAt}]`, 1Click's own objects) — the only sign of progress on a `partially_filled` order; `null`/empty until the first fill |
| `deposited_amount` (`_formatted`) | How much of your input the order holds — smallest units, and human-readable |
| `swap_view` | What the order moves, as 1Click computed it. Sell: `amount_in` + `min_amount_out`. Buy: `max_amount_in` + `amount_out` |
| `app_fees` | 1Click's own fee on your input, basis points |
| `estimated_withdraw_fee`, `estimated_refund_fee` (`_formatted`) | 1Click's own estimate of what paying out / refunding will cost, passed through as given (`0` on every intents-to-intents order observed so far) |
| `payouts` | The legs once there are any: `withdrawal`, `allWithdrawals`, `refund` — each `{status, txHash}`, or `{status: "FAILED", reason}` |
| `recipient` / `recipient_type`, `refund_to` / `refund_type` | Where the output goes, and where the remainder comes back (always your wallet) |
| `order_type`, `deposit_mode`, `deposit_type`, `confidentiality`, `time_in_force` | Constants today: `limit`, `simple`, `intents`, `basic`, `gtc` |
| `transfer_intent_hash`, `request_id` | The only two fields that are OutLayer's and not 1Click's: the transfer that funded the order, and this create call |

Always send an `X-Idempotency-Key` (see "X-Idempotency-Key — one key per operation" in `intents-withdraw.md`): a repeated key is not executed again, so a retry cannot rest — and fund — a second order.

If 1Click's own figures for the order turn out worse than the terms your policy authorised (it asks for more, or pays out less), OutLayer cancels the still-unfunded order and answers `400` — nothing is sent.

### Is it done? — `is_payout_status_final`

**`is_payout_status_final: true` is the only signal that an order is over** — filled output paid out, unfilled remainder refunded. Do not decide from `fill_status` alone:

| `fill_status` | Meaning |
|---------------|---------|
| `awaiting_deposit` | Created; the funding transfer is sent but 1Click has not counted it yet. This is what the create answer shows |
| `open` | Funded, resting |
| `partially_filled` | Some quantity filled, the rest still working |
| `filled` | Fully matched — payout may still be in progress |
| `pending_cancel` | Cancel accepted; **a last slice can still fill** |
| `canceled` | Cancelled — refund may still be in progress |
| `expired` | Deadline passed — refund may still be in progress |

1Click may add values; treat an unknown one as "still working". While an order is `partially_filled`, `partial_fills` (1Click's own array, verbatim: `amountIn`, `amountOut`, timestamps) says how much has filled so far. Once final, `payouts.withdrawal` / `payouts.refund` carry the legs (1Click's own object, verbatim: `status`, and `txHash` on completed legs).

An order can take days. Poll `GET /wallet/v1/limit-orders/{order_id}` at a relaxed interval (minutes, not seconds) rather than holding a loop open. Poll the order, not the list: the list returns each order as it was last recorded (by a read or a cancel) and never asks 1Click.

### Cancel

```bash
# one order
curl -s -X POST -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/limit-orders/$ORDER_ID/cancel"

# everything this wallet has resting
curl -s -X POST -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/limit-orders/cancel-all"
# → { "known": 2, "cancelled": 2, "failed": 0, "remaining": 0, "complete": true }
```

**What `cancel-all` does.** It asks 1Click to cancel every limit order of THIS wallet that is not yet finished paying out - the orders placed through this API with this wallet, nothing else. For each one: matching stops, whatever already filled is still paid out to the order's `recipient`, and the unfilled remainder is refunded to your own intents balance.

**What it does not do.** It does not touch other wallets, and it does not touch anything you placed on other venues (a connector's orders or positions are cancelled through that connector). It does not wait: a cancel is a request 1Click completes later, so an order goes `pending_cancel` first, may still fill a last slice, and is over only when `is_payout_status_final` is true.

**The answer:** one call covers at most 50 orders, oldest first. `known` - unfinished orders this call asked about; `cancelled` - cancels 1Click accepted; `failed` - cancels that did not go through (those orders are STILL resting); `remaining` - unfinished orders this call did not get to; `complete` - true when `failed` and `remaining` are both 0. On `complete: false`, call it again until it is true. If the same orders keep failing, add `?offset=50` (then 100, ...) to step over them and reach the ones behind - a call with an `offset` never says `complete: true`, because what you skipped is still resting. If the call fails with `503` saying it ran out of time (1Click was slow), the cancels it names are accepted; call again with a smaller `?limit=` (1..50). Calling it twice is harmless, and with nothing resting it answers `known: 0`.

Cancelling (one order or all) is never refused by policy or by a freeze, and your API key keeps working for it on a frozen wallet - it only brings funds home.

Another wallet's `order_id` answers `404`: an order id is not a bearer token.
