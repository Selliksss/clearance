.PHONY: verify-build build test test-unit test-runner runner-install lint demo-testnet crash replay report certify policy demo judge-hash

# Reproducible build (Docker) at the current commit; crash runs use the code deployed on testnet, not this build.
build:
	cd contract && cargo near build reproducible-wasm

# Rebuilds the deployed contract from source in the pinned Docker image (NEP-330) and compares its hash
# with deploy/contract.json and with the code clearance-dev.testnet runs now (RPC).
verify-build:
	@rev=$$(python3 -c "import json;print(json.load(open('deploy/contract.json'))['build']['source_rev'])"); \
	tmp=$$(mktemp -d); git clone -q . $$tmp/src && git -C $$tmp/src checkout -q $$rev && \
	echo "building commit $$rev in a clean clone (the build embeds its commit, NEP-330)" && \
	(cd $$tmp/src/contract && cargo near build reproducible-wasm >/dev/null 2>&1) && \
	want=$$(python3 -c "import json;print(json.load(open('deploy/contract.json'))['code_hash'])") && \
	got=$$(python3 -c "import hashlib,sys;a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(hashlib.sha256(open(sys.argv[1],'rb').read()).digest(),'big');o='';exec('while n:\n n,r=divmod(n,58)\n o=a[r]+o');print(o)" $$tmp/src/contract/target/near/clearance.wasm) && \
	chain=$$(curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"clearance-dev.testnet"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['code_hash'])") && \
	rm -rf $$tmp; echo "rebuilt  $$got"; echo "recorded $$want (deploy/contract.json)"; echo "testnet  $$chain (clearance-dev.testnet now)"; \
	test "$$got" = "$$want" && test "$$got" = "$$chain" && echo "verify-build: PASS (testnet runs the reproducible build of commit $$rev)"

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
crash:
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

# The judge hash a CI certificate carries in run_ref, for any commit: make judge-hash REF=<sha>
judge-hash:
	cd runner && npx tsx src/judge-hash.ts $(or $(REF),HEAD)

# For judges: one command, Node only. Add ARGS=--offline to use the saved testnet answers in demo/rpc-cache/.
demo:
	cd runner && (test -d node_modules || npm ci --ignore-scripts --silent) && npx tsx src/demo.ts $(ARGS)
