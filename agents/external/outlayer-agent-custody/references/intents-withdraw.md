# Withdraw and transfer inside Intents

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

### `/intents/withdraw`

- **Gasless.** Signs a NEP-413 intent, the solver relay executes it; the wallet's implicit account needs no NEAR. This is the only withdraw endpoint — there is no on-chain `ft_withdraw` route.
  - **For `chain=near`, the `token` field picks what the recipient gets:** omitted / `near` / `native` (default) delivers **native NEAR** — intents.near unwraps your wNEAR (`native_withdraw` intent), and the receiver needs **no** storage. `nep141:wrap.near` (or any `nep141:<token>`) delivers that NEP-141 instead, and the receiver **must** have storage registered (use `/storage-deposit` first).
  - **Native-NEAR caveat:** the recipient account must already exist (or be a 64-char implicit account). Withdrawing native NEAR to a non-existent named account is rejected up front (the unwrapped wNEAR would otherwise be burned).

### Async mode — strongly recommended for cross-chain withdrawals

`/intents/withdraw` accepts `"async": true`. In async mode the call returns immediately with `status: "processing"` and a `poll_url`; the withdrawal settles in the background and you poll `GET /wallet/v1/requests/{request_id}` until the row reaches a terminal status. **The exact status values are a short, fixed set — see "Status values (exact)" below; do not invent synonym sets, and do not forget `needs_review`.**

- **Cross-chain withdrawals (`chain` ≠ `near`): always prefer `async: true`.** The 1Click bridge almost always takes longer than the synchronous response window — a sync call blocks up to ~90s and then returns `processing` anyway, and can hit the gateway request timeout first. Async is the reliable path; treat it as the default for any non-NEAR `chain`.
- **Same-chain NEAR (`chain: "near"`)** usually settles in seconds — a synchronous call is fine and `async` is optional. When the solver relay is slow, a sync call still answers `processing`; branch on the status and poll.
- Auth, policy and validation errors are returned **synchronously** in both modes. In async mode only an *execution* failure surfaces as the request's `failed` status (read it from the poll, not the POST response).

```bash
# Cross-chain withdraw — async (recommended)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"0x742d35Cc6634C0532925a3b844Bc9e7595f8b4f5","amount":"100000000","token":"nep141:usdt.tether-token.near","chain":"ethereum","async":true}' \
  "https://api.outlayer.ai/wallet/v1/intents/withdraw"
# → { "request_id": "<id>", "status": "processing", "poll_url": "/wallet/v1/requests/<id>" }

# Poll until terminal (processing → success | failed | needs_review)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/requests/<id>"
```

#### Status values (exact)

The `GET /wallet/v1/requests/{id}` row for a withdraw/swap holds **only** these `status` strings — match them exactly (case-sensitive). Do **not** build broad synonym sets (`settled`/`completed`/`confirmed`/`done`/…); none of those are ever emitted, and inventing them gives false confidence while missing the one that matters (`needs_review`).

| `status` | Terminal? | Meaning / how to handle |
|----------|-----------|--------------------------|
| `processing` | no | Still settling. Keep polling. |
| `success` | **yes** | Done. `result` carries `amount_out`, `transfer_intent_hash`, `deposit_address` (identifiers) plus — on cross-chain ops — nullable `destination_tx_hash`, the **one** real destination-chain tx (see "Result fields are identifiers, NOT tx hashes" below). |
| `failed` | **yes** | Execution failed (a 1Click refund/expiry is also normalized to `failed`; the reason is in `result.reason`). Safe to surface as a failure. `result.never_executed: true` or `result.never_submitted: true` means no funds moved — safe to retry with a new `X-Idempotency-Key`. **Without those flags funds may have moved** — a bridge that failed or refunded (`result.reason`), or a NEAR transaction that failed on chain after its gas was spent: reconcile the balance before acting again, and never report it to your own users as "nothing moved". |
| `needs_review` | **yes (stop)** | **Execution was interrupted or unresolved; fund state is UNKNOWN.** Surface as "needs manual review / contact support". **Do NOT auto-retry** — the original transfer may have fired, so a retry can double-spend. This is the status integrators most often forget — without it you poll forever. |
| `pending_approval` / `approved` | no | **Multisig wallets only.** The withdrawal needs the approval flow to complete; it will not settle by polling alone. |
| `rejected` | **yes** | Multisig: approvers rejected. Treat as failure. |

