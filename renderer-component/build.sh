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

# jco --map resolves the mapped specifier to a path RELATIVE to the OUTPUT
# component.js. The output lives at test/browser/components/glb/, four levels
# below the repo root, so the host modules are ../../../../src/browser-renderer/.
echo "==> transpile (jco)"
npx --yes @bytecodealliance/jco@1.32.1 transpile "$OUT_DIR/glb.component.wasm" \
  -o "$OUT_DIR" \
  --no-nodejs-compat --async-wasi-imports --async-wasi-exports \
  --map "wasi:webgpu/webgpu@0.3.0-rc.2=../../../../src/browser-renderer/webgpu.js" \
  --map "wasi-gfx:surface/surface@0.2.0=../../../../src/browser-renderer/surface.js" \
  --map "wasi-gfx:surface/surface-webgpu@0.2.0=../../../../src/browser-renderer/surface-webgpu.js" \
  --map "lagrange:assets/provider@0.1.0=../../../../src/browser-renderer/assets.js" \
  --map "print=../../../../src/browser-renderer/print.js"

echo "==> verify import mappings resolve to src/browser-renderer/"
grep -q "from '../../../../src/browser-renderer/webgpu.js'" "$OUT_DIR/glb.component.js" \
  || { echo "ERROR: webgpu import not mapped to src/browser-renderer"; exit 1; }
grep -q "from '../../../../src/browser-renderer/assets.js'" "$OUT_DIR/glb.component.js" \
  || { echo "ERROR: lagrange:assets import not mapped to src/browser-renderer"; exit 1; }

echo "==> regenerate the Box.glb test fixture"
node "$REPO_ROOT/test/browser/generate-box-glb.js"

echo "OK: GLB Component built + transpiled into $OUT_DIR"
echo "Component imports:"
wasm-tools component wit "$OUT_DIR/glb.component.wasm" 2>/dev/null | grep -E "^  import" || true
