# Register and authenticate

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

### Deterministic Wallets (NEAR Signature Auth)

For servers, bots, and agents **that have their own NEAR private key**: register deterministic wallets with zero per-user key storage. The wallet_id is derived from `(account_id, seed, vault_or_none)` — same inputs always produce the same wallet, and different vault scopes legitimately mint independent sub-wallets.

**Seed format:** `[a-zA-Z0-9._-]`, 1-256 characters. No NUL byte, no `:`, no whitespace, no Unicode. SHA-256 hex strings (typical seed source) fit naturally.

**Requires:** Access to a NEAR ed25519 private key (in env, in a file, etc.). This is NOT the custody wallet key — it's the integrator's own NEAR account key.

**Use cases:** Telegram bots (one NEAR key in env, thousands of user wallets), web apps with OAuth login, parent agents creating sub-agents.

**Custody wallets** (created via `POST /register` with a `wk_` key) don't need NEAR signatures for sub-agents. Use `PUT /wallet/v1/api-key` with your Bearer token — see "Create Sub-Agents" section below.

#### Signature format (IMPORTANT)

All signatures in deterministic wallet endpoints are **raw ed25519 signatures**, NOT NEP-413.

- Sign the **raw message string bytes** with your NEAR ed25519 private key
- Encode the 64-byte signature as **base58** (no prefix)
- `POST /wallet/v1/sign-message` returns NEP-413 signatures — these are a **different format** and will NOT work here
- `pubkey` field uses the `ed25519:` prefix: `"ed25519:<base58_public_key>"`
- `signature` field has NO prefix: just the base58-encoded 64-byte signature

```python
# Python example (nacl library)
from nacl.signing import SigningKey
import base58

key = SigningKey(secret_key_bytes)  # 32 bytes
message = "register:user-42:1712000000"
sig = key.sign(message.encode()).signature  # 64 bytes
signature_b58 = base58.b58encode(sig).decode()  # no prefix
pubkey = f"ed25519:{base58.b58encode(key.verify_key.encode()).decode()}"
```

#### Register a deterministic wallet

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{
    "account_id": "my-bot.near",
    "seed": "user-42",
    "pubkey": "ed25519:<base58_public_key>",
    "message": "register:user-42:1712000000",
    "signature": "<base58_signature_no_prefix>"
  }' \
  "https://api.outlayer.ai/register"
```

Signed message format: `"register:<seed>:<unix_timestamp>"`. Timestamp window: **±5 minutes**. Sign with a **full-access** key of `account_id` (or the key of an implicit account not created yet); a function-call key is refused.

Response:
```json
{
  "wallet_id": "uuid-string",
  "near_account_id": "hex64-implicit-account",
  "trial": { "available": true, "calls": 50, "days": 7, "claim_url": "POST /trial-key", "scope": "connectors.outlayer.near/*" }
}
```

No `api_key` in response — not needed. Idempotent: calling again returns the same wallet.

#### Authenticate with Bearer near:

All wallet endpoints accept `Bearer near:<base64url>` instead of `Bearer wk_...`:

```bash
# Build token: base64url-encode a JSON object with signature
TOKEN=$(echo -n '{"account_id":"my-bot.near","seed":"user-42","pubkey":"ed25519:...","timestamp":1712000000,"signature":"<base58_no_prefix>"}' | base64url)

curl -s -H "Authorization: Bearer near:${TOKEN}" \
  "https://api.outlayer.ai/wallet/v1/balance?chain=near"
```

The signed message for Bearer auth is `"auth:<seed>:<timestamp>"` (±30 second window), signed by a full-access key of `account_id`.

#### Register delegate key for sub-agents

Parent agent (with NEAR key) derives a `wk_` key and registers its SHA-256 hash. Sub-agent uses simple `Bearer wk_...` — no crypto needed.

```bash
# Parent: derive key = "wk_" + hex(HMAC-SHA256(near_private_key, "sub-task:0"))
# Parent: compute key_hash = SHA256(key)

curl -s -X PUT -H "Content-Type: application/json" \
  -d '{
    "account_id": "parent-agent.near",
    "seed": "sub-task",
    "key_hash": "sha256hex64chars...",
    "pubkey": "ed25519:<base58>",
    "message": "api-key:sub-task:1712000000",
    "signature": "<base58_no_prefix>"
  }' \
  "https://api.outlayer.ai/wallet/v1/api-key"
