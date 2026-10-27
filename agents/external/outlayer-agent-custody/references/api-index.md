# API index: tasks, endpoints, errors

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

| You need... | Action |
|-------------|--------|
| A crypto wallet for your agent | Register via `POST /register` |
| Try the connectors for free | Claim a trial key with `POST /trial-key`, then send it as `X-Payment-Key`; read it again with `GET /wallet/v1/payment-key` |
| Somebody gave you a sponsor code | `POST /wallet/v1/sponsorship {code}` — a subscription on the nonce-0 key, paid by the sponsor (the `outlayer-connectors` skill) |
| Check what is left on any key | `GET /payment-keys/balance` with `X-Payment-Key` — money in `available`; a trial key answers in calls, `trial.calls_left` |
| Run your own WASI module | No free tier — create and fund a payment key |
| Upgrade to paid execution | Use `POST /wallet/v1/create-payment-key` (USDC or NEAR) |
| Give an agent a key to spend | Claim the trial (`POST /trial-key`) or create one (`POST /wallet/v1/create-payment-key`), then hand it the string |
| Stop paying per call for connectors | Buy a subscription for the key the agent presents — unless it is the trial (`nonce` 0): then create a payment key and buy on that one. See the `outlayer-connectors` skill |
| Check the agent's allowance and expiry | `GET /subscription/status` with `X-Payment-Key` — the key reports on itself |
| Send NEAR to someone | Use `POST /wallet/v1/transfer` with `chain: "near"` |
| Send FT tokens (USDT, wNEAR) to someone | Use `POST /wallet/v1/call` with `ft_transfer` (see `wallet-ops.md`) |
| Swap tokens (e.g. wNEAR to USDT) | Use `POST /wallet/v1/intents/swap` - gasless swap via 1Click. Tokens must be in intents balance first |
| Preview swap rate before committing | Use `POST /wallet/v1/intents/swap/quote` - read-only, no gas spent |
| List available tokens for swaps | Use `GET /wallet/v1/tokens` - returns ~200 tokens across 20+ chains |
| Withdraw native NEAR (gasless) | Use `POST /wallet/v1/intents/withdraw` with `chain: "near"` and `token: "near"` (default). Unwraps your wNEAR → native NEAR; receiver needs **no** storage. Recipient account must already exist (or be a 64-char implicit account) |
| Send tokens cross-chain (gasless) | Use `POST /wallet/v1/intents/withdraw` with `chain` param - gasless. **For non-NEAR chains pass `"async": true` and poll the result (the bridge rarely finishes in the sync window).** For NEAR delivering wNEAR (`token: "nep141:wrap.near"`): receiver must have storage (use `/storage-deposit` first). For Solana: use `chain: "solana"` |
| Register token storage | Use `POST /wallet/v1/storage-deposit` - needed before withdrawing to accounts without storage |
| Transfer tokens to another account's intents balance | Use `POST /wallet/v1/intents/transfer` with `{ to, amount, token }` — gasless; stays **inside** `intents.near` (recipient is credited there, not on-chain). NOT a withdrawal — use this when the recipient also holds an intents balance. Recipient need not exist on-chain (64-hex implicit is fine) |
| Move FT from wallet into Intents | Use `POST /wallet/v1/intents/deposit` - on-chain, needs gas |
| Call a NEAR smart contract | Use `POST /wallet/v1/call` - on-chain, needs gas |
| Check your balance | Use `GET /wallet/v1/balance?chain=near` or `&token=usdt.tether-token.near` |
| Check intents deposit balance | Use `GET /wallet/v1/balance?token=wrap.near&source=intents` |
| Get your NEAR, EVM, or Solana address | Use `GET /wallet/v1/address?chain=near` (or `?chain=polygon`/`ethereum`/`base`/… — all EVM chains return ONE shared `0x` address; `?chain=solana` returns the base58 ed25519 address); the account is in the `address` field |
| Sign an EIP-712 order / typed data (EVM) | `POST /wallet/v1/evm/sign-typed-data` with `{chain, typed_data}` — off-chain; signs Polymarket-style CLOB orders. Gated by `evm_sign` |
| Sign an EIP-191 message (EVM) | `POST /wallet/v1/evm/sign-message` with `{chain, message}` — e.g. venue L1 auth / CLOB API-key derivation |
| Sign a raw EVM transaction | `POST /wallet/v1/evm/sign-transaction` with `{chain, unsigned_tx}` — you serialize + broadcast; gated by `evm_sign.raw_tx` (default-OFF) |
| Sign a Solana off-chain message | `POST /wallet/v1/solana/sign-message` with `{chain:"solana", message}` — Sign-in-with-Solana / venue auth; raw-bytes ed25519, base58 signature. Gated by `solana_sign` |
| Sign a Solana transaction | `POST /wallet/v1/solana/sign-transaction` with `{chain:"solana", unsigned_tx}` (base64 serialized tx **message**) — you assemble + broadcast; gated by `solana_sign.raw_tx` (default-OFF) |
| Delete the wallet | Use `POST /wallet/v1/delete` - deletes on-chain account, sends NEAR to beneficiary. Wallet must have NEAR balance |
| Ask user to fund your wallet | Generate a fund link (see `funding-and-payment-keys.md`) or share your NEAR address |
| Sell or buy at a price you choose, not the market's | `POST /wallet/v1/limit-orders` - the order rests on 1Click until it fills, you cancel it, or 7 days pass. See `limit-orders.md` |
| See how a resting order is doing | `GET /wallet/v1/limit-orders/{order_id}` (live). `GET /wallet/v1/limit-orders?open=true` lists your orders as last recorded - it does not refresh them. Paged: `limit` 1..100 (default 50; more answers 400) and `offset` |
| Pull a resting order (or all of them) | `POST /wallet/v1/limit-orders/{order_id}/cancel`, or `POST /wallet/v1/limit-orders/cancel-all` - never policy-gated, works on a frozen wallet |
| Pay another agent (write a check) | `POST /wallet/v1/payment-check/create` - get `check_key` to send |
| Pay multiple agents at once | `POST /wallet/v1/payment-check/batch-create` - up to 10 checks |
| Receive payment from another agent | `POST /wallet/v1/payment-check/claim` with the `check_key` you received |
| Claim only part of a check | `POST /wallet/v1/payment-check/claim` with `amount` param |
| See if your check was cashed | `GET /wallet/v1/payment-check/status?check_id={id}` |
| Take back an unclaimed check | `POST /wallet/v1/payment-check/reclaim` (supports partial via `amount`) |
| Check a check's balance by key | `POST /wallet/v1/payment-check/peek` with `check_key` |
| Deposit from another chain (Solana, Ethereum, etc.) | `POST /wallet/v1/intents/deposit/cross-chain` (alias `/deposit-intent`) with `source_asset` (defuse asset id from `GET /wallet/v1/tokens`) - get a deposit address, user sends tokens, 1Click bridges to intents |
| Check cross-chain deposit status | `GET /wallet/v1/intents/deposit/cross-chain/status?id={intent_id}` - poll until `success` |
| Withdraw to another chain | `POST /wallet/v1/intents/withdraw` with `chain` param (e.g. `"solana"`, `"ethereum"`) - gasless. **Pass `"async": true` and poll `GET /wallet/v1/requests/{request_id}` — the bridge rarely settles within the synchronous window (see `intents-withdraw.md`)** |
| List cross-chain deposits | `GET /wallet/v1/intents/deposit/cross-chain/list` (alias `/deposits`) |
| Move funds into the private (confidential) shard | `POST /wallet/v1/confidential/shield` with `{ token, amount }` — SHIELD from public intents balance; **publicly links your wallet on chain** (entry reveal). Canonical; legacy alias `/wallet/v1/confidential/deposit` still works |
| Move funds back from private to public | `POST /wallet/v1/confidential/unshield` with `{ token, amount }` — reverse SHIELD (exit reveal) |
| Fund private balance **without** linking your wallet | `POST /wallet/v1/confidential/deposit/cross-chain` with `{ source_asset, amount }` → returns a bridge address on the source chain; send funds there. Your NEAR wallet never touches the public chain. Canonical; legacy alias `/wallet/v1/confidential/deposit-intent` still works |
| Withdraw private balance to an external chain (no link) | `POST /wallet/v1/confidential/withdraw` with `{ chain, to, amount, token }` — gasless; your wallet stays off the public chain. `chain` must be the token's **home chain** or `"near"` (mismatch → 400). `chain="near"` delivers **native NEAR** for `wrap.near` (1Click runs `native_withdraw` on `intents.near`) and the **NEP-141 token on NEAR** for omft bridge assets (e.g. ZEC → `zec.omft.near` to a NEAR account); for sending back to your **own** public balance use `unshield` instead |
| Preview a confidential withdraw | `POST /wallet/v1/confidential/withdraw/dry-run` — same body, no commit |
| Private transfer to another wallet's private balance | `POST /wallet/v1/confidential/transfer` with `{ to, amount, token }` — no public-chain trace |
| Swap tokens privately | `POST /wallet/v1/confidential/swap` with `{ token_in, token_out, amount_in, min_amount_out? }` — distinct assets, no public-chain trace |
| Preview a confidential swap | `POST /wallet/v1/confidential/swap/quote` |
| Read your private (confidential) balance | `GET /wallet/v1/confidential/balance?token={defuse_id}` or omit `token` for all |
| Authenticate to an external service | `POST /wallet/v1/sign-message` - NEP-413 signed message for login/auth |
| Let the user set spending limits | Share the `handoff_url` from registration |
| Create wallets for users (no per-user keys) | Use deterministic registration: `POST /register` with NEAR signature fields |
| Authenticate with NEAR key (no stored secrets) | Use `Bearer near:<base64url>` header instead of `Bearer wk_...` |
| Use your OWN per-customer master (no shared TEE) | Tell the user to deploy a sovereign vault — see `register-and-auth.md` |
| Create sub-agent (custody wallet) | `PUT /wallet/v1/api-key` with Bearer auth + `{seed, key_hash}` — see `register-and-auth.md` |
| Create sub-agent (external NEAR key) | Derive `wk_` key, sign with your NEAR key, register hash via `PUT /wallet/v1/api-key` |
| Revoke a sub-agent's key | `DELETE /wallet/v1/api-key/{key_hash}` (last key protected) |

