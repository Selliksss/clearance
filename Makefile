.PHONY: build test test-unit lint demo-testnet

build:
	cd contract && cargo near build non-reproducible-wasm

test:
	cd contract && cargo test

test-unit:
	cd contract && cargo test --lib

lint:
	cd contract && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# Re-records demo/txs.json on testnet (needs the demo accounts' keys locally).
demo-testnet:
	node scripts/demo-testnet.mjs $(or $(CONTRACT),clearance-dev.testnet)