```

Signed message format: `"api-key:<seed>:<unix_timestamp>"`. Timestamp window: **±5 minutes**.

Response: `{"wallet_id": "...", "near_account_id": "..."}`

Creates wallet if it doesn't exist. Idempotent.

#### Revoke delegate key

```bash
curl -s -X DELETE -H "Authorization: Bearer near:${TOKEN}" \
  "https://api.outlayer.ai/wallet/v1/api-key/${KEY_HASH}"
```

Returns 409 Conflict if it's the last active key for the wallet.

#### Key rotation

No endpoint needed. Add a new key to your NEAR account, start signing with it. Remove old key — access revoked within 60 seconds (cache TTL). Wallet identity is tied to `(account_id, seed, vault_or_none)`, not to which key signs.

## Sovereign Vaults — Per-Customer Master Keys

> **TL;DR for the agent**: a vault is just an on-chain account that holds the *master secret* for a customer. Once the user has deployed one, you call **`POST /register`** with `{"vault_id": "<vault_addr>"}` and get back a `wk_...` API key — use it exactly like any other custody wallet. You can call this **N times** to get N independent wallets under the same vault (just like default-master `/register` can be called N times). **Don't** use "Create Sub-Agents" for this; that's a different flow for splitting one wk_ into deterministic child keys.

### What a vault is, in one paragraph

By default every custody wallet's keys derive from OutLayer's shared TEE master. A **sovereign vault** replaces that shared master with a per-customer one derived via NEAR's MPC network — recoverable by the customer if OutLayer ever shuts down. The vault is just a small on-chain contract that anchors a per-customer master in keystore-TEE memory; it does **not** issue API keys itself. API keys are always minted through `/register`, with or without a vault binding. The architecture is symmetric:

| | Default master | Per-vault master |
|---|---|---|
| Wallets per master | ∞ | ∞ |
| How to mint | `POST /register` | `POST /register {"vault_id": "..."}` |
| Each wallet | own `wk_`, own `wallet_id`, own derived address | same, plus `vault_id` in DB |
| Recovery if OutLayer stops | none | 7-day DAO cessation OR 24h-30d unilateral exit |

**The FIRST call against a vault is slow — allow for it.** A per-vault master lives only in the
keystore's memory, so the first request that touches a vault after a keystore restart or upgrade
waits on an on-chain MPC derivation. Expect seconds, not milliseconds; a client with a 30-second
HTTP timeout can give up while the derivation is still in flight. Every later call for that vault
is served from memory and is as fast as the default master.

Two practical consequences:

- Give vault-bound calls a generous client timeout (a minute or more), or make the first one a
  cheap warm-up — deriving an address, say — rather than a withdrawal you care about.
- Abandoning a slow first call does not save anything: the derivation is already on chain and the
  vault has paid its gas, but a cancelled request never caches the result, so the next attempt
  derives again. Wait it out rather than retrying tightly.

### Step 1 — User deploys the vault (off your hands)

The agent **cannot** deploy a vault — it requires an on-chain transaction signed by the user's NEAR account. When the user asks how, point them to either:

- **Dashboard**: <https://app.outlayer.ai/vault>
- **CLI**: `outlayer vault init` (after `outlayer login`)

Either flow ends with the vault registered on chain (`is_vault_verified == true` on keystore-DAO). The vault account id (e.g. `vault.alice.near`, name is user-chosen) is what you'll pass to `/register`.

### Step 2 — Mint custody wallets under the vault

```bash
curl -s -X POST "https://api.outlayer.ai/register" \
  -H "Content-Type: application/json" \
  -d '{"vault_id": "vault.alice.near"}'
