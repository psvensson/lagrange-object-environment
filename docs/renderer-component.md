# Renderer Component toolchain

The GLB renderer Component (`renderer-component/`) is a WebAssembly Component
that renders a GLB-loaded mesh through `wasi:webgpu` + `wasi-gfx:surface`, with
durable asset bytes crossing the host -> Component boundary at runtime via
`lagrange:assets/provider@0.1.0`. This is Phase 2 PR C.

## What is checked in vs. rebuilt

The built artifacts under `test/browser/components/glb/` (the `.wasm`, the
jco-transpiled `.js`/`.core.wasm`, the `.d.ts`) are **checked in**. CI does NOT
rebuild them (the Xvfb browser lane has no Rust toolchain). Regenerate them
manually after changing `renderer-component/src` or `renderer-component/wit`.

## Pinned toolchain

All three inputs below are **artifact-identity inputs**: the checked-in
Component's sha256 (`c64b061c…`, pinned by `hosts/linux/tests/l1_portability.rs`,
`hosts/linux/src/main.rs` and `build.sh`) is a function of them plus the
committed `Cargo.lock`.

- **rustc 1.89.0** + the `wasm32-unknown-unknown` target, selected by
  `renderer-component/rust-toolchain.toml` (rustup auto-installs both; network
  needed once; if 1.89.0 was already installed without the target, run
  `rustup target add --toolchain 1.89.0 wasm32-unknown-unknown`). `build.sh`
  gates the exact rustc version. This is deliberately NOT the `hosts/linux` compiler (1.98.0):
  measured 2026-09-03 (Bead `ocj`), rebuilding with rustc 1.98.0 left
  `Cargo.lock` unchanged yet moved every artifact (component sha256 →
  `84c09ad7…`, a 14k-line `glb.component.js` diff, `.d.ts` reordering), while
  rustc 1.89.0 reproduces the checked-in bytes exactly. Moving the compiler is
  an artifact re-pin, not a hygiene change — it needs regenerated artifacts,
  updated Rust pins and a full browser + native re-proof (own Bead).
- **wasm-tools 1.244.0** — `cargo install wasm-tools --version 1.244.0 --locked`,
  run from the repo root or with `cargo +stable` (inside `renderer-component/`
  the toolchain file selects 1.89.0). Older wasm-tools (e.g. 1.236.0) FAIL on
  wit-bindgen 0.57 output with `invalid leading byte 0x43`. `build.sh` gates the
  exact version.
- **jco 1.32.1** — `npx @bytecodealliance/jco@1.32.1` (pinned in the call).
  At these pinned versions jco and wasm-tools are deterministic: from the
  checked-in `glb.component.wasm` they reproduce the checked-in
  `.js`/`.d.ts`/`core*.wasm` byte-for-byte (only the input-derived output
  filename differs).

`build.sh` builds with `cargo build --locked` (a stale lock is a hard error,
never a silent rewrite) and fails if the produced `glb.component.wasm` does not
hash to `EXPECTED_COMPONENT_SHA256`; the gate runs on a staged copy, so a
failure leaves the checked-in artifacts untouched. The deliberate re-pin path is
`ALLOW_COMPONENT_SHA_CHANGE=1 ./renderer-component/build.sh`, followed by
updating all three pins (`build.sh`, `hosts/linux/tests/l1_portability.rs`,
`hosts/linux/src/main.rs`) and re-proving both lanes. The browser lane pins no
sha today (Bead `iwu`); only `l1_portability::same_component_hash` asserts it.

## Build

```sh
./renderer-component/build.sh
```

This: builds the crate to `wasm32-unknown-unknown`, componentizes with
`wasm-tools component new`, transpiles with jco (mapping the five WIT imports to
the Lagrange-owned host providers under `src/browser-renderer/`), verifies the
import mappings resolve, and regenerates the `Box.glb` test fixture via
`test/browser/generate-box-glb.js`.

## Component imports (verified by build.sh)

```
import lagrange:assets/provider@0.1.0;
import wasi:webgpu/webgpu@0.3.0-rc.2;
import wasi-gfx:surface/surface@0.2.0;
import wasi-gfx:surface/surface-webgpu@0.2.0;
import print: func(s: string);
```

The Component is unaware of the RenderTarget realization (canvas vs texture) —
that stays host wiring. It is also unaware of the asset-bytes authority: it only
calls `load(name)` with a PRESENTATION-LOCAL name (e.g. `load("main-model")`),
never an image/object id. The Component is transpiled in jco INSTANTIATION mode,
so per attach the adapter builds a fresh provider (`createAssetProvider`) and
binds it as `imports['lagrange-assets']` for THAT ONE Component instance — there
is no process-global provider, and Component A's `load` closure cannot reach
Component B's bytes (Bead `lagrange-object-environment-0dm`). The environment
resolves the durable asset refs to bytes under per-ref `object/read`
(`ImageClientAdapter.resolveAssetBytes`) and hands the adapter only the opaque
attach-scoped allowlist.

## Supported GLB subset (the rejection contract)

One mesh, one primitive, `POSITION` + `NORMAL` float32 non-interleaved
accessors, uint16 indices; no materials, textures, Draco, or sparse accessors.
Anything else returns `err(string)` from the parser and the Component renders
nothing. Textures-from-GLB, multiple primitives, materials, and animations are
follow-up Beads.
