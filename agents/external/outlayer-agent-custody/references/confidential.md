# Confidential Intents

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

## Confidential Intents

Move balances between your **public** intents shard, the **confidential**
shielded-pool shard, and external chains. Same TEE-mediated signing as the
rest of the wallet — just a different shard.

**Availability**: these routes return **HTTP 503** (`confidential_unavailable`)
unless the deployment has confidential intents enabled. Treat 503 as "not
offered here", not an error to retry.

### Endpoints

| Endpoint | Action | Body |
|---|---|---|
| `POST /wallet/v1/confidential/shield` | **SHIELD**: public intents → confidential (alias `/confidential/deposit`) | `{ token, amount }` |
| `POST /wallet/v1/confidential/unshield` | confidential → public intents | `{ token, amount }` |
| `POST /wallet/v1/confidential/withdraw` | confidential → external chain | `{ chain, to, amount, token }` |
| `POST /wallet/v1/confidential/withdraw/dry-run` | quote a withdraw | same |
| `POST /wallet/v1/confidential/transfer` | private transfer (confidential → confidential) | `{ to, amount, token }` |
| `POST /wallet/v1/confidential/swap` | confidential swap (distinct assets) | `{ token_in, token_out, amount_in }` |
| `POST /wallet/v1/confidential/swap/quote` | quote a swap | same |
| `POST /wallet/v1/confidential/deposit/cross-chain` | cross-chain DEPOSIT (returns bridge address; alias `/confidential/deposit-intent`) | `{ source_asset, amount }` |
| `GET  /wallet/v1/confidential/balance` | read confidential balances | `?token=` (optional) |

The action endpoints are **asynchronous**: they return
`{ request_id, status: "pending_deposit", intent_hash, deposit_address }`. Poll
`GET /wallet/v1/requests/{request_id}` until `status` is `success`, `failed`, or
`refunded`. An action can also answer `{ request_id, status: "processing",
deposit_address, poll_url }`: the intent was submitted and the upstream's answer
was lost. It may have been taken — **do not retry**; poll `poll_url`, the request
settles on its own (a day unresolved → `needs_review`). On `/confidential/withdraw`, `chain` is the token's **home
chain** (e.g. `chain="zcash"` for `nep141:zec.omft.near` + a Zcash
t-address), `"near"`, or another chain that lists the same symbol — there the
token arrives as that listing, swapped on the way (NEAR USDC with
`chain="hypercore"` arrives as HIP-1 USDC, with `chain="polygon"` as Polygon
USDC). A token with no such listing is rejected with 400.
`/confidential/deposit/cross-chain` credits USDC from any chain as **NEAR
USDC** unless `destination_asset` says otherwise; other tokens arrive as the
same asset, bridged.
`chain="near"` delivers to the named NEAR account: **native NEAR** for
`nep141:wrap.near` (`intents.near native_withdraw` unwraps wNEAR and sends
native), or the **NEP-141 representation on NEAR** for omft bridge assets
(e.g. `nep141:zec.omft.near` stays as the bridged ZEC token on NEAR instead
of being withdrawn to Zcash). NEP-141 delivery is a direct `ft_transfer` to
the recipient's account (a regular token balance, visible in any NEAR
wallet) — **no prior storage registration needed**: 1Click auto-registers an
unregistered recipient and nets the storage cost out of `amount_out` (the
dry-run quote already reflects it). To return funds to your **own** public
intents balance use `/confidential/unshield` instead.

### Conventions (apply to every endpoint below)

- **`Authorization: Bearer wk_…`** on every call (same key as the rest of the
  wallet — no separate confidential key).
- **`X-Idempotency-Key: <uuid>`** is supported on every action endpoint. A
  retry with the same key returns the original `request_id` instead of acting
  twice. Use one per logical user action.
- **Token IDs**: defuse asset id (`nep141:wrap.near`). Plain contract IDs
  (`wrap.near`) are also accepted and auto-prefixed.
- **Amounts**: minimal integer units as a **string**. wNEAR/NEAR 24 decimals
  (`"10000000000000000000000"` = 0.01 NEAR). USDC 6 decimals (`"1000000"` = 1
  USDC). Same convention as the public `/intents/*` endpoints.
