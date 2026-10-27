# Payment checks (agent-to-agent payments)

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

## Payment Checks (Agent-to-Agent Payments)

Payment checks enable trustless agent-to-agent payments. One agent writes a check (deposits tokens into an ephemeral account), sends the `check_key` to another agent, and the recipient claims the funds. First-to-claim semantics - no double-spend possible.

Check keys are derived in TEE from the custody keystore - deterministic and recoverable. The server never stores raw private keys.

Optional expiration: set `expires_in` when creating a check. After expiry, the recipient cannot claim via our API, and the sender can reclaim the funds.

### How it works

1. **Agent2** (buyer) creates a check for 1 USDC → gets `check_id` + `check_key`
2. **Agent2** sends `check_key` to **Agent1** (seller) via any channel (API, message, etc.)
3. **Agent1** claims the check → 1 USDC lands in Agent1's intents balance
4. **Agent1** does the work, delivers the result

If Agent1 never claims, Agent2 can reclaim the check at any time.

### Create a payment check

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","amount":"1000000","memo":"Payment for song generation","expires_in":86400}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/create"
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | yes | Plain NEAR contract ID (e.g. USDC: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) |
| `amount` | yes | Amount in smallest denomination (string) |
| `memo` | no | Human-readable memo (max 256 chars) |
| `expires_in` | no | Seconds until expiry (e.g. `86400` for 24h). Omit for no expiry. |

Response:
```json
{
  "check_id": "3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "check_key": "9f8a7b6c...64_hex_chars",
  "status": "unclaimed",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount": "1000000",
  "memo": "Payment for song generation",
  "created_at": "2026-03-12T10:30:00Z",
  "expires_at": "2026-03-13T10:30:00Z"
}
```

**`check_key` is shown only once** - this is the check itself. Send it to the recipient. The `check_id` is for your own status tracking and reclaims.

`status` is `unclaimed` once the funding transfer settled. If the relay did not
confirm it in time, the answer is `"status": "creating"` with a `poll_url`
(`/wallet/v1/payment-check/status?check_id=…`) — the `check_key` is in that answer
too, so keep it. Poll until the check reads `unclaimed` (or `failed`: the funding
never executed and nothing moved). Do not create the check again: the first one may
still land. A recipient's claim of a `creating` check is refused until it is funded.

Send `X-Idempotency-Key` on the create (and `X-Answer-Within: <seconds>` below your
own timeout — see `intents-withdraw.md`). If the answer is lost — a timeout, a dropped
connection — re-send with the same key: the `duplicate_idempotency_key` answer (HTTP
200) carries `checks: [{check_id, check_key, status}]`, the check that key made with
its `check_key` derived again, so a lost answer is not a lost key. Ask with the API key
that created the check: another key of the same wallet gets `check_key: null`. The
same holds for a batch, whose request reads `processing` while it runs and lists the
checks reserved so far.

The check is paid from the **intents** balance, and a short one is refused
(`400 insufficient_balance`) rather than topped up: move funds in first with
`POST /wallet/v1/intents/deposit`, or have the user fund you with `dest=intents`.
The balance is checked BEFORE the policy, so a wallet with nothing in intents
answers `insufficient_balance` whatever its policy says.

### Batch create payment checks

Create up to 10 checks in a single request.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"checks":[{"token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","amount":"500000","memo":"Task 1"},{"token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","amount":"500000","memo":"Task 2"}]}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/batch-create"
```

Response: `{"checks": [<same as single create>, ...]}` - one entry per check, same
fields, each with its own `status`. The balance must cover the whole batch, or nothing
is created. If the batch stops part way (rare: the relay is down), the checks already
created are listed with their keys and `"error"` says which were not created.

### Claim a payment check

Supports **partial claims** - pass `amount` to claim less than the full check. Omit for full claim.

```bash
# Full claim
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RECIPIENT_API_KEY" \
  -d '{"check_key":"9f8a7b6c...64_hex_chars"}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/claim"

# Partial claim (500000 out of 1000000)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RECIPIENT_API_KEY" \
  -d '{"check_key":"9f8a7b6c...64_hex_chars","amount":"500000"}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/claim"
```

| Param | Required | Description |
|-------|----------|-------------|
| `check_key` | yes | The check private key received from sender |
| `amount` | no | Partial claim amount (smallest units). Omit for full balance. |

Response:
```json
{
  "request_id": "uuid",
  "status": "partially_claimed",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount_claimed": "500000",
  "remaining": "500000",
  "memo": "Payment for song generation",
  "claimed_at": "2026-03-12T10:35:00Z",
  "intent_hash": "abc123..."
}
```

`status` is the check's status after this claim (`claimed` or `partially_claimed`).
If the transfer is not confirmed in time, the answer is `"status": "processing"`
with `request_id` and `poll_url` (`remaining` and `claimed_at` absent): poll
`GET /wallet/v1/requests/{request_id}` until it reads `completed` (its `result`
carries `amount_claimed` and `remaining`) or `failed` with `never_executed: true`
(nothing moved — claim again). Do not claim again while it is `processing`; send an
`X-Idempotency-Key` so a retried call answers `duplicate_idempotency_key` naming the
request (`request_id`, `status`, `poll_url`) instead of claiming twice. Send
`X-Answer-Within: <seconds>` below your own timeout to be answered `processing` in time
(see `intents-withdraw.md`, "X-Answer-Within").

Claimed funds land in the recipient's **intents balance**. Use `/intents/withdraw` to move them to a wallet or another chain. When `remaining > 0`, the check stays active for further claims or reclaim.

### Check status

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/payment-check/status?check_id=3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"
```

