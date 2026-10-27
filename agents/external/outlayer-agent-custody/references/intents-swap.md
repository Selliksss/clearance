# Swap tokens (NEAR Intents)

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

## Cross-Chain Swaps (NEAR Intents)

Swap tokens across 20+ blockchains using NEAR Intents protocol. All swaps are atomic - either both sides complete or nothing happens.

### Swap workflow

**1. Find token IDs:**
```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/tokens"
```
Response includes `defuse_asset_id` for each token. `token_in` is the asset's id on intents.near — `nep141:…`, `nep245:…`, or its NEAR-side 1Click id `1cs_v1:near:nep141:…` (the same balance); a `1cs_v1:` id on another chain is a delivery, not a balance, and is refused as a source (`400 unsupported_token`). `token_out` takes any `nep141:`, `nep245:` or `1cs_v1:` id the catalog lists, sent to 1Click as given — for a `1cs_v1:<chain>:…` destination 1Click decides which id lands on intents.near (ZEC bought as `1cs_v1:sol:spl:…` arrives as `nep141:zec.omft.near`).

> ⚠️ **`symbol` is NOT unique — never resolve a token by symbol.** The same
> display symbol appears once per chain (e.g. "USDC" returns ~17 entries:
> `nep141:17208628…` native NEAR USDC, `nep141:eth-0xa0b8…omft.near` Ethereum
> USDC, `nep141:base-0x833…omft.near` Base USDC, plus arb/sol/avax/pol/op/…).
> A naive `symbol === "USDC"` lookup grabs the first match (usually the
> Ethereum-bridged one) and you deposit/withdraw against the WRONG chain's
> asset — funds end up stuck or lost. Always select the entry by its exact
> `defuse_asset_id`, choosing the one whose `chains` array contains your target
> chain. See [token-reference.md](token-reference.md) for the
> chain-disambiguated list of common assets.

**2. Check intents balance (tokens must be in intents):**
```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/balance?token=wrap.near&source=intents"
```

If tokens are on the NEAR account (not in intents), deposit them first:
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token":"wrap.near","amount":"1000000000000000000000000"}' \
  "https://api.outlayer.ai/wallet/v1/intents/deposit"
```

**3. Preview swap rate (optional, no gas):**
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token_in":"nep141:wrap.near","token_out":"nep141:usdt.tether-token.near","amount_in":"1000000000000000000000000"}' \
  "https://api.outlayer.ai/wallet/v1/intents/swap/quote"
```
Response: `{"amount_out": "3150000", "min_amount_out": "3118500", "deadline": "...", "time_estimate_seconds": 30}`

**4. Execute swap (gasless):**
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token_in":"nep141:wrap.near","token_out":"nep141:usdt.tether-token.near","amount_in":"1000000000000000000000000","min_amount_out":"3000000"}' \
  "https://api.outlayer.ai/wallet/v1/intents/swap"
```
Response: `{"request_id": "uuid", "status": "success", "amount_out": "3150000", "intent_hash": "..."}`

**Prerequisite:** tokens must be in intents balance. Use `/intents/deposit` to move from NEAR account, or receive via payment check (funds arrive in intents directly).

**Result stays in intents balance.** Use `/intents/withdraw` to move tokens out.

`min_amount_out` is optional - omit for a market order. Set to protect against slippage.

> **Reading `amount_out` correctly — the realized fill. SAME RULE for `/intents/swap` AND `/confidential/swap`:**
>
> `amount_out` is the **actual delivered amount ONLY when `status == "success"`**. At every earlier stage it is an **estimate, not the fill**:
> - `/intents/swap/quote` and `/confidential/swap/quote` → price preview only.
> - **Public** `/intents/swap` blocks to settlement, so its response usually already carries `status:"success"` + the realized `amount_out`. If it returns `processing` (settlement outlasted the call's wait; `amount_out` is then the quote), poll its `poll_url` (`GET /wallet/v1/requests/{request_id}`) and read `result.amount_out` from the `success` row. The swap runs to its outcome even if your client disconnects — give the call at least 100 s, and if your client gives up first, do not submit a new swap: re-send with the same `X-Idempotency-Key` and poll the id the duplicate answer names.
> - **Confidential** `/confidential/swap` returns `status:"pending_deposit"` with **NO `amount_out`** in the submit response — this is **timing, NOT privacy**. It settles `pending_deposit → processing → success` (slower than public); the realized `amount_out` appears in `result.amount_out` **only at `success`**. The actual delivered amount *is* returned — confidential does **not** hide it. A short poll window (e.g. 90s / 30×3s) can expire before `success` — keep polling, do not give up and record the quote.
>
> **Never** record a position / qty / PnL from a quote or a submit-time estimate, and **never** fall back to a snapshot- or price-derived qty — both drift from the real fill. The only correct source is **`result.amount_out` read at `status == "success"`**, for both public and confidential swaps.

### Common swap pairs

| Pair | token_in | token_out |
|------|----------|-----------|
| wNEAR to USDT | `nep141:wrap.near` | `nep141:usdt.tether-token.near` |
| USDT to wNEAR | `nep141:usdt.tether-token.near` | `nep141:wrap.near` |
| wNEAR to USDC | `nep141:wrap.near` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| wNEAR to ETH | `nep141:wrap.near` | `nep141:eth.omft.near` |
| wNEAR to BTC | `nep141:wrap.near` | `nep141:btc.omft.near` |
