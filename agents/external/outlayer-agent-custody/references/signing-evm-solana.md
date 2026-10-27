# Sign EVM and Solana payloads

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

### Sign EVM payloads (EIP-712 / EIP-191 / raw tx)

Sign for the wallet's EVM address (the `0x` address from `GET /wallet/v1/address?chain=<evm>`; all EVM chains share one secp256k1 key). **Off-chain only** — the response is a 65-byte signature (`0x` `r‖s‖v`, `v ∈ {27,28}`, low-s); **you assemble and broadcast any on-chain transaction yourself** (the keystore never builds, gas-estimates, nonces, or broadcasts). Gated by the `evm_sign` policy capability — **default-DENY under a policy** (set `evm_sign.allowed:true`; a wallet with no policy is unrestricted); raw transactions additionally require `evm_sign.raw_tx` (**default-OFF**). `ecrecover` over the signed digest returns the wallet's EVM address.

**EIP-712 typed data** — the core trading primitive (e.g. a Polymarket CLOB order):
```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"polygon","typed_data":{"domain":{...},"types":{...},"primaryType":"Order","message":{...}}}' \
  "https://api.outlayer.ai/wallet/v1/evm/sign-typed-data"
# → { "signature": "0x..(65 bytes)", "chain": "polygon", "wallet_id": "..." }
```
Send the full `eth_signTypedData_v4` object; the digest is computed server-side (no client-supplied hash is trusted). Arbitrary EIP-712 structs work (including EIP-3009 `TransferWithAuthorization` and EIP-2612 `Permit`).

**EIP-191 `personal_sign`** — e.g. deriving a venue CLOB API key:
```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"polygon","message":"Sign in to Polymarket"}' \
  "https://api.outlayer.ai/wallet/v1/evm/sign-message"
```
`message` is signed as a UTF-8 string by default; add `"encoding":"hex"` to sign the decoded bytes of a hex `message` instead (no auto-detection). (Distinct from the NEP-413 `/wallet/v1/sign-message` in `wallet-ops.md` — that one is NEAR auth.)

**Raw EVM transaction** — gated by `evm_sign.raw_tx`:
```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"polygon","unsigned_tx":"0x02..."}' \
  "https://api.outlayer.ai/wallet/v1/evm/sign-transaction"
```
Send the **serialized unsigned transaction** (e.g. viem `serializeTransaction(tx)`); we keccak256-hash and sign it. For EIP-1559 (type-2) txs the `yParity` you need to assemble the final tx is `v - 27`. You build the signed tx and broadcast it via your own RPC.

> **Security.** An EIP-712 signature is itself fund-moving (EIP-3009 ≈ transfer, EIP-2612 ≈ approve), so `evm_sign` grants full authority over whatever you bridge onto the EVM address — the risk is bounded to that float; your NEAR-intents balance is never reachable by an EVM signature. Keep the on-chain float small. `evm_sign.raw_tx` is a separate kill-switch for arbitrary raw transactions; it does NOT contain typed-data drains.

---

### Sign Solana payloads (messages / transactions)

Sign for the wallet's Solana address (the base58 ed25519 pubkey from `GET /wallet/v1/address?chain=solana`). Same model as EVM — **off-chain only**: the response is a 64-byte ed25519 signature (**base58**, Solana convention); **you assemble and broadcast the transaction yourself** (the keystore never builds it, never picks a blockhash, never pays fees, never broadcasts). Gated by the `solana_sign` policy capability — **default-DENY under a policy** (set `solana_sign.allowed:true`; a wallet with no policy is unrestricted); transactions additionally require `solana_sign.raw_tx` (**default-OFF**). Signatures verify against the wallet's Solana address with standard tooling (`nacl.sign.detached.verify`, `PublicKey.verify`).

**Off-chain message** — e.g. Sign-in-with-Solana or venue auth. The decoded bytes are signed AS-IS (raw-bytes ed25519 — standard SIWS verification works unchanged):
```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"solana","message":"example.com wants you to sign in with your Solana account:\n..."}' \
  "https://api.outlayer.ai/wallet/v1/solana/sign-message"
# → { "signature": "<base58, 64 bytes>", "chain": "solana", "wallet_id": "..." }
```
`message` is signed as a UTF-8 string by default; add `"encoding":"hex"` or `"encoding":"base64"` to sign decoded bytes instead (no auto-detection). **A "message" whose bytes are a valid Solana transaction message is rejected (HTTP 400)** — that's deliberate (the same guard Phantom applies): otherwise a message signature could be broadcast as a transaction, bypassing the `raw_tx` gate. If you hit this 400, you are actually signing a transaction — use `sign-transaction`.

**Solana transaction** — gated by `solana_sign.raw_tx`:
```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"solana","unsigned_tx":"<base64>"}' \
  "https://api.outlayer.ai/wallet/v1/solana/sign-transaction"
```
Send the **serialized unsigned transaction MESSAGE** (what the signature covers), base64, max 1232 bytes — with `@solana/web3.js` that is `tx.serializeMessage()` (legacy) or `versionedTx.message.serialize()` (v0), NOT the whole transaction. Assemble the signed transaction yourself and broadcast via your own RPC:

```javascript
// legacy: build tx (feePayer = wallet's solana address, fresh blockhash), then:
const msgBytes = tx.serializeMessage();
const { signature } = await signTx({ chain: "solana", unsigned_tx: msgBytes.toString("base64") });
tx.addSignature(walletPubkey, Buffer.from(bs58.decode(signature)));
await connection.sendRawTransaction(tx.serialize());
```

> **Security.** A signed Solana transaction message is itself fund-moving, so `solana_sign` + `raw_tx` grants full authority over whatever you send to the Solana address — the risk is bounded to that float; your NEAR-intents balance is never reachable by a Solana signature. Keep the on-chain float small. The wallet must hold SOL for fees on the native path (no gas abstraction, unlike Intents).
