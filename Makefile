.PHONY: build test test-unit test-runner runner-install lint demo-testnet crash replay report certify policy demo

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

# Offline: re-judge every transcript, reproduce attack slots from seeds, verify signatures and history.
replay:
	cd runner && npx tsx src/replay.ts

# Builds reports/<agent>.json from transcripts (selection rule all-valid-v1, suite v1).
report:
	cd runner && npx tsx src/report-cli.ts $(or $(AGENT),protected)

# Issues the agent's certificate on the dev contract from its committed report (runner's function-call key).
certify:
	cd runner && npx tsx src/certify.ts $(or $(AGENT),protected)

# OutLayer policy for the agent's certified level; the owner applies it with their own OutLayer credentials.
policy:
	cd runner && npx tsx src/policy.ts $(or $(AGENT),protected) --receivers $(RECEIVERS)

# For judges: one command, Node only. Add ARGS=--offline to use the saved testnet answers in demo/rpc-cache/.
demo:
	cd runner && (test -d node_modules || npm ci --ignore-scripts --silent) && npx tsx src/demo.ts $(ARGS)
