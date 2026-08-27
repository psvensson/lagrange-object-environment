#!/usr/bin/env bash
# Build + transpile the Lagrange GLB renderer Component.
#
# This is the EXACT, pinned toolchain for the renderer Component (Bead
# lagrange-object-environment-ts5 slice 1). The built artifacts
# (test/browser/components/glb/*) are CHECKED IN; CI does NOT rebuild them (no
# Rust toolchain in the Xvfb lane). Run this script manually to regenerate them
# after changing renderer-component/src or renderer-component/wit.
#
# Pinned toolchain:
#   - Rust + the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown)
#   - wasm-tools 1.244.0   (cargo install wasm-tools --version 1.244.0 --locked)
#     NOTE: older wasm-tools (e.g. 1.236.0) FAIL on wit-bindgen 0.57 output with
#     "invalid leading byte 0x43"; 1.244.0 is required.
#   - jco 1.32.1           (npx @bytecodealliance/jco@1.32.1)
#
# The Component imports wasi:webgpu/webgpu@0.3.0-rc.2 + wasi-gfx:surface/*@0.2.0
# + lagrange:assets/provider@0.1.0 + print, mapped to the Lagrange-owned host
# providers under src/browser-renderer/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT_DIR="$REPO_ROOT/renderer-component"
OUT_DIR="$REPO_ROOT/test/browser/components/glb"
WASM="$COMPONENT_DIR/target/wasm32-unknown-unknown/release/glb_renderer.wasm"
HOST="$REPO_ROOT/src/browser-renderer"

echo "==> build (cargo, wasm32-unknown-unknown, release)"
(cd "$COMPONENT_DIR" && cargo build --release --target wasm32-unknown-unknown)

echo "==> componentize (wasm-tools component new)"
mkdir -p "$OUT_DIR"
wasm-tools component new "$WASM" -o "$OUT_DIR/glb.component.wasm"

# Transpile in jco INSTANTIATION mode (`--instantiation async`): the output
# exports `instantiate(getCoreModule, imports)` instead of a module-level
# `start`, so EACH attach constructs a fresh Component instance with its OWN
# host imports — critically its own `lagrange:assets/provider` `load` closure
# (Bead lagrange-object-environment-0dm: per-Component asset isolation, no
# process-global provider). The `--map` specifier becomes the KEY the adapter
# uses in the `imports` object; we use stable bare specifiers (not file paths)
# so the adapter passes `imports['lagrange-assets']` etc.
echo "==> transpile (jco, instantiation mode)"
npx --yes @bytecodealliance/jco@1.32.1 transpile "$OUT_DIR/glb.component.wasm" \
  -o "$OUT_DIR" \
  --no-nodejs-compat --async-wasi-imports --async-wasi-exports \
  --instantiation async \
  --map "wasi:webgpu/webgpu@0.3.0-rc.2=lagrange-webgpu" \
  --map "wasi-gfx:surface/surface@0.2.0=lagrange-surface" \
  --map "wasi-gfx:surface/surface-webgpu@0.2.0=lagrange-surface-webgpu" \
  --map "lagrange:assets/provider@0.1.0=lagrange-assets" \
  --map "print=lagrange-print"

echo "==> verify instantiation-mode output + bare-specifier import keys"
grep -q "export function instantiate(getCoreModule, imports" "$OUT_DIR/glb.component.js" \
  || { echo "ERROR: instantiation-mode transpile did not export instantiate(getCoreModule, imports)"; exit 1; }
grep -q "imports\['lagrange-assets'\]" "$OUT_DIR/glb.component.js" \
  || { echo "ERROR: lagrange:assets import not keyed by 'lagrange-assets'"; exit 1; }
grep -q "imports\['lagrange-webgpu'\]" "$OUT_DIR/glb.component.js" \
  || { echo "ERROR: wasi:webgpu import not keyed by 'lagrange-webgpu'"; exit 1; }

echo "==> regenerate the Box.glb test fixture"
node "$REPO_ROOT/test/browser/generate-box-glb.js"

echo "OK: GLB Component built + transpiled into $OUT_DIR"
echo "Component imports:"
wasm-tools component wit "$OUT_DIR/glb.component.wasm" 2>/dev/null | grep -E "^  import" || true
