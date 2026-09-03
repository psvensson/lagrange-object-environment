#!/usr/bin/env bash
# Build + transpile the Lagrange GLB renderer Component.
#
# This is the EXACT, pinned toolchain for the renderer Component (Bead
# lagrange-object-environment-ts5 slice 1). The built artifacts
# (test/browser/components/glb/*) are CHECKED IN; CI does NOT rebuild them (no
# Rust toolchain in the Xvfb lane). Run this script manually to regenerate them
# after changing renderer-component/src or renderer-component/wit.
#
# Pinned toolchain (ALL THREE are artifact-identity inputs; see Bead ocj):
#   - rustc 1.89.0 + wasm32-unknown-unknown, selected by renderer-component/
#     rust-toolchain.toml (rustup auto-installs it; needs network once). The
#     checked-in Component is byte-reproducible ONLY with this compiler -- any
#     other rustc moves the sha256 with Cargo.lock unchanged (measured 2026-09-03).
#   - wasm-tools 1.244.0   (cargo install wasm-tools --version 1.244.0 --locked)
#     Run tooling installs from the REPO ROOT or with `cargo +stable`: inside
#     renderer-component/ the toolchain file selects 1.89.0, which may not meet
#     wasm-tools' MSRV. Older wasm-tools (e.g. 1.236.0) FAIL on wit-bindgen 0.57
#     output with "invalid leading byte 0x43"; the exact version is gated below.
#   - jco 1.32.1           (npx @bytecodealliance/jco@1.32.1, pinned in the call)
#
# Artifact identity gate: the produced glb.component.wasm must hash to
# EXPECTED_COMPONENT_SHA256 -- the constant is pinned in THREE places (this
# script, hosts/linux/tests/l1_portability.rs, hosts/linux/src/main.rs; Bead b1j
# tracks the duplication). A mismatch is a HARD FAILURE unless
# ALLOW_COMPONENT_SHA_CHANGE=1 is set -- the deliberate re-pin path after a real
# source/toolchain change, which must update all three pins and re-prove the
# browser + native lanes.
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
EXPECTED_WASM_TOOLS_VERSION="1.244.0"
EXPECTED_COMPONENT_SHA256="c64b061cf1fcccb5a0adb80495acf2269ab572aed7758ecaa5b97e4eefea0811"

EXPECTED_RUSTC_VERSION="rustc 1.89.0 (29483883e 2025-08-04)"

echo "==> toolchain gates"
command -v wasm-tools >/dev/null 2>&1 || { echo "ERROR: wasm-tools $EXPECTED_WASM_TOOLS_VERSION not on PATH (see header for the pinned install)"; exit 1; }
ACTUAL_WASM_TOOLS_VERSION="$(wasm-tools --version | awk '{print $2}')"
if [ "$ACTUAL_WASM_TOOLS_VERSION" != "$EXPECTED_WASM_TOOLS_VERSION" ]; then
  echo "ERROR: wasm-tools $EXPECTED_WASM_TOOLS_VERSION required (artifact-identity input), found $ACTUAL_WASM_TOOLS_VERSION"
  exit 1
fi
# rustc is selected by renderer-component/rust-toolchain.toml; gate it so a
# deleted/renamed toolchain file cannot silently fall back to ambient stable.
ACTUAL_RUSTC_VERSION="$(cd "$COMPONENT_DIR" && rustc --version)"
if [ "$ACTUAL_RUSTC_VERSION" != "$EXPECTED_RUSTC_VERSION" ]; then
  echo "ERROR: '$EXPECTED_RUSTC_VERSION' required (artifact-identity input; renderer-component/rust-toolchain.toml), found '$ACTUAL_RUSTC_VERSION'"
  exit 1
fi
echo "rustc: $ACTUAL_RUSTC_VERSION; wasm-tools: $ACTUAL_WASM_TOOLS_VERSION"

echo "==> build (cargo, wasm32-unknown-unknown, release)"
# --locked: a stale or hand-edited Cargo.lock is a hard error, never a silent
# rewrite (the lock is an artifact-identity input alongside the toolchain).
(cd "$COMPONENT_DIR" && cargo build --release --locked --target wasm32-unknown-unknown)

echo "==> componentize (wasm-tools component new)"
mkdir -p "$OUT_DIR"
# Componentize into the (untracked) target dir first: the identity gate below
# must pass BEFORE anything tracked under $OUT_DIR is touched, so a failed gate
# leaves the checked-in artifacts pristine (no .wasm/.js mismatch to commit).
STAGED_COMPONENT="$COMPONENT_DIR/target/glb.component.wasm"
wasm-tools component new "$WASM" -o "$STAGED_COMPONENT"

echo "==> artifact identity gate (sha256 of glb.component.wasm)"
ACTUAL_COMPONENT_SHA256="$(sha256sum "$STAGED_COMPONENT" | awk '{print $1}')"
echo "component sha256: $ACTUAL_COMPONENT_SHA256"
if [ "$ACTUAL_COMPONENT_SHA256" != "$EXPECTED_COMPONENT_SHA256" ]; then
  if [ "${ALLOW_COMPONENT_SHA_CHANGE:-0}" = "1" ]; then
    echo "WARNING: component sha256 CHANGED (ALLOW_COMPONENT_SHA_CHANGE=1). This is an artifact-identity"
    echo "         re-pin: update EXPECTED_COMPONENT_SHA256 in ALL THREE pins (this script,"
    echo "         hosts/linux/tests/l1_portability.rs, hosts/linux/src/main.rs) and re-prove the"
    echo "         browser + native lanes."
  else
    echo "ERROR: component sha256 does not match EXPECTED_COMPONENT_SHA256 ($EXPECTED_COMPONENT_SHA256)."
    echo "       Either the source/toolchain changed deliberately (re-run with ALLOW_COMPONENT_SHA_CHANGE=1"
    echo "       and re-pin, see header) or the build environment drifted (wrong rustc/wasm-tools)."
    echo "       Nothing under $OUT_DIR was modified."
    exit 1
  fi
fi
mv "$STAGED_COMPONENT" "$OUT_DIR/glb.component.wasm"

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