**Multisig limits.** One signing request may carry at most **16** approval votes and **16**
rejections; more is rejected with HTTP 400 before anything in the ballot is checked. Verifying a
vote costs a signature check, so the ballot is capped rather than left open-ended. Two consequences
for an integrator: send only the votes that count toward the threshold rather than every signature
you have collected, and do not configure a policy with more than 16 approvers — its threshold could
never be met, because the votes would not fit in the request.

Notes:
- `success`/`failure` detection in your client should be: success = `{"success"}`, failure = `{"failed","rejected"}`, plus `needs_review` as a distinct non-retryable outcome.
- `"bridging"` and `"pending_deposit"` belong to the **deposit** endpoint (`/intents/deposit/cross-chain/status`), **not** to `/requests/{id}` — don't expect them here.
- **Submit status:** a successful async submit is exactly `"processing"` (never `pending`/`queued`). On a **multisig** wallet the submit returns `"pending_approval"` instead — handle that before assuming you can just poll.
- **Sync fallback** (`async` false/absent): the POST blocks and usually returns a terminal `status` in the same body, **but a slow settlement — the bridge, or the solver relay on a same-chain withdraw — can still return `"processing"`** with a `poll_url` — branch on the status and poll it, don't assume the sync body is always terminal. The withdrawal runs to its outcome even if your client disconnects. Either send `X-Answer-Within: <seconds>` below your own timeout (the call then answers `processing` with `request_id` and `poll_url` within that many seconds — see below), or give a sync call at least 90 s. If your client gives up first, do NOT submit a new withdraw — re-send with the same `X-Idempotency-Key`: the duplicate answer names the request (`request_id`, `status`, `poll_url`), and nothing runs twice (see "X-Idempotency-Key — one key per operation").
- **Errors:** auth, policy (limits/whitelist/multisig) and request-shape validation are returned **synchronously** as HTTP 4xx. Insufficient balance and the bridge execution itself are deferred in async mode and surface as the polled row's `failed` status — not as a POST error.
- **Webhook (preferred over long polling for the slow tail):** if the wallet's policy has a `webhook_url`, OutLayer POSTs a `request_completed` event (HMAC-signed, header `X-Webhook-Signature`) on the terminal transition, including bridges that outlive your poll window. Payload: `{ request_id, type, status, result }`, where `type` is `intents_withdraw` / `intents_cross_chain_withdraw` / `intents_swap` / `limit_order` (the last one fires when a multisig-approved order has been placed and funded — NOT when it fills; read the order for that).

#### Result fields are identifiers, NOT tx hashes — except `destination_tx_hash`

**`/intents/withdraw` has NO `tx_hash` field.** The only destination-chain transaction in its `result` is the dedicated `destination_tx_hash` field — do not synthesize explorer links from any *other* withdraw/swap field, and do not carry over the `tx_hash` field you saw on `/call`.

- **Exact `result` shape (this is all there is):**
  - Cross-chain (`chain` ≠ `near`): `{ "to", "amount_out", "transfer_intent_hash", "cross_chain": true, "chain", "deposit_address", "destination_tx_hash" }`
  - Same-chain NEAR (`chain: "near"`): `{ "intent_hash", "delivered" }`