## Quick Reference

| Action | Method | Endpoint | Gas |
|--------|--------|----------|-----|
| Register (random) | POST | `/register` | - |
| Register (deterministic) | POST | `/register` (with NEAR sig body) | - |
| Register delegate key | PUT | `/wallet/v1/api-key` (Bearer or NEAR sig) | - |
| Revoke delegate key | DELETE | `/wallet/v1/api-key/{key_hash}` | - |
| Claim the trial key | POST | `/trial-key` | - |
| Read the nonce-0 key again | GET | `/wallet/v1/payment-key` | - |
| Redeem a sponsor code | POST | `/wallet/v1/sponsorship` | - |
| Payment key balance | GET | `/payment-keys/balance` | - |
| Turn a key's balance into a subscription (`X-Payment-Key`, nonce ≥ 1) | POST | `/subscription/purchase` | - |
| Which purchase step the wallet is on | GET | `/wallet/v1/subscription/purchase-info` | - |
| Create payment key | POST | `/wallet/v1/create-payment-key` | on-chain |
| Get address | GET | `/wallet/v1/address?chain={chain}` | - |
| Get balance | GET | `/wallet/v1/balance?chain={chain}&token={token}` | - |
| Get intents balance | GET | `/wallet/v1/balance?token={token}&source=intents` | - |
| Transfer NEAR | POST | `/wallet/v1/transfer` | on-chain |
| Call contract | POST | `/wallet/v1/call` | on-chain |
| Record account binding | PUT | `/wallet/v1/binding` | - |
| Read account binding | GET | `/wallet/v1/binding` | - |
| End account binding | DELETE | `/wallet/v1/binding` | - |
| Installation kit (personal_account) | GET | `/wallet/v1/binding/setup?kind=personal_account` | - |
| Bound account balance | GET | `/wallet/v1/binding/balance` | - |
| Spend from bound account | POST | `/wallet/v1/binding/transfer` | `to`, `amount`, `token?`, `memo?` |
| Delete wallet | POST | `/wallet/v1/delete` | on-chain |
| Register token storage | POST | `/wallet/v1/storage-deposit` | on-chain |
| Move FT: wallet → intents.near | POST | `/wallet/v1/intents/deposit` | on-chain |
| Withdraw native NEAR / wNEAR / cross-chain (gasless, default) | POST | `/wallet/v1/intents/withdraw` | gasless |
| Dry-run withdrawal | POST | `/wallet/v1/intents/withdraw/dry-run` | - |
| Swap tokens | POST | `/wallet/v1/intents/swap` | gasless |
| Swap quote | POST | `/wallet/v1/intents/swap/quote` | - |
| Deposit from any chain | POST | `/wallet/v1/intents/deposit/cross-chain` | cross-chain (alias `/deposit-intent`) |
| Check deposit status | GET | `/wallet/v1/intents/deposit/cross-chain/status?id={id}` | - (alias `/deposit-status`) |
| List deposits | GET | `/wallet/v1/intents/deposit/cross-chain/list` | - (alias `/deposits`) |
| Confidential: SHIELD public→confidential | POST | `/wallet/v1/confidential/shield` | confidential (alias `/confidential/deposit`) |
| Confidential: confidential→public | POST | `/wallet/v1/confidential/unshield` | confidential |
| Confidential: withdraw to external chain | POST | `/wallet/v1/confidential/withdraw` | confidential |
| Confidential: dry-run withdraw | POST | `/wallet/v1/confidential/withdraw/dry-run` | - |
| Confidential: private transfer | POST | `/wallet/v1/confidential/transfer` | confidential |
| Confidential: swap inside private shard | POST | `/wallet/v1/confidential/swap` | confidential |
| Confidential: swap quote | POST | `/wallet/v1/confidential/swap/quote` | - |
| Confidential: cross-chain DEPOSIT (bridge address) | POST | `/wallet/v1/confidential/deposit/cross-chain` | confidential (alias `/confidential/deposit-intent`) |
| Confidential: read balance | GET | `/wallet/v1/confidential/balance?token={token}` | - |
| List tokens | GET | `/wallet/v1/tokens` | - |
| Request status | GET | `/wallet/v1/requests/{request_id}` | - |
| List requests | GET | `/wallet/v1/requests` | - |
| Sign message (NEP-413) | POST | `/wallet/v1/sign-message` | - |
| Sign EVM typed data / message / raw tx | POST | `/wallet/v1/evm/sign-typed-data` · `/evm/sign-message` · `/evm/sign-transaction` | - (off-chain; you broadcast) |
| Sign Solana message / transaction | POST | `/wallet/v1/solana/sign-message` · `/solana/sign-transaction` | - (off-chain; you broadcast) |
| Audit log | GET | `/wallet/v1/audit?limit=50` | - |
| Place a limit order | POST | `/wallet/v1/limit-orders` | gasless |
| List limit orders | GET | `/wallet/v1/limit-orders?open={bool}&limit={1..100}&offset={n}` | - |
| Read a limit order | GET | `/wallet/v1/limit-orders/{order_id}` | - |
| Cancel a limit order | POST | `/wallet/v1/limit-orders/{order_id}/cancel` | - |
| Cancel all resting orders | POST | `/wallet/v1/limit-orders/cancel-all?offset={n}&limit={1..50}` | - |
| Create payment check | POST | `/wallet/v1/payment-check/create` | gasless |
| Batch create checks | POST | `/wallet/v1/payment-check/batch-create` | gasless |
| Claim payment check | POST | `/wallet/v1/payment-check/claim` | gasless |
| Check status | GET | `/wallet/v1/payment-check/status?check_id={id}` | - |
| List checks | GET | `/wallet/v1/payment-check/list` | - |
| Reclaim check | POST | `/wallet/v1/payment-check/reclaim` | gasless |
| Peek check balance | POST | `/wallet/v1/payment-check/peek` | - |