```

Response is the standard `/register` shape — `api_key`, `wallet_id`, `near_account_id`, and the trial offer. The `near_account_id` derives from the per-vault master (not OutLayer's shared master), and `GET /wallet/v1/address` responses for this key include `"vault_id"`. Call this endpoint multiple times to get **independent wallets under the same vault** — each has its own `wallet_id`, `wk_`, and address (different `wallet_id` salt on the same per-vault master).

### Step 3 — Use the wk_ normally

Set `Authorization: Bearer wk_...` on every wallet endpoint as usual. No `X-Customer-Vault` header is needed (the coordinator binds the vault from the DB row, not from a request header — a spoofed header is silently ignored).

### Cross-vault and vault-vs-default isolation

A single user can mix vault-bound and default-master wallets:

- A wallet minted under `vault_id=A` only sees `vault_id=A` in its derived state. Its derived address has zero correlation with any wallet under `vault_id=B` or with the default master.
- A wallet minted via `POST /register` with NO `vault_id` stays on the default master forever; its `GET /address` response omits `vault_id`.
- Two `wk_`s from different vaults can be used concurrently from the same client — the coordinator routes each based on its own DB binding.

### What this is NOT

- **Not "Create Sub-Agents"** — that flow (further below) splits a single parent `wk_` into deterministic child keys using `PUT /wallet/v1/api-key`. Sub-agent wallets do inherit the parent's vault binding, but the use case is "delegate a slice of an existing wallet with reproducible IDs", not "get a fresh wallet under a vault".
- **Not deterministic registration** — the `POST /register` with NEAR-signature fields (`account_id`, `seed`, `pubkey`, `message`, `signature`) does **not** accept `vault_id`. Only the random-wallet path of `/register` supports the vault binding.

### Same parent, multiple vaults

Under the current schema each `(account_id, seed, vault_id)` tuple maps to a **distinct wallet_id**. A parent that runs both a custody vault and a treasury vault can use the same `seed` for both:

- `PUT /wallet/v1/api-key {seed: "user-42", vault_id: "vault.custody.parent.near", ...}` → wk_A under custody vault
- `PUT /wallet/v1/api-key {seed: "user-42", vault_id: "vault.treasury.parent.near", ...}` → wk_B under treasury vault (DIFFERENT wallet_id, DIFFERENT on-chain address)

Both succeed (no rebind refusal). The two sub-wallets are cryptographically isolated — funds at one are inaccessible from the other.

## Create Sub-Agents

### From a custody wallet (Bearer wk_...)

Pass your `Bearer wk_...` header to `PUT /wallet/v1/api-key` — no NEAR signatures or crypto needed. The coordinator derives a sub-wallet from your wallet_id + seed.

```python
import hashlib, requests

API = "https://api.outlayer.ai"
PARENT_KEY = "wk_..."  # parent's custody wallet key
HEADERS = {"Authorization": f"Bearer {PARENT_KEY}", "Content-Type": "application/json"}

# 1. Choose a seed for the sub-agent (deterministic — same seed = same wallet)
seed = "sub-agent-task-42"

# 2. Derive a wk_ key for the sub-agent
sub_key = f"wk_{hashlib.sha256(f'{seed}:0:{PARENT_KEY}'.encode()).hexdigest()}"
key_hash = hashlib.sha256(sub_key.encode()).hexdigest()

# 3. Register the key hash (Bearer auth — no NEAR signatures needed)
#    Creates sub-wallet if needed, idempotent
resp = requests.put(f"{API}/wallet/v1/api-key",
    headers=HEADERS,
    json={"seed": seed, "key_hash": key_hash},
).json()
print(f"Sub-agent wallet: {resp['near_account_id']}")

# 4. Hand the key to the sub-agent — it uses simple Bearer auth
sub_agent_headers = {"Authorization": f"Bearer {sub_key}"}
balance = requests.get(f"{API}/wallet/v1/balance?chain=near",
    headers=sub_agent_headers).json()
```

Same `(parent_wallet_id, seed, vault_scope)` always produces the same sub-wallet — call again to re-derive the key without storage. Different vault scopes under the same `(parent_wallet_id, seed)` mint **independent sub-wallets** with their own addresses (this is intentional — each scope is its own identity).

**A sub-agent pays like any wallet.** It can claim its own trial with its own `wk_` (`POST /trial-key`, in its first week), redeem a sponsor code (`POST /wallet/v1/sponsorship`), or be given a funded payment key to spend.

No `sign-message`, no NEAR signatures, no crypto libraries. Just derive a key, register its hash, hand it to the sub-agent.

### From an external NEAR account

If you have your own NEAR private key (bot, server), sign directly without `sign-message`:

```python
# Sign "api-key:<seed>:<timestamp>" with your NEAR ed25519 key
# See "Deterministic Wallets" section for details
```

### Simple alternative (no parent→child link)

If you don't need deterministic wallet IDs, just register independent wallets:

```bash
curl -s -X POST https://api.outlayer.ai/register
# Give the new api_key to the sub-agent — independent wallet, no link to parent
```

## Key Recovery

If you lost your wallet API key and the user previously set a policy, the key is saved in their browser.

**Message to user:**
> I lost access to your wallet API key. Please go to: https://app.outlayer.ai/wallet/manage
> Find your wallet, click **show** next to the API Key, then copy and paste it here.
> The key looks like: `wk_15807d...e545`

After receiving the key, verify: `GET /wallet/v1/balance?chain=near` with the key.

If recovery is not possible (no policy set, browser data cleared), register a new wallet with `POST /register`.