- **`destination_tx_hash` is the one real destination-chain txid** — the delivery transaction on the destination chain, safe to render as an explorer link *on the requested `chain`*. It is **nullable**: `null` while the bridge is still settling (a sync response that returned `"processing"`, or an async row before settlement); the lazy re-poll fills it in, so re-read `GET /wallet/v1/requests/{id}` at `success` (the `request_completed` webhook carries it too). Gasless `/intents/swap` rows gain the same nullable `result.destination_tx_hash` on settlement.
- **`transfer_intent_hash` / `intent_hash` are NEAR-Intents identifiers** (solver-relay intent hashes), **not** transactions on Base/Arbitrum/Solana/Polygon/etc. The value is NOT an EVM/Solana txid even when it looks like `0x{64}`. Building `basescan.org/tx/…`, `arbiscan.io/tx/…`, `solscan.io/tx/…`, … from it produces dead 404 links. **Never regex a `0x{64}` out of these fields and never guess the destination network to build a link.**
- **Confidential ops** expose the same information as an array: the request row's `result.swap_details.destinationChainTxHashes` (plain hash strings; note the **camelCase** inner keys — the `swap_details` container is snake_case, its contents are 1Click-style camelCase) carries the real destination-chain delivery tx once terminal (see `confidential.md`).
- **Real NEAR `tx_hash` exists only on the on-chain endpoints:** `/wallet/v1/call`, `/transfer`, `/intents/deposit`, `/storage-deposit`, `/delete`. The gasless/intents endpoints (`/intents/withdraw`, `/intents/swap`, `/intents/transfer`) return intent hashes (plus `destination_tx_hash` where noted) — no `tx_hash` field.
- **Receipts:** show `deposit_address` and `request_id` as ids/text; render `transfer_intent_hash`/`intent_hash` as a NEAR-Intents identifier, never as an EVM/Solana explorer link; link `destination_tx_hash` on the destination chain's explorer once non-null.

#### X-Idempotency-Key — one key per operation

State-changing calls (`/intents/withdraw`, `/swap`, `/intents/transfer`, `/intents/deposit`, payment checks, limit orders, …) accept an optional `X-Idempotency-Key` HTTP header. Dedup is **by key only** — scoped to `(wallet, key)`; the request **body is never compared or hashed**. The key is written on the request row BEFORE any funds move, so a key seen again names the request that reserved it, whatever became of it.

- **A reused key does NOT re-execute.** It returns **HTTP `200`** (not a 4xx) with an *error* body that carries the request:
  ```json
  { "error": "duplicate_idempotency_key",
    "message": "Request already processed: <request_id of the FIRST call>",
    "request_id": "<request_id>", "type": "withdraw", "status": "processing",
    "result": { ... }, "poll_url": "/wallet/v1/requests/<request_id>",
    "created_at": "...", "updated_at": "..." }
  ```
  `status` is the request's as recorded; `poll_url` is present while it is not terminal; `result` once the row has one. For `/payment-check/create` and `/batch-create` the body also carries `checks: [{check_id, check_key, status}]` — the checks that key made, each with its key derived again: a caller that lost the create's answer gets its only copy of `check_key` back here. `check_key` is `null` when you ask with another API key than the one that created the check (keys of one wallet under different vaults derive different keys): re-send with the creating key. A batch's request reads `processing` while it runs and lists the checks reserved so far. Because it's `200`, your HTTP-error handling won't catch it: **check `body.error === "duplicate_idempotency_key"` explicitly**, then read `request_id` and `status` off the body — never parse `message`.
- **Use a distinct key per logical operation. Never share one key across two different operations.** Reusing one key across e.g. a `withdraw` and a later `deliver`/top-up call means the second call is answered with the FIRST operation's request, and your client silently stalls.
- **A key is held by the request that reserved it — including one that ended `failed` after the reserve** (a short balance, a recipient that does not exist). A refusal BEFORE the reserve — auth, a malformed body, the policy, `wallet_busy`, a bad `X-Answer-Within` — holds nothing. Retry a `failed` with `never_executed`/`never_submitted` under a **new** key; any other `failed` or `needs_review`: do not.

Recovery after a timeout or a dropped connection — the whole algorithm:
1. Mint one key per operation in your client and **persist it before sending**.
2. Send `X-Answer-Within` below your timeout (next section), or set the timeout to at least 90 s.
3. On a timeout: **re-send with the same key.** Read `request_id` and `status` from whichever answer comes — the plain one, the `200 duplicate_idempotency_key` above, or `409 wallet_busy` with `in_flight_request_id` (`null` while the request is being written: retry in a moment).
4. Poll `poll_url` until the status is terminal; act — credit, ship, release funds — on the terminal status only.
5. No header at all → the server generates a fresh UUID per call, so there is no dedup and no recovery (each call executes).

#### X-Answer-Within — answer before my timeout

