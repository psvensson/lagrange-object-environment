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

- Rust + the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- **wasm-tools 1.244.0** — `cargo install wasm-tools --version 1.244.0 --locked`.
  Older wasm-tools (e.g. 1.236.0) FAIL on wit-bindgen 0.57 output with
  `invalid leading byte 0x43`; 1.244.0 is required.
- **jco 1.32.1** — `npx @bytecodealliance/jco@1.32.1`

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
calls `load-glb(name)`; the host (`src/browser-renderer/assets.js`, injected
per-attach by `BrowserRendererAdapter`) supplies the bytes.

## Supported GLB subset (the rejection contract)

One mesh, one primitive, `POSITION` + `NORMAL` float32 non-interleaved
accessors, uint16 indices; no materials, textures, Draco, or sparse accessors.
Anything else returns `err(string)` from the parser and the Component renders
nothing. Textures-from-GLB, multiple primitives, materials, and animations are
follow-up Beads.
