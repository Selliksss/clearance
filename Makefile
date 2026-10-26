.PHONY: build test test-unit test-runner runner-install lint demo-testnet crash

build:
	cd contract && cargo near build non-reproducible-wasm

test:
	cd contract && cargo test

runner-install:
	cd runner && npm ci --ignore-scripts

test-runner:
	cd runner && npx tsc --noEmit && npx vitest run

test-unit:
	cd contract && cargo test --lib

lint:
	cd contract && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# Re-records demo/txs.json on testnet (needs the demo accounts' keys locally).
demo-testnet:
	node scripts/demo-testnet.mjs $(or $(CONTRACT),clearance-dev.testnet)

# Crash-test runs in a local sandbox (needs NEARAI_API_KEY in ~/.config/dopusk/.env).
crash: build
	cd runner && npx tsx src/cli.ts crash --agent $(or $(AGENT),naive) $(ARGS)
