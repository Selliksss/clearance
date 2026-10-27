# Wallet operations

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

### `/storage-deposit` - register token storage

Before withdrawing tokens to an account, that account must have storage registered on the token contract. Use this endpoint to register storage.

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"token":"wrap.near"}' \
  "https://api.outlayer.ai/wallet/v1/storage-deposit"
```

Idempotent - returns `already_registered: true` if storage already exists. Optional `account_id` field to register storage for a different account (default = wallet's own address). Costs ~0.00125 NEAR.

### Transfer FT tokens (USDT, wNEAR, etc.)

Use the generic contract call endpoint with `ft_transfer`. Requires 1 yoctoNEAR deposit. Receiver must have storage registered on the token contract.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"receiver_id":"usdt.tether-token.near","method_name":"ft_transfer","args":{"receiver_id":"bob.near","amount":"1000000"},"gas":"30000000000000","deposit":"1"}' \
  "https://api.outlayer.ai/wallet/v1/call"
```

### Call a contract
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"receiver_id":"wrap.near","method_name":"near_deposit","args":{},"deposit":"10000000000000000000000"}' \
  "https://api.outlayer.ai/wallet/v1/call"
```

Response: `{"request_id": "uuid", "status": "success", "tx_hash": "...", "result": ...}`

### Delete wallet
**WARNING:** FT tokens and Intents balances are lost. Transfer all assets first. Wallet must have NEAR balance (for gas to execute the on-chain delete).

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"beneficiary":"receiver.near","chain":"near"}' \
  "https://api.outlayer.ai/wallet/v1/delete"
```

### Sign a message (NEP-413 - for external auth)

Sign an arbitrary message using the wallet's NEAR private key (NEP-413 standard). Use this to authenticate your agent to external services that verify NEAR signatures.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"message":"Login to example.com at 2026-03-14T12:00:00Z","recipient":"example.com"}' \
  "https://api.outlayer.ai/wallet/v1/sign-message"
```

Response:

```json
{
  "account_id": "aabbccdd11223344...",
  "public_key": "ed25519:...",
  "signature": "ed25519:...",
  "signature_base64": "base64-encoded-signature",
  "nonce": "base64-encoded-32-bytes"
}
```

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | Text to sign (max 10000 bytes) |
| `recipient` | Yes | Service that will verify (1-128 chars) |
| `nonce` | No | Base64-encoded 32 bytes. Auto-generated if omitted |

**NEP-413 (default and only format):** The response includes both `signature` (ed25519 base58, NEAR-native format) and `signature_base64` (base64-encoded raw bytes). Use `signature_base64` for HTTP auth headers and JWT.

**Raw ed25519 signing → use `/wallet/v1/auth-sign`, not `/sign-message`.** `format: "raw"` on `/sign-message` is no longer supported and returns **HTTP 400**. For OutLayer NEAR-key auth (the raw-ed25519 token used by `PUT /api-key`, `Bearer near:`, and deterministic-wallet flows) call `POST /wallet/v1/auth-sign` instead — the keystore builds the `<prefix>:<seed>:<ts>` challenge with a fresh server timestamp and signs it raw ed25519. See `register-and-auth.md` for how the resulting token is used.

```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"purpose":"bearer","seed":"user-42"}' \
  "https://api.outlayer.ai/wallet/v1/auth-sign"
# Response: {"auth_message":"auth:user-42:1712000000","auth_timestamp":1712000000,"signature":"<base58_no_prefix>","public_key":"ed25519:..."}
```

`purpose` is one of `bearer` (→ `auth:<seed>:<ts>`, add `vault_id` to scope it), `register` (→ `register:<seed>:<ts>`), or `api-key` (→ `api-key:<seed>:<ts>`). Send `auth_message` and `signature` verbatim; the timestamp is server-generated, not client-supplied.

**Verification (external service, NEP-413 only):**

The NEP-413 signature verifier computes:
1. Borsh-serialize: `tag(2147484061) + message + nonce(32 bytes) + recipient + callback_url(None)`
2. SHA-256 hash the serialized payload
3. Verify ed25519 signature against the `public_key`
4. For implicit accounts: `account_id == hex(public_key_bytes)` - no RPC needed


## Automatic Storage Registration

| Endpoint | What it auto-registers |
|----------|----------------------|
| `/wallet/v1/intents/swap` | Output token storage on your wallet |
| `/wallet/v1/intents/deposit` | Your wallet's storage on `intents.near` |
| Fund link (dashboard) | Your wallet's storage on the token contract |
| `/wallet/v1/payment-check/create` | Auto-deposits to intents if wallet balance sufficient |

**NOT auto-registered:** `/wallet/v1/call` - register storage manually with `storage_deposit` if calling `ft_transfer` to a new receiver.
