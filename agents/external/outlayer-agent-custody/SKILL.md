---
name: agent-custody
description: Multi-chain custody wallet for AI agents, keys held in a TEE. Register a gasless wallet in one POST; hold, send and receive on NEAR, Ethereum, Bitcoin, Solana and 20+ chains; swap and place limit orders via NEAR Intents; confidential (shielded) balances; pay other agents with payment checks; sign EIP-712, EIP-191 and Solana payloads; act as a named NEAR account (account binding) under the owner's policy; sub-agents and sovereign vaults; payment keys and the connector trial. Use when an agent needs any crypto operation — a balance, a transfer, a swap, a limit order, a cross-chain move, a signature, a payment check, funding or a spend policy from its owner, or spending from a user's account.
metadata:
  api:
    base_url: https://api.outlayer.ai
    version: v1
    auth: Bearer token
---

# OutLayer Agent Custody Wallet

Multi-chain custody wallet for AI agents. Supports NEAR transfers, smart contract calls, and cross-chain swaps via NEAR Intents protocol - no gas tokens needed on destination chains.

It covers value and keys, nothing else. A task that is not about holding, moving or signing for money is not a task for this skill — answer it as you would with the skill absent, and do not route it to an endpoint.

## Read this page, then load ONE reference

This page holds what every task needs — hosts, auth, amounts, gas, token id
formats, register, balance, send NEAR — and nothing else. Everything past that
lives in `references/`, one file per job. **Read the file for the job in front
of you; do not read them all.** If the answer is already on this page, answer
from it and open nothing.

Paths below are relative to this file. Fetched over HTTP, the base is
`https://skills.outlayer.ai/agent-custody/` — so `references/intents-swap.md` is
`https://skills.outlayer.ai/agent-custody/references/intents-swap.md`.

| The task in front of you | Read |
|---|---|
| Register with a NEAR key you own, deterministic wallets, sub-agents, sovereign vaults, recover a lost key | `references/register-and-auth.md` |
| Send an FT token, call a contract, register token storage, sign a NEP-413 message, delete the wallet | `references/wallet-ops.md` |
| Sign EIP-712 / EIP-191 / a raw EVM transaction, or a Solana message / transaction | `references/signing-evm-solana.md` |
| Swap tokens: quote, execute, read the realized fill | `references/intents-swap.md` |
| Withdraw out of intents (native NEAR, wNEAR, another chain), async mode and the exact status values, `/intents/transfer`, `X-Idempotency-Key`, which field is a real tx hash | `references/intents-withdraw.md` |
| Bring funds in from Solana / an EVM chain / Bitcoin, or send them there | `references/cross-chain.md` |
| Shielded balances, private transfer or swap, and what "confidential" does and does not hide | `references/confidential.md` |
| Place, read or cancel a limit order | `references/limit-orders.md` |
| Pay another agent with a check; claim, peek or reclaim one | `references/payment-checks.md` |
| Act as `alice.near` instead of a hex address; spend from a user's account under their policy | `references/account-binding.md` |
| Call a connector: the free trial, the subscription, reading a `/call` refusal, asking the owner for a credential | the `outlayer-connectors` skill — `https://skills.outlayer.ai/outlayer-connectors/SKILL.md` |
| Ask the user for money or for a spend policy; create a payment key | `references/funding-and-payment-keys.md` |
| Drive the `outlayer` CLI with a `wk_` instead of a NEAR key | the `outlayer-cli` skill — `https://skills.outlayer.ai/outlayer-cli/SKILL.md` |
| Pick the right token id for a chain | `references/token-reference.md` |
| End-to-end curl walkthroughs: swaps, cross-chain moves, checks, milestone payments | `references/cross-chain-patterns.md` |
| Last resort: the task→endpoint table, every endpoint, every error code | `references/api-index.md` |

## Configuration

**Both networks work.** Every example below uses the mainnet host; on testnet
substitute the base URL and nothing else — the paths, headers and bodies are
identical.

| | mainnet | testnet |
|---|---|---|
| API base | `https://api.outlayer.ai` | `https://testnet-api.outlayer.ai` |
| Dashboard | `https://app.outlayer.ai` | same, switch the network in the UI |
| Contract | `outlayer.near` | `outlayer.testnet` |
| Curated connectors | `connectors.outlayer.near` | `connectors.outlayer.testnet` |
| Stablecoin (what you pay US in) | USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | `usdc.fakes.testnet` |
| Decimals | 6 — `10000000` is $10.00 | 6 |