- **`request_id` from the action response is the poll key**: keep it,
  `GET /wallet/v1/requests/{request_id}` returns the merged
  `{ status, result }` until terminal. `result.intent_hash` /
  `result.deposit_address` mirror the action response; `result.swap_details`
  appears once the solver settles. For a **swap**, the realized fill is
  `result.amount_out` **only once `status` is `success`** (same rule as the
  public `/intents/swap` — see *Reading `amount_out` correctly* in `intents-swap.md`). The
  confidential submit response carries **no `amount_out`**, and `result.amount_out`
  holds the **quote estimate** until settlement — this is **timing, not
  privacy**: the actual delivered amount *is* returned, just at `success`. A 90s /
  30×3s poll window can expire before `success`; keep polling rather than
  recording the quote.
- **No `tx_hash`**: confidential ops don't put your signed intent on the
  public chain (the private shard's settlement isn't a public tx). Track by
  `request_id` and `intent_hash`. **One real txid does exist**: once the op is
  terminal, `result.swap_details.destinationChainTxHashes` (plain hash
  strings; the `swap_details` container is snake_case but its inner keys are
  1Click-style **camelCase**) holds the delivery transaction on the
  destination chain — for a `/confidential/withdraw` this is the tx that paid
  the recipient, and it IS safe to show as an explorer link on that chain.
  (`originChainTxHashes`, `intentHashes`, `nearTxHashes` are also arrays of
  plain strings; they stay private-shard/NEAR identifiers — the explorer-link
  rule in `intents-withdraw.md` still applies to them.) Empty until settlement, and may stay
  empty for shard-internal ops (shield / unshield / transfer / swap).

### Method reference (body + response, per endpoint)

`ConfidentialOpResponse` (the shared async-action response):

```json
{ "request_id": "uuid", "status": "pending_deposit", "intent_hash": "...", "deposit_address": "..." }
```

`QuotePreview` (returned by `/withdraw/dry-run` and `/swap/quote`):

```json
{
  "amount_out": "...", "min_amount_out": "...",
  "deadline": "2026-…T…Z", "time_estimate_seconds": 10
}
```

When 1Click gives no estimate for the route, `amount_out` and `min_amount_out`
are absent and `"hint": "1Click gave no output estimate for this route"` is
present. It is still a 200; asking again gives the same answer.

| Endpoint | Body | Response | Notes |
|---|---|---|---|
| `POST /wallet/v1/confidential/shield` | `{ token, amount }` | `ConfidentialOpResponse` | SHIELD — wallet must already hold `token` in its **public** intents balance. Canonical; legacy alias `POST /wallet/v1/confidential/deposit` still works |
| `POST /wallet/v1/confidential/unshield` | `{ token, amount }` | `ConfidentialOpResponse` | Reverse of SHIELD; returns funds to **your own** public intents balance |
| `POST /wallet/v1/confidential/withdraw` | `{ chain, to, amount, token }` (all required) | `ConfidentialOpResponse` | `chain` is the token's **home chain**, `"near"`, or another chain listing the same symbol (delivered as that listing, swapped on the way); a token with no listing there (e.g. `chain="bitcoin"` + a ZEC token) or an address of the wrong chain is rejected with 400. `chain="near"` delivers to the named `to` account: **native NEAR** for `nep141:wrap.near` (1Click `native_withdraw` unwraps wNEAR), or the **NEP-141 token on NEAR** for omft bridge assets (ZEC arrives as `zec.omft.near`, not on Zcash). To return funds to your **own** public intents balance use `/confidential/unshield` instead. Chains are the 1Click catalog's (`GET /wallet/v1/tokens`), the home chain included; a chain the catalog does not list is `400 unsupported_chain`. HOT-bridged assets (`nep245:v2_1.omni.hot.tg:<chainId>_…`) are accepted, their chain read from the catalog; a `1cs_v1:near:nep141:…` id names the same balance as `nep141:…`. The NEAR-side `ft_withdraw` is signed by a 1Click hop — your wallet stays off the public chain |
| `POST /wallet/v1/confidential/withdraw/dry-run` | same as `withdraw` | `QuotePreview` | No DB write, no sign/submit. Use to preview spread/eta before the real call |
| `POST /wallet/v1/confidential/transfer` | `{ to, amount, token }` (no `chain`) | `ConfidentialOpResponse` | `to` = recipient's `intentsUserId` (their 64-hex NEAR implicit address). NEAR-only context. Recipient must also have confidential intents enabled on their deployment |
| `POST /wallet/v1/confidential/swap` | `{ token_in, token_out, amount_in, min_amount_out? }` | `ConfidentialOpResponse` | `token_in != token_out`; `min_amount_out` enforced before signing (rejects 400 if quote below floor) |
| `POST /wallet/v1/confidential/swap/quote` | same as `swap` | `QuotePreview` | Read-only; no DB, no sign. Preview the swap rate |
| `POST /wallet/v1/confidential/deposit/cross-chain` | `{ source_asset, amount }` **or** `{ chain, token?, amount }` (`token` defaults to `"USDC"`) | `{ intent_id, deposit_address, amount, amount_out?, min_amount_out?, expires_at?, hint? }` | Quote-only — returns the bridge address on the source chain; you then send funds out-of-band on that chain. **Privacy-preserving path**: your NEAR wallet never touches the public chain. Canonical; legacy alias `POST /wallet/v1/confidential/deposit-intent` still works |
| `GET /wallet/v1/confidential/balance?token=` | query string | `{ balance, token, account_id }` (filtered) or `{ balances: [{ token, balance }, …], account_id }` (no filter) | Reads `/v0/account/balances` from the private shard. Zero-balance tokens are **omitted** from the unfiltered list |

