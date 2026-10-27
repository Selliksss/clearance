# Token Reference - Popular Tokens for AI Agent Swaps

Use `GET /wallet/v1/tokens` for the full dynamic list. This reference covers the most commonly used tokens.

> ⚠️ **One display symbol maps to many chain-specific assets.** "USDC", "USDT",
> "ETH", "BTC" each exist on multiple chains with a DIFFERENT `defuse_asset_id`
> (see the `(ETH)`/`(Base)`/`(Arb)`/`(SOL)` rows below). Always pick the asset
> by its exact `defuse_asset_id` for the chain you want — never by symbol alone.
> Picking the wrong chain's variant on a deposit/withdraw sends funds to the
> wrong asset and they can be stuck or lost.

## Stablecoins

| Symbol | Contract ID | Defuse Asset ID | Decimals | Chain |
|--------|-------------|-----------------|----------|-------|
| USDT | `usdt.tether-token.near` | `nep141:usdt.tether-token.near` | 6 | NEAR |
| USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 6 | NEAR |
| USDT (ETH) | - | `nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near` | 6 | Ethereum |
| USDC (ETH) | - | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | 6 | Ethereum |
| USDC (Base) | - | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | 6 | Base |
| USDC (Arb) | - | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | 6 | Arbitrum |
| USDC (SOL) | - | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` | 6 | Solana |
| DAI | - | `nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near` | 18 | Ethereum |

## Major Assets

| Symbol | Contract ID | Defuse Asset ID | Decimals | Chain |
|--------|-------------|-----------------|----------|-------|
| wNEAR | `wrap.near` | `nep141:wrap.near` | 24 | NEAR |
| ETH | `eth.omft.near` | `nep141:eth.omft.near` | 18 | Ethereum |
| ETH (Arb) | - | `nep141:arb.omft.near` | 18 | Arbitrum |
| ETH (Base) | - | `nep141:base.omft.near` | 18 | Base |
| BTC | `btc.omft.near` | `nep141:btc.omft.near` | 8 | Bitcoin |
| SOL | `sol.omft.near` | `nep141:sol.omft.near` | 9 | Solana |
| WBTC (ETH) | - | `nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near` | 8 | Ethereum |
| cbBTC (Base) | - | `nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near` | 8 | Base |

## NEAR Ecosystem Tokens

| Symbol | Contract ID | Defuse Asset ID | Decimals |
|--------|-------------|-----------------|----------|
| AURORA | `aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` | `nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` | 18 |
| SWEAT | `token.sweat` | `nep141:token.sweat` | 18 |
| stNEAR | `meta-pool.near` | `nep141:meta-pool.near` | 24 |
| mpDAO | `mpdao-token.near` | `nep141:mpdao-token.near` | 6 |

## L2 / Alt-Chain Native Tokens

| Symbol | Defuse Asset ID | Decimals | Chain |
|--------|-----------------|----------|-------|
| ARB | `nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near` | 18 | Arbitrum |
| STRK | `nep141:starknet.omft.near` | 18 | StarkNet |
| APT | `nep141:aptos.omft.near` | 8 | Aptos |
| SUI | `nep141:sui.omft.near` | 9 | Sui |
| DOGE | `nep141:doge.omft.near` | 8 | Dogecoin |
| XRP | `nep141:xrp.omft.near` | 6 | XRP |
| ZEC | `nep141:zec.omft.near` | 8 | Zcash |
| BERA | `nep141:bera.omft.near` | 18 | Berachain |

## DeFi / Governance Tokens (Ethereum)

| Symbol | Defuse Asset ID | Decimals |
|--------|-----------------|----------|
| UNI | `nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near` | 18 |
| LINK | `nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near` | 18 |
| AAVE | `nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near` | 18 |
| GMX (Arb) | `nep141:arb-0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a.omft.near` | 18 |
| SAFE | `nep141:eth-0x5afe3855358e112b5647b952709e6165e1c1eeee.omft.near` | 18 |

## HOT Bridge Tokens (nep245)

These use the `nep245:` prefix and route through HOT bridge. Supported in swaps but use different token ID format.

| Symbol | Defuse Asset ID | Decimals | Chain |
|--------|-----------------|----------|-------|
| BNB | `nep245:v2_1.omni.hot.tg:56_11111111111111111111` | 18 | BSC |
| POL | `nep245:v2_1.omni.hot.tg:137_11111111111111111111` | 18 | Polygon |
| TON | `nep245:v2_1.omni.hot.tg:1117_` | 9 | TON |
| OP | `nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBo7` | 18 | Optimism |
| AVAX | `nep245:v2_1.omni.hot.tg:43114_11111111111111111111` | 18 | Avalanche |

## Amount Conversion Examples

```
1 NEAR   = 1000000000000000000000000 (24 zeros)
0.1 NEAR = 100000000000000000000000  (23 zeros)
1 USDT   = 1000000                   (6 zeros)
0.01 USDT= 10000                     (4 zeros)
1 ETH    = 1000000000000000000       (18 zeros)
0.01 ETH = 10000000000000000         (16 zeros)
1 BTC    = 100000000                 (8 zeros)
0.001 BTC= 100000                    (5 zeros)
1 SOL    = 1000000000                (9 zeros)
```
