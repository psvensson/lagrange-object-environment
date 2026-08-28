# Portable client host boundary

Status: working reference for ADR 0013. Owner: this doc + ADR 0013. No subsystem code owner (a distinct semantic-UI contract owner is an output of the follow-up native-host work, not presumed here).

ADR 0013 makes **"no browser required"** an architectural invariant and names the browser the **reference host**. This document records the portable-vs-host-specific classification and the two realization routes.

## The model

```
              Lagrange Image
                    │
          semantic environment          (JS reference core — headless, host-independent)
                    │
     Subject / Presentation / Command / Perspective / Composition / Selection
                    │
          host-neutral, data-representable contracts   ← the portability boundary
                    │
              RendererAdapter  (6 ops, opaque handles, data-representable)
              ┌─────┴──────────────┐
        Web browser            Native host (Linux, then Android)
              │                      │
   ┌──────────┴───────┐    ┌─────────┴────────────┐
 SemanticUI → DOM    SemanticUI → GTK / Compose / native controls
 Graphics  → WebGPU  Graphics  → wgpu / Vulkan / Metal  (wasi:webgpu + wasi-gfx)
        (jco instantiation)   (Wasmtime host providing the same WIT imports)
              └──────────┬────────────┘
                  WASM Components (same Component CORE BINARY; host supplies imports)
```

WASM exists to provide **portable, sandboxed executable Presentations and extensions** — code living in an Image that travels with the Image and executes safely wherever the Image is inhabited — not to make a web application.

## Portable vs host-specific

| Layer | Portable (host contract) | Host-specific (one implementation) |
|---|---|---|
| Subject / ref | yes | no |
| Presentation (descriptor) | yes | no |
| Commands | yes | no |
| Perspective (durable layout) | yes | no |
| Composition (tree, viewIds) | yes | no |
| Selection | yes | no |
| Focus semantics | mostly | concrete focus mechanism per host |
| Semantic tool UI | yes (the description) | DOM / GTK / Compose realization |
| Component lifecycle (start/stop/resize/dispose) | yes | runtime embedding (jco vs Wasmtime) |
| GPU API | `wasi:webgpu` | WebGPU / wgpu / Vulkan / Metal |
| Surface / window | abstract | browser canvas / native window / Android Surface |
| Clipboard / IME / accessibility | semantic contract | platform implementation |
| Renderer surface handles | no (opaque to the contract) | yes |

The boundary is **data-representable**: any concept that must cross hosts is plain data (JSON/WIT-value), enforced at the `RendererAdapter` seam (`src/compositor.js` `assertDataRepresentable`). A DOM node, GPU object, or callback cannot cross — it fails loudly.

## Two realization routes

1. **Graphics-Component realizer** (existing): Presentation Component → `wasi:webgpu` → host GPU/surface. For graphics/simulation/visualization. The portable artifact is the **Component core binary + host-provided WIT imports**; the checked-in jco JS glue is the *browser* instantiation, and a native host implements the imports itself.

2. **Semantic-UI realizer** (the DOM lane generalized): a Presentation → a small **semantic description** (`text / action / choice / field / collection / group`) → a host-native realization. **Semantic, not a widget toolkit** — *what the user can do*, never pixel layout. The current DOM realizer (`src/browser-renderer/dom-realizer.js`) is the browser realization; GTK and Compose are the planned native realizations. The host owns appearance and platform conventions (text shaping, IME, clipboard, screen-reader, focus visuals).

## JavaScript

The environment core is implemented in JavaScript and is headless/host-independent today (the browser coupling is contained in `src/browser-renderer/` behind the adapter seam). JS is the **reference implementation of the contracts**, not their definition. Long-term options (ADR 0013 §5): (A) embed a JS runtime in a native host, (B) port the core to Rust/native, (C) make the core itself a WASM Component. **(C)** is the long-term goal; not pursued now.

## Host progression

Browser (reference) → **Linux native** (Tier 1/2) → **Android** (Tier 3). The first native proof is minimal: `navigator`/`inspector` as native controls + the **same GLB Component core binary** via native `wasi:webgpu`/`wasi-gfx`. It empirically falsifies host portability. Android follows once the boundary has survived two genuinely different hosts.

## Falsification (named risks)

- The pinned `wasi:webgpu@0.3.0-rc.2` / `wasi-gfx:surface@0.2.0` versions may not yet be implemented by a native host runtime — verify the **pinned versions**, not just the proposal families.
- The Component's `async start` / async host imports ride JSPI via the jco shim today — mapping them onto Wasmtime's async host functions **without** the jco shim is a real portability risk.
- The investigation is wrong if the `RendererAdapter`/WIT/Compositor contracts turn out browser-coupled in a way that forces a redesign (current evidence: they are not — the seam is data-representable and the WIT imports are host-provided).

## Out of scope (for now)

A native Linux host implementation; the semantic-UI contract's final shape and owner; any expansion of DOM-specific semantics above the adapter seam (ADR 0013 forbids it). Each is a follow-up Bead gated on ADR 0013.
