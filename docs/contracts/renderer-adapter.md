# RendererAdapter contract

Status: canonical reference, extracted from `src/compositor.js` (the authoritative implementation), ADR 0011 §2/§3, ADR 0013, and `docs/ownership.md`. Owner: **Compositor** (`src/compositor.js`) owns the semantic view lifecycle; a **RendererAdapter** implementation owns realization within a host.

This is the boundary between the host-independent environment and a specific host's renderer. Per ADR 0013 it is also the **host-portability boundary**: the browser (`BrowserRendererAdapter` + jco) is the reference host; a native Linux/Android host provides a *new implementation of this same contract*, not a contract change.

## The six operations

`RENDERER_ADAPTER_METHODS` (exactly these; adding a raw-GPU-sounding op like `writeBuffer`/`submit` is caught by the contract test — the boundary is **lifecycle, not GPU**):

| Op | Purpose |
|---|---|
| `createSurface(viewDescriptor)` | Allocate a host surface for a view; returns an **opaque string handle**. |
| `attachPresentation(surfaceHandle, presentationDescriptor)` | Realize a Presentation on the surface. |
| `detachPresentation(surfaceHandle)` | Stop realizing the current Presentation (the surface stays). |
| `resize(surfaceHandle, {width, height})` | Resize the surface. |
| `destroySurface(surfaceHandle)` | Tear down one surface. |
| `destroyAll()` | Tear down every surface (session end / adapter destroy). |

## Hard rules

- **Data-representable boundary.** Everything crossing is **data** — opaque string handles and plain JSON descriptors. `assertDataRepresentable` enforces JSON round-trip deep-equality on each argument: a callback, class instance, Symbol, DOM node, GPU object, or Component/module reference **fails loudly**. No live objects cross.
- **`presentationDescriptor` is plain JSON**: `{kind: string, subject: <image-ref-Value-as-data>, parameters: <plain JSON>}`. It is *not* a `model.js` Presentation instance, *not* a Component, carries no callbacks. Semantic interaction returns via the Command path (ADR 0011 §6) or, for DOM tool kinds, via data-only intents such as `{kind:'activate-item', key}`.
- **Surface handles are transient and Session-scoped.** They live only in the Compositor's private view map — never in `Session.state`, never in a Perspective or the image. A Perspective is rebuilt from durable intent (`{viewId, presentationDescriptor}`) only.
- **Remote-friendly / host-portable (ADR 0011 §2/§3, ADR 0013).** This boundary is one level *above* `wasi:webgpu`. Because only data crosses, a renderer can move to another process/machine/host (RemoteRendererAdapter, native Wasmtime host) without changing Compositor/Presentation/Perspective semantics and without proxying raw GPU calls.
- **One host, one adapter.** The Compositor talks to exactly one RendererAdapter. Host wiring (e.g. `BrowserRendererAdapter`'s `mount`, `realizerFor` dispatch seam, render-target creation, asset-source registration) lives **below** this boundary and is host-specific by design.

## Host implementations

- **Reference:** `src/browser-renderer/browser-renderer-adapter.js` (browser: DOM mount, WebGPU, jco-instantiated Components, DOM tool realizations).
- **Planned:** a native Linux host adapter (GTK/wgpu surface + Wasmtime-provided Component imports) — see ADR 0013 and `docs/architecture/portable-client-host.md`. It implements these same six ops; nothing above changes.