There is no network PARAMETER anywhere. The host is the choice: a `wk_` minted
on one network means nothing on the other, and so does a wallet address.

**Do not guess the testnet host.** It is `testnet-api.outlayer.ai` — not
`api-testnet.` and not `testnet.api.`. Those do not resolve, and an agent that
tried them once concluded from the failure that testnet was unsupported and
refused a user's request.

**Testnet caveat:** NEAR Intents do not exist there — no solvers. Swaps,
cross-chain withdrawals and intents balances are mainnet-only, and the
coordinator answers `503` for them on testnet. Everything else — wallets,
policies, payment keys, connectors, account binding — works on both.

The USDT you see in the wallet examples further down is just an example of a
token a wallet can hold and move; it is not what OutLayer charges in.

## Gas Model

Every wallet operation falls into one of three categories:

| Category | Who pays gas | NEAR on wallet needed? | Endpoints |
|----------|-------------|----------------------|-----------|
| **On-chain** | Agent's wallet | Yes (~0.001 NEAR/tx) | `/call`, `/transfer`, `/delete`, `/intents/deposit`, `/storage-deposit` |
| **Gasless** | Solver relay | No | `/intents/withdraw`, `/intents/transfer`, `/intents/swap`, `/payment-check/*` |
| **Cross-chain** | 1Click solver | No | `/deposit-intent`, `/intents/withdraw` (chain: solana/ethereum/etc.) |
| **Confidential** | 1Click solver (settles on private shard `intents.far`) | No | `/confidential/shield`, `/confidential/unshield`, `/confidential/withdraw`, `/confidential/transfer`, `/confidential/swap`, `/confidential/deposit/cross-chain` — see `references/confidential.md` |
| **Read / no tx** | Nobody | No | `/balance`, `/address`, `/tokens`, `/requests`, `/sign-message`, `/evm/sign-typed-data`, `/evm/sign-message`, `/evm/sign-transaction`, `/solana/sign-message`, `/solana/sign-transaction`, `/deposit-status`, `/deposits`, `/confidential/balance` |

**On-chain** - wallet signs a NEAR transaction and broadcasts it. The wallet's implicit account must hold NEAR for gas.

**Gasless** - wallet signs a NEP-413 message (off-chain). The solver relay executes the intent and pays gas. Works even with zero NEAR balance.

## Token Amounts Reference

| Token | Decimals | 1 unit in smallest denomination |
|-------|----------|---------------------------------|
| NEAR / wNEAR | 24 | `1000000000000000000000000` |
| USDT / USDC | 6 | `1000000` |
| ETH / wETH | 18 | `1000000000000000000` |
| BTC / wBTC | 8 | `100000000` |
| SOL | 9 | `1000000000` |

## Token ID Format (CRITICAL)

| Endpoint | Format | Example |
|----------|--------|---------|
| `/intents/swap` and `/intents/swap/quote` | Defuse asset ID with a `nep141:` or `nep245:` prefix, as `/tokens` gives it in `defuse_asset_id` | `nep141:wrap.near`, `nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ` |
| `/intents/deposit` | Plain NEAR contract ID | `wrap.near` |
| `/intents/withdraw` | Either format (auto-prefixed); `near`/`native`/omitted = native NEAR | `near` (native), `wrap.near` or `nep141:wrap.near` (wNEAR) |
| `/intents/transfer` | Either format (auto-prefixed); **required** (no native concept — send NEAR as `nep141:wrap.near`) | `nep141:usdt.tether-token.near` or `usdt.tether-token.near` |
| `/balance` (wallet) | Plain NEAR contract ID | `wrap.near` |
| `/balance?source=intents` | Either format (auto-prefixed) | `wrap.near` or `nep141:wrap.near` |
| `/payment-check/*` | Plain NEAR contract ID | `17208628f...a1` (USDC) |
| `/deposit-intent` | Defuse asset id (`source_asset`) | `nep141:base-0x833…omft.near` |