### More curl examples

```bash
# WITHDRAW 0.5 USDC from confidential to a Solana address (gasless, async)
curl -sX POST $BASE/wallet/v1/confidential/withdraw \
  -H "Authorization: Bearer $WK" -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -d '{"chain":"solana","to":"<sol-addr>","amount":"500000","token":"nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"}'
# → {"request_id":"…","status":"pending_deposit","intent_hash":"…","deposit_address":"…"}

# DRY-RUN the same withdraw (preview spread + eta, no commit)
curl -sX POST $BASE/wallet/v1/confidential/withdraw/dry-run \
  -H "Authorization: Bearer $WK" -H "Content-Type: application/json" \
  -d '{"chain":"solana","to":"<sol-addr>","amount":"500000","token":"nep141:sol-…omft.near"}'
# → {"amount_in":"500000","amount_out":"440000","min_amount_out":"435600","time_estimate_seconds":7,...}

# Privacy-preserving FUND path: get a Solana bridge address; send funds on Solana
curl -sX POST $BASE/wallet/v1/confidential/deposit-intent \
  -H "Authorization: Bearer $WK" -H "Content-Type: application/json" \
  -d '{"source_asset":"nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near","amount":"500000"}'
# → {"intent_id":"…","deposit_address":"<Solana addr>","amount":"500000","amount_out":"500000",...}

# Private transfer to another confidential identity (no public-chain trace)
curl -sX POST $BASE/wallet/v1/confidential/transfer \
  -H "Authorization: Bearer $WK" -H "Content-Type: application/json" \
  -d '{"to":"<their 64-hex intentsUserId>","amount":"1000000","token":"nep141:wrap.near"}'

# Confidential swap (distinct assets, min_amount_out floor enforced)
curl -sX POST $BASE/wallet/v1/confidential/swap \
  -H "Authorization: Bearer $WK" -H "Content-Type: application/json" \
  -d '{"token_in":"nep141:wrap.near","token_out":"nep141:17208628f...a1","amount_in":"10000000000000000000000","min_amount_out":"22500000"}'

# Poll any action's progress
curl -s $BASE/wallet/v1/requests/<request_id> -H "Authorization: Bearer $WK"
# → {"status":"success","result":{"intent_hash":"…","deposit_address":"…","amount_out":"22513900","swap_details":{...},"oneclick_status":"SUCCESS",...}}

# Read confidential balance for one asset, or all
curl -s "$BASE/wallet/v1/confidential/balance?token=nep141:wrap.near" -H "Authorization: Bearer $WK"
curl -s $BASE/wallet/v1/confidential/balance                          -H "Authorization: Bearer $WK"
```