`X-Answer-Within: <seconds>` (whole seconds, `0`–`80`, counted from the request's arrival) on `/intents/withdraw`, `/intents/transfer`, `/intents/swap`, `/limit-orders`, `/payment-check/create|batch-create|claim|reclaim`: how long the call waits for the settlement before answering `status: "processing"` with `request_id` and `poll_url` (`/payment-check/create`: `status: "creating"` with the check's `poll_url`). `0` answers as soon as the funds are handed over. Absent, the call waits its own budget — up to 80 s; the relay's 60 s on a same-chain withdraw or transfer. The wait only shortens: the operation runs to its outcome and settles the request whatever you waited. It does not cut the hand-over itself (one relay publish, up to 30 s), nor in `/batch-create` the hand-over of every check, which the wait follows. Out of range → `400 bad_request` before anything runs, nothing reserved. Set it a few seconds below your client's timeout; a slow settlement then answers with an id to poll instead of a dropped connection.

### Cross-chain transfer (deposit + withdraw)

For moving tokens to another chain without swapping:

```bash
# 1. Deposit tokens into intents balance
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token":"wrap.near","amount":"1000000000000000000000000"}' \
  "https://api.outlayer.ai/wallet/v1/intents/deposit"

# 2. Withdraw to destination (gasless - no NEAR needed for gas)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000000000000000000000","token":"wrap.near","chain":"near"}' \
  "https://api.outlayer.ai/wallet/v1/intents/withdraw"
```

**Withdraw NATIVE NEAR** (default for `chain=near`) - unwraps your wNEAR and delivers native NEAR; receiver needs no `wrap.near` storage. `amount` is yoctoNEAR (24 decimals; 1 NEAR = `1000000000000000000000000`):

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000000000000000000000","token":"near","chain":"near"}' \
  "https://api.outlayer.ai/wallet/v1/intents/withdraw"
```

The `/intents/withdraw` endpoint is **gasless** - it uses NEP-413 signed intents via the solver relay. No NEAR balance is required on the wallet's implicit account.

> For a **non-NEAR** destination chain, add `"async": true` to the withdraw body and poll `GET /wallet/v1/requests/{request_id}` for the terminal status — the 1Click bridge usually outlasts the synchronous response window. See "Async mode — strongly recommended for cross-chain withdrawals" above.

### Dry-run (check without executing)
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000000000000000000000","token":"wrap.near","chain":"near"}' \
  "https://api.outlayer.ai/wallet/v1/intents/withdraw/dry-run"
```

`{ would_succeed, reason?, message? }`. A bridge refusal is `would_succeed: false` with `reason` set to the same code the real withdraw answers in `error` — `no_liquidity`, `upstream_rejected` (1Click's words in `message`), `unsupported_token` — beside `wallet_frozen`, `policy_denied`, `storage_not_registered`, `recipient_not_found`, `insufficient_balance`, `invalid_request`. What was never assessed is an error, not a reason: `503 route_unavailable` (1Click did not answer), `400 unsupported_chain`, `429 operation_limit_reached`. **A dry-run counts against the wallet's daily custody ceiling** (100 per day on the free tier) like the real call; quote fees before each payment only as often as that allows, or lift the ceiling with a subscription.

### Transfer inside Intents (`/intents/transfer`) vs Withdraw

`POST /wallet/v1/intents/transfer` moves a token from your `intents.near` balance to **another account's `intents.near` balance** — gasless, and the funds **stay inside the intents pool** (the recipient is credited there, nothing lands on the public chain). This is **not** a withdrawal.

- **Use `/intents/transfer`** when the recipient also holds an intents balance (e.g. another OutLayer custody wallet) and you want to keep funds inside intents — cheapest, no exit.
- **Use `/intents/withdraw`** when the recipient should receive funds on a plain on-chain account (it runs `ft_withdraw`/`native_withdraw`, leaving the intents pool).

NEAR-only: no `chain` field, and `token` is **required** (to send NEAR, transfer `nep141:wrap.near`). The recipient need not exist on-chain — a 64-hex implicit account is a valid recipient. Same policy gating as withdraw (recipient whitelist + per-token amount limit; multisig returns `status=pending_approval`). The response is usually `status:"success"`; when the solver relay is slow it is `"processing"` with a `poll_url` — poll it, same status set as withdraw, and do NOT send the transfer again.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"partner.near","amount":"1000000","token":"nep141:usdt.tether-token.near"}' \
  "https://api.outlayer.ai/wallet/v1/intents/transfer"
```