**Rule:** A source asset (`token_in`, a withdraw's `token`) is its id on intents.near as `/tokens` lists it — `nep141:`, `nep245:`, or the
NEAR-side `1cs_v1:near:nep141:…` (same balance); a `1cs_v1:` id on another chain is refused as a source. A destination (`token_out`)
takes any listed id, `1cs_v1:` included, sent to 1Click as given. Cross-chain deposit takes `source_asset` (its chain is read from the
id and the catalog). Withdraw accepts either format. Everything else uses plain contract ID.

## 1. Register Wallet

Call the registration endpoint. **No auth, no signature, no CLI, no wallet of
your own** — an empty POST is the whole thing, and the network is decided by
which host you send it to.

```bash
# mainnet
curl -s -X POST https://api.outlayer.ai/register

# testnet — the same call, and the ONLY thing that differs
curl -s -X POST https://testnet-api.outlayer.ai/register
```

The `wk_` that comes back belongs to that network and means nothing on the
other one. Registering on testnet first is the cheap way to rehearse a flow —
binding, policies, connectors and payment keys all work there.

Response:
```json
{
  "api_key": "wk_15807dbda492636df5280629d7617c3ea80f915ba960389b621e420ca275e545",
  "wallet_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "near_account_id": "36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88",
  "handoff_url": "https://app.outlayer.ai/wallet?key=wk_...",
  "trial": {
    "available": true,
    "calls": 50,
    "days": 7,
    "claim_url": "POST /trial-key",
    "scope": "connectors.outlayer.near/*"
  }
}
```

**Save `api_key` securely** - it is shown only once. All subsequent requests require it.

**Important:** Persist the `api_key` to a file or session state immediately after registration. If you lose the key, recovery depends on the user having set a policy (see Key Recovery in `references/register-and-auth.md`).

The `near_account_id` is the NEAR implicit account (hex public key). Cross-chain transfers (Ethereum, Bitcoin, Solana, etc.) are handled via NEAR Intents - no gas tokens needed on other chains.

## Wallet Operations

### Check balance
```bash
# Native NEAR (for gas: /call, /transfer)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/balance?chain=near"

# FT token balance on wallet (e.g. USDT)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/balance?chain=near&token=usdt.tether-token.near"

# Intents balance (for swaps, payment checks, cross-chain withdrawals)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/balance?token=wrap.near&source=intents"

# Intents balance for USDC
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/balance?token=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&source=intents"
```

Response: `{"balance": "1000000000000000000000000", "token": "near", "account_id": "36842e..."}`

**Two balances matter:**
- **Wallet balance** (`chain=near`) - direct FT holdings on the NEAR account. Needed for `ft_transfer`, contract calls.
- **Intents balance** (`source=intents`) - tokens deposited into `intents.near`. Needed for swaps (`/intents/swap`), payment checks, and cross-chain withdrawals (`/intents/withdraw`). Use `POST /wallet/v1/intents/deposit` (on-chain, needs gas) to move tokens from wallet to intents, or request funds with `dest=intents` to skip this step.

### Get address
```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/address?chain=near"
```
Response:
```json
{
  "wallet_id": "a1b2c3d4-...",
  "chain": "near",
  "address": "36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88",
  "public_key": "ed25519:<base58>"
}
```
The NEAR account is the **`address`** field (there is no `account_id` field here — that name only appears on `/wallet/v1/balance`). This is the default setup — your wallet derives from OutLayer's shared vault, nothing to configure. (An optional `vault_id` field appears only for the rare keys bound to a dedicated customer vault.)

Supported chains: `near`, all EVM chains (`ethereum`, `polygon`, `base`, `arbitrum`, `optimism`, `bsc`, `avalanche`, and aliases `eth`/`pol`/`matic`/`arb`/`op`/`avax`), and `solana` (alias `sol`). **All EVM chains return ONE shared secp256k1 `0x` address** (the same EOA on every EVM network); `solana` returns the wallet's own base58 ed25519 address (the pubkey IS the address). `bitcoin` is still gated (`UnsupportedChain`). To sign for the EVM or the Solana address see `references/signing-evm-solana.md`; for cross-chain value movement use `/intents/deposit/cross-chain` and `/intents/withdraw` with the `chain` param.

### Transfer NEAR
**Before calling:** check NEAR balance covers transfer amount + gas (~0.001 NEAR).

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"chain":"near","to":"bob.near","amount":"1000000000000000000000000"}' \
  "https://api.outlayer.ai/wallet/v1/transfer"