### Errors

| HTTP | `error` | Meaning |
|---|---|---|
| 503 | `confidential_unavailable` | confidential intents not enabled on this deployment — **don't retry**, route to a different deployment or fall back to public intents |
| 502 | `confidential_jwt_expired` / `keystore_error` | upstream (1Click / keystore) hiccup; the coordinator already retried auth once. Safe to retry |
| 403 | `policy_denied` / `wallet_frozen` | blocked by the wallet's on-chain policy (same engine as `/intents/withdraw`). Don't retry without changing the policy |
| 400 | `bad_request` | bad input — missing `to`/`token`, `token_in == token_out` on swap, quote `amount_out` below `min_amount_out`, etc. (note: `chain="near"` on withdraw is **valid** — native NEAR delivery) |

### Privacy model — read this before relying on "confidential"

The confidential shard is a separate **private shard** — the `intents.far`
contract, distinct from public `intents.near` — NOT a Tor-like anonymity
network. Confidential balances are **real on-chain state** on that private
shard, not off-chain and not a solver database: it is an auditable smart
contract. The privacy is that the private shard has **no public RPC** — you
cannot read it from public mainnet (`intents.far` resolves as
`UNKNOWN_ACCOUNT` there) — but the operator/Defuse, auditors, or law
enforcement with a warrant **can** read it. Only edges (shield/unshield,
cross-chain in/out) touch the **public** chain, and those carry only **public**
asset ids and **public-side** participants.

**What public chain observers see, by direction** (SHIELD and cross-chain DEPOSIT/WITHDRAW verified against mainnet; UNSHIELD and internal transfer/swap inferred by protocol symmetry, not yet exercised live):

| Direction | Your wallet on chain? | Asset id on chain | Amount on chain | Notes |
|---|---|---|---|---|
| SHIELD (`INTENTS → CONFIDENTIAL`) | **yes** (signer of inner intent) | public `nep141:…` | yes | "entry" reveal: full link wallet ↔ confidential pool |
| UNSHIELD (mirror) | **yes** | public `nep141:…` | yes | "exit-to-public" reveal: same as SHIELD inverted |
| internal CONFIDENTIAL ops (transfer, swap) | **no** | n/a | n/a | settle on the private shard — no **public-chain** trace |
| DEPOSIT `ORIGIN_CHAIN → CONFIDENTIAL` | **no** | public on source chain + NEAR bridge mint | yes | source-chain sender visible on source chain only |
| WITHDRAW `CONFIDENTIAL → DESTINATION_CHAIN` | **no** | public dest-chain token | yes (after bridge fee) | dest-chain receiver visible on dest chain only; the NEAR-side `ft_withdraw` is signed by a 1Click hop |

**What is NOT hidden, ever:**

- **Defuse / 1Click solvers** see plaintext intents pre-execution. They know the
  asset, signer, recipient, amount, and the route. Privacy holds against public
  chain observers, not against the solver layer.
- **`partner_id` mapping**: all per-account JWTs issued under our partner JWT are
  tagged with `partner_id=near-agents-market`. Defuse can enumerate every
  confidential identity we mint under that partner.
- **Source-chain identity**: the externally-funded chain side (Solana sender
  address, EVM `from`, BTC input UTXO) is fully public — no protocol-level hiding.

**Strongest-privacy recipe**: avoid SHIELD/UNSHIELD (they link your wallet
on-chain). Instead fund the confidential balance via cross-chain DEPOSIT
(`/confidential/deposit/cross-chain`), do your work inside the shard (transfer/swap —
settles on the private shard, no public-chain trace), and exit via cross-chain
WITHDRAW. In that flow your NEAR custody address never appears on the public
chain. The only residual attack surface is
**timing/amount correlation** between the source-chain deposit and the
destination-chain delivery — mitigate with jitter and amount splitting.

> Each wallet has one confidential identity — your custody wallet itself. There
> is no separate or unlinkable confidential identity.