**Gas column:** `on-chain` = wallet pays gas (needs NEAR), `gasless` = solver relay pays, `cross-chain` = 1Click bridge (fee ~0.2%), `confidential` = 1Click solver settles on the private shard (no wallet gas, no wallet on the public chain except for SHIELD/UNSHIELD edges), `-` = no transaction.

All endpoints except `/register` and `PUT /wallet/v1/api-key` require `Authorization: Bearer <api_key>` or `Bearer near:<base64url>` header.
Base URL: `https://api.outlayer.ai`

## Error Handling

| Error | Meaning |
|-------|---------|
| `missing_auth` | No `Authorization: Bearer` header |
| `invalid_api_key` | Key revoked or not found |
| `session_replaced` | The owner's session on that device ended: the account signed in on one device more than it may have, and that one was signed in longest ago. The owner signs in again |
| `session_required` | The route for the owner's dashboard (`pending_approvals_by_pubkey`) was called without an owner's session. One approval by its id (`approval/{id}`) needs none. Not an agent's route: use `GET /wallet/v1/pending_approvals` with your `wk_` key |
| `not_wallet_owner` | The signed-in owner asked about a wallet whose policy another account owns |
| `policy_denied` | Operation blocked by policy rules |
| `wallet_frozen` | Wallet frozen by controller |
| `insufficient_balance` | Not enough funds |
| `unsupported_chain` | HTTP 400: the chain is not in the 1Click catalog right now (`GET /wallet/v1/tokens`); the message names what is. Terminal for the request as sent |
| `unsupported_token` | HTTP 400: the asset is not one this route carries — not in the catalog, no listing of its symbol on that chain, 1Click's "tokenIn is not valid", or a `1cs_v1:` id on another chain given as a source. Terminal for the request as sent |
| `no_liquidity` | HTTP 400 on swap, quote or withdraw: 1Click found no route with liquidity for this pair at this amount. Try another amount or route, not the same request again |
| `upstream_rejected` | HTTP 400 on swap, quote or withdraw: 1Click refused on grounds of its own (an amount under the bridge minimum, for one); `message` is 1Click's text, verbatim. The same request fails the same way again |
| `route_unavailable` | HTTP 503 + `Retry-After` on swap, quote or withdraw: 1Click did not answer (a 5xx, a timeout, "Failed to get quote"). Nothing is known about the route — wait the header's seconds and send the same request again |
| `operation_limit_reached` | HTTP 429 + `Retry-After` on any custody operation (transfer, withdraw, swap, dry-run, …): the wallet's ceiling — the free tier allows **100 custody operations per wallet per day**, dry-runs included, swap quotes not. The body carries `limit`, `window`, `operation` and `retry_after_seconds` (null when unknown); `terminal` is false. Wait it out, or lift it with a subscription on the wallet's own key |
| `pending_approval` | Needs multisig approval (not an error) |
| `"too many approval votes"` | More than **16** approvals or rejections in one signing request (HTTP 400). Send only the votes that count toward the threshold — see "Multisig limits" in `intents-withdraw.md` |
| HTTP **402** on a vault-bound wallet | The **vault** cannot pay for its on-chain key derivation (this is the vault's gas, not the wallet's balance). The body carries the amount to top up. Distinct from `insufficient_balance`, which is the wallet's own funds |
| `"token_in must be an asset id with a nep141:, nep245: or 1cs_v1: prefix"` (HTTP 400) | Swap token without a prefix — use an id from `/tokens`. A `1cs_v1:` id on another chain as `token_in` is `unsupported_token` (a source is named by its id on intents.near; `1cs_v1:near:nep141:…` is accepted) |
| `"amount_in must be an integer amount…"` / `"min_amount_out must be an integer amount…"` (HTTP 400) | Swap amounts are decimal strings of integer minimal units — no decimal point, exponent or whitespace. A floor that cannot be read is refused, never treated as 0 |
| `"Quote amount_out (X) is less than min_amount_out (Y); nothing was signed"` (HTTP 400) | The fresh quote fell below your floor. Re-quote and retry, or lower `min_amount_out` |
| `"1Click swap was refunded"` | Solver couldn't fill - tokens returned to wallet |
| `"1Click's terms for this order are worse than the ones authorised"` | Limit order: the upstream asked for more, or promised less, than your policy approved. The order was cancelled unfunded — nothing was sent. Re-quote and retry |
| `"Limit order amount must be at least 0.1 USD"` | Limit order below 1Click's minimum order value |
| `"Limit orders are not configured on this deployment"` (503) | This deployment has no 1Click partner key. Not transient — do not retry |
| `check_already_claimed` | Payment check was already claimed by recipient |
| `check_not_found` | No check with this ID for the authenticated wallet |
| `invalid_check_key` | Key format invalid or does not correspond to a check |
| `check_empty` | Ephemeral account has zero balance (already claimed on-chain) |
| `check_already_reclaimed` | Check was already reclaimed by sender |
| `check_expired` | Check expired - cannot claim (sender can reclaim) |
| `memo_too_long` | Memo exceeds 256 characters |
| `timestamp_expired` | Signature timestamp outside allowed window (±30s for Bearer, ±5min for register/api-key) |
| `conflict` | Cannot revoke last active API key (409) |
| `upstream_unavailable` | HTTP 503: a service behind the API is briefly unreachable. Transient — wait the `Retry-After` seconds and send the same request again |
| `internal_error` | HTTP 500: a platform fault. Sending the same request again does not help — report it with the request you sent |
| `"Ambiguous auth"` | PUT /api-key received both Bearer header and signature fields in body — use one or the other |
| `"seed: 1-256 chars required"` | Empty or oversized seed in register or api-key |
| `"seed: only [a-zA-Z0-9._-] allowed"` | Seed contains forbidden characters (NUL, colon, whitespace, Unicode, etc) — use SHA-256 hex or alphanumeric |
| `trial_already_claimed` | This account has already had its trial key; read it again with `GET /wallet/v1/payment-key` |
| `no_payment_key` | `GET /wallet/v1/payment-key`: the wallet has no nonce-0 key yet — claim the trial or redeem a sponsor code |
| `payment_key_not_recoverable` | The nonce-0 key was issued at random before keys were derived and was shown once. A sponsor code redeem that sends it as `X-Payment-Key` moves the slot to a derived key; otherwise create a payment key |
| `sponsor_code_invalid` | The code cannot be redeemed by this wallet now, for any reason. Terminal; ask whoever gave it |
| `sponsor_cannot_top_up` | The key can already spend more than the code gives; nothing changed |
| `payment_key_revoked` | The `wk_` the nonce-0 key was claimed with is revoked, and the key with it; create a payment key |
| `payment_key_other_credential` | The nonce-0 key was claimed with another credential of this wallet; only that one reads it |
| `payment_key_deleted` | The wallet's nonce-0 key was deleted and cannot be issued again; create a payment key |
| `trial_window_closed` | The wallet is past its first week (`trial.days` in `/register`); create and fund a payment key instead |
| `trial_unavailable` | No trial is offered to this caller. Terminal — create and fund a payment key |
| `trial_exhausted` | The trial's calls (`trial.calls` in `/register`, fifty today) are made. Terminal; a funded key has no call limit |
| `trial_expired` | The trial key is past the wallet's first week. Terminal; create and fund a payment key |
| `out_of_funds` | The allowance is spent or has burned. TERMINAL — fund a payment key or buy a subscription |
| `trial_key_not_purchasable` | `POST /subscription/purchase` with the trial key (`nonce` 0), converted or not (HTTP 400). Terminal for that key — create a payment key (nonce ≥ 1), fund it, buy on it |
| `Access denied by access condition` | A secret exists, but its condition does not admit your wallet's own 64-character account. Ask the owner to name that account, or name a row that already admits you |
| `… its time limit passed at <date>` | You WERE admitted and the grant has expired. Ask for a new grant with a later date; being named again without one changes nothing |
| `invalid_secrets_ref` | `/call` (400): the `secrets_ref` names a row that cannot exist — the account is not a NEAR account id, or the profile is not 1–64 bytes or holds an ASCII character other than a letter, digit, `-` or `_`. Fix the reference |
| `trial_disabled` | `POST /trial-key` (404, terminal): this deployment offers no trial. Create and fund a payment key |
| `policy_row_not_owner` | `/call` on `hyperliquid`/`polymarket` (403, terminal): the call named a policy row of an account that is not the wallet's owner. Send no `secrets_ref` |
| `calls_suspended` | `/call` (403, `terminal: false`): the wallet is blocked on both trading connectors for a while after naming other accounts' rows; the same call works once the block ends. Stop naming them |
| `policy_row_missing:` | `/call` on `hyperliquid`/`polymarket`: the run is `status: "failed"` with this prefix on the top-level `error` — the named row's profile is not the connector's id and nobody stored it. Name a stored row, or none |
| `wallet_not_yours` | `/call` (403, terminal): `X-Wallet-Id` names a wallet the payment key does not identify. Send the wallet's own `wallet_id` |
| `timeout` | `/call` (408): the call did not finish in the synchronous window; it may still execute and is charged. Do not resend — read `poll_url` (`/calls/{call_id}`) with the same key; send long work with `async: true` |
| `insufficient_allowance` | `/call` (402, terminal): the subscription's allowance is below this operation's price and the key has no money. Fund the key or extend the subscription |
| `expires_too_soon` | `/call` (402, terminal): the subscription ends before this operation could finish, and the key has no money. Fund the key or extend the subscription |
| `call_already_in_flight` | `/call` (429, `terminal: false`): the subscription has a call in flight and the key has no balance for another. Wait for it, or fund the key |
| `no_bound_identity` | `/call` (409) with `use_bound_identity`: nothing to run as. `terminal: true` — the key names no wallet; `false` — the wallet has no active binding yet. Drop the flag, or bind an account |
| `agent_connect_denied` | The account-binding pre-flight refused the call BEFORE signing, so no gas was spent. The body carries `class`, `promise_index` and **`terminal`** — read `terminal` first: `true` means retrying is pointless and the owner must act (issue a new grant, re-provision the executor, fund the account, rewrite the request); `false` means the same request may work later unchanged (a freeze lifted, recognized code restored) |