Response:
```json
{
  "check_id": "3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount": "1000000",
  "claimed_amount": "500000",
  "reclaimed_amount": "0",
  "memo": "Payment for song generation",
  "status": "partially_claimed",
  "created_at": "2026-03-12T10:30:00Z",
  "expires_at": "2026-03-13T10:30:00Z",
  "claimed_at": "2026-03-12T10:35:00Z",
  "claimed_by": "a1b2c3..."
}
```

| Status | Meaning |
|--------|---------|
| `creating` | Funding transfer not confirmed yet - poll; claims wait for it |
| `unclaimed` | Funds waiting - check not yet claimed |
| `claiming` / `reclaiming` | A claim or reclaim is in flight - poll; another one is refused meanwhile |
| `partially_claimed` | Recipient claimed part of the check - remaining funds available |
| `claimed` | Recipient claimed the entire check |
| `partially_reclaimed` | Sender reclaimed part - remaining available for claim |
| `reclaimed` | Sender took all remaining funds back |
| `expired` | Unclaimed and past `expires_at` - sender can reclaim |
| `failed` | The funding transfer never executed - nothing moved, create a new check |

### List payment checks

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/payment-check/list?status=unclaimed&limit=50"
```

Returns `{"checks": [...]}` - all checks created by the authenticated wallet.

### Reclaim a check (full or partial)

Supports **partial reclaims** - pass `amount` to reclaim less than the remaining balance. Omit for full reclaim.

```bash
# Full reclaim
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"check_id":"3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/reclaim"

# Partial reclaim (300000 out of remaining 500000)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"check_id":"3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d","amount":"300000"}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/reclaim"
```

| Param | Required | Description |
|-------|----------|-------------|
| `check_id` | yes | The check ID from create response |
| `amount` | no | Partial reclaim amount (smallest units). Omit for full remaining. |

Response:
```json
{
  "request_id": "uuid",
  "status": "partially_reclaimed",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount_reclaimed": "300000",
  "remaining": "200000",
  "reclaimed_at": "2026-03-12T12:00:00Z",
  "intent_hash": "def456..."
}
```

`processing` + `poll_url` works as for a claim. Reclaim works anytime the check has remaining balance - before or after expiry. Only the check creator can reclaim. When `remaining > 0`, the check stays active for further claims or reclaims.

### Peek a check (check balance by key)

Check the on-chain balance and status of a check using its key. Requires wallet auth.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"check_key":"9f8a7b6c...64_hex_chars"}' \
  "https://api.outlayer.ai/wallet/v1/payment-check/peek"
```

Response:
```json
{
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "balance": "500000",
  "memo": "Payment for song generation",
  "status": "partially_claimed",
  "expires_at": "2026-03-13T10:30:00Z"
}
```

Use this to verify a check has funds before claiming. The `balance` field is the live on-chain balance of the ephemeral account.

### Flow: Both agents in Agent Custody

```
Agent2 (buyer)                    API                        Agent1 (seller)
     |                             |                              |
     |  POST /payment-check/create |                              |
     |  {token, amount, memo}      |                              |
     |---------------------------->|                              |
     |  {check_id, check_key}      |                              |
     |<----------------------------|                              |
     |                             |                              |
     |  ---- sends check_key to Agent1 (any channel) ----------->|
     |                             |                              |
     |                             |  POST /payment-check/claim   |
     |                             |  {check_key}                 |
     |                             |<-----------------------------|
     |                             |  {token, amount}             |
     |                             |----------------------------->|
     |                             |                              |
     |                             |  Funds in Agent1's intents   |
     |                             |  balance - ready to use      |
```

### Flow: External wallet claims

External wallets can claim using the `check_key` as a NEAR Intents Gift private key directly on-chain - no API needed. Our status endpoint detects the claim by checking the ephemeral account balance.

```
Agent2 (buyer, custody)         API                    External Wallet
     |                           |                          |
     |  POST /payment-check/create                          |
     |-------------------------->|                          |
     |  {check_key}              |                          |
     |<--------------------------|                          |
     |                           |                          |
     |  ---- sends check_key (any channel) ---------------->|
     |                           |                          |
     |                           |   Claims on-chain via    |
     |                           |   NEAR Intents SDK       |
     |                           |                          |
     |  GET /payment-check/status|                          |
     |-------------------------->|                          |
     |  {status: "claimed"}      |                          |
     |<--------------------------|                          |
```

**Expiration caveat:** Expiration is enforced by our API. External wallets claiming directly on-chain can bypass expiry. For high-value checks to external wallets, reclaim promptly after expiry.
