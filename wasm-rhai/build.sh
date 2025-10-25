#!/usr/bin/env bash
set -euo pipefail
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ./pkg ./target/wasm32-unknown-unknown/release/wasm_rhai.wasm
echo "OK"
