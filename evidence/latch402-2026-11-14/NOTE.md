# latch402 v0.3.2: the stable payment id, checked (Nov 14, 2026)

[latch402](https://github.com/Hitek-cel/latch402) is an x402 settlement gateway. In [x402-foundation/x402#808](https://github.com/x402-foundation/x402/issues/808) Clearance noted that a buyer told "payment failed" who signs a new payment gets a fresh random payment identifier, so the gateway sees a new purchase and charges twice. Its author shipped [v0.3.2](https://github.com/Hitek-cel/latch402/releases/tag/v0.3.2) with `purchasePaymentId(orderId)`, an identifier derived from the order, and a demo step for that buyer.

## What we ran
- latch402 at tag `v0.3.2`, commit `851455299aebd227ccc89bc46bade36304ec6155`, Node 24.14.1, on Nov 14.
- `npm test` ([`npm-test.txt`](npm-test.txt)): 132 tests, 132 pass, 0 fail.
- `npm run example` ([`example.txt`](example.txt)), the author's offline demo: a simulated chain and an in-process PostgreSQL, paid with the official x402 client.
  - Step 4: the first attempt is answered 402, and the buyer signs a new payment for the same order. That signature is refused, the retry of the original payment finishes the purchase, and the paid work runs once.
  - Step 6: the buyer was charged 4 times for 4 purchases.

## What this does not show
- These are latch402's own tests and demo, run as published. It is not a Clearance crash test: no model, no NEAR sandbox, no attack generator.
- The chain is simulated. The Base Sepolia variant (`npm run example:testnet`) was not run.
- It covers a buyer that uses `purchasePaymentId`. A buyer that still sends a fresh random identifier per attempt is charged twice, as the demo itself says.