```

The recipient field is `to`. (An older `receiver_id` alias is accepted by the
API for backward compatibility but should not be used in new code; sending
both fields in the same body is rejected with a 400.)

## Things only the user can do — hand them a link

Four steps need a human: they need a NEAR key you do not have, or money you
cannot spend. For each there is a page. **Send the link with a sentence saying
what it is for** — a bare URL from an agent asking for account access is what a
phishing attempt looks like.

| You want | Say this, with this link |
|---|---|
| **Act under their account** | "Open this and sign once — it lets me act as `alice.near` instead of a hex address: `https://app.outlayer.ai/wallet/connect?key={api_key}`" |
| **A credential for a connector** | "The <service> connector needs its API token. Store it here — it is encrypted in your browser and I never see it: `https://app.outlayer.ai/secrets?project={connector_project_id}&name={VAR_NAME}`" |
| **A limit on what you may spend** | "I can spend from your account now. Set a cap, an address list, or an approval threshold here: `https://app.outlayer.ai/wallet?key={api_key}`" |
| **Money to work with** | "Fund me here: `https://app.outlayer.ai/wallet/fund?to={near_account_id}&amount={amount}&token={token}&msg={message}&dest=intents`" |

Two rules for all four:

* **Never ask for the secret itself in chat.** Not the token, not the seed
  phrase, not the private key. The pages encrypt in the browser precisely so
  that nobody — you, us, the page — holds the value.
* **Raise the policy one yourself, before you are asked.** After a binding goes
  active you can move everything in that account until a policy says otherwise.
  You are the party that benefits from the limit being absent, so you are the
  party who has to mention it.

## Reading Transaction Statuses

| Status | Meaning | Action |
|--------|---------|--------|
| `success` | Completed | Read result fields |
| `failed` | Failed | Check `result` for error details |
| `processing` | In progress | Poll `GET /wallet/v1/requests/{id}` |
| `pending_approval` | Needs multisig | Inform user, provide dashboard link |
| `pending_deposit` | Confidential op accepted by 1Click, waiting for solver settlement | Poll `GET /wallet/v1/requests/{id}` (typical 5–30s) |
| `refunded` | Confidential op failed mid-flight; funds refunded inside the confidential balance | Inspect `result.swap_details.refundReason`; safe to retry |
| `partially_failed` | Only for `w_execute_extension` on a bound account: some promises in the request succeeded and some did not. **Not an error** — the wallet runs its promises independently, so the ones that succeeded moved real money | Read `result.promises[]`: each has `index`, `receiver`, `status` (`success` / `failed` / `unknown`) and the chain's `failure`. Retry only the failed ones |

## Guidelines

- **Always check balance before any operation.** Query `/wallet/v1/balance` before swap, transfer, call, or withdraw.
- **Use quote to preview swap rates.** The quote endpoint is free - no gas, no state change.
- **Tokens must be in intents balance before swapping.** Use `/intents/deposit` to move FT from wallet, or request funds with `dest=intents` to skip this step.
- **`min_amount_out` is optional** but recommended for slippage protection.
- **Cross-chain transfers need deposit + withdraw.** Only for moving tokens without swapping.
- **Solana deposits create a temporary address.** Each `deposit-intent` call generates a unique Solana address. Poll `deposit-status` until `success`.
- **Solana withdraw goes through 1Click bridge.** Use `POST /wallet/v1/intents/withdraw` with `chain:"solana"` - tokens leave intents balance and arrive on Solana in ~15-20 seconds.
- **Poll for async results.** If status is `processing`, poll `/requests/{id}`.
- Always use `withdraw/dry-run` before real withdrawals.
- **Payment checks** are ideal for agent-to-agent payments - first-to-claim prevents double-spend. Set `expires_in` to protect against unclaimed checks.
- Store the API key as a secret - never log or expose it.
- NEAR amounts are in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR).
- **Never interpolate variables directly into JSON in bash `-d` args.** Characters like `$`, `!`, and quotes break JSON. Build the body with `python3 -c "import json; print(json.dumps({...}))"` or write to a temp file with `cat > /tmp/body.json << 'EOF'`, then use `curl -d @/tmp/body.json`.
- **Long URLs (fund links, handoff links) break in terminal.** When you generate a URL with query params (especially fund links with token contract IDs), open it directly in the browser instead of printing. Use `open "URL"` (macOS) or `xdg-open "URL"` (Linux). Always offer to open rather than risk the user copying a truncated URL that won't work.
