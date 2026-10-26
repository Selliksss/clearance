.PHONY: build test lint

build:
	cd contract && cargo near build non-reproducible-wasm

test:
	cd contract && cargo test

lint:
	cd contract && cargo fmt --check && cargo clippy --all-targets -- -D warnings
