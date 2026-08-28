# ADR 0013: The browser is a reference host, not the client platform — "no browser required" and two realization routes

## Status

Accepted. Does **not** supersede ADR 0005 or ADR 0011; it builds on both. ADR 0011 owns the renderer boundary and made graphics Presentations host-provided-import Components; renderer-independence is an emergent property of the ownership/ADR set (the Compositor and registries are renderer-independent). This ADR promotes that renderer-independence from "renderer-agnostic" to "**host-portable**" and states the platform model.

## Context

PR #33 (Bead 9vl) added a DOM realization lane for tool Presentations (`navigator`/`inspector`/…) so a DOM tool and a Component/WebGPU 3D pane coexist behind one `BrowserRendererAdapter` via an injected `realizerFor` dispatch seam. That lane is correct and stays. But it raises a platform question: if the next layers (editing, text, menus, shortcuts, drag/drop, accessibility) are implemented as **DOM concepts**, the browser becomes the real platform and `BrowserRendererAdapter` ceases to be merely one host.

The user's direction (2026-08): **native Linux and Android are genuine goals.** The pivot rests on facts verified against authoritative sources during the investigation plan review (Bead zhc):

- **WASM is not a browser technology.** Wasmtime is the Bytecode Alliance embeddable runtime; the **Component Model is enabled by default** (Tier 1 feature).
- **Wasmtime platform tiers** (docs.wasmtime.dev): `x86_64-unknown-linux-gnu` = **Tier 1**; `aarch64-unknown-linux-gnu` = **Tier 2**; `aarch64-linux-android` = **Tier 3** (reduced CI/maintainer coverage). Linux before Android is therefore the grounded host progression.
- **`wasi:webgpu`** is a Phase-2 WASI proposal for GPU access that explicitly puts **windowing/display out of scope**, delegating it to wasi-gfx.
- **`wasi-gfx`** builds a portable, sandboxed graphics/GPU Component ecosystem "outside the browser", with a **native host runtime** (`wasi-gfx-runtime`) **and a web shim**.
- The existing renderer Component (`renderer-component/wit/world.wit`) already imports only **host-provided** interfaces — `wasi:webgpu`, `wasi-gfx:surface`, `lagrange:assets`, `print` — none web-shaped.

**The portable artifact is the Component core binary + its host-provided WIT imports — not the checked-in jco JS glue.** `test/browser/components/glb/glb.component.js` is jco *instantiation-mode* JS (with JSPI suspensions for host imports); it is the **browser** instantiation. A native Wasmtime host does not get a jco bridge — it implements the same WIT imports itself (e.g. via `wasi-gfx-runtime` plus a Lagrange-native asset provider). "Same Component" means same **core binary**, host supplies the imports.

The deeper potential lock-in is **JavaScript**, not the DOM: the environment core is implemented in JS. This ADR does not rewrite it; see "JavaScript" below.

## Decision

1. **"No browser required" is an architectural invariant.** The browser (`BrowserRendererAdapter` + jco instantiation) is the **reference host**, one host among several — not the client platform. No layer above the `RendererAdapter` contract may assume DOM, a browser event loop, or a browser-only API.

2. **The `RendererAdapter` contract is the portability boundary.** It is already renderer-agnostic and **data-representable** (`src/compositor.js`: the six lifecycle ops; `assertDataRepresentable` loudly rejects any non-data crossing — a DOM node, GPU object, or callback would fail). A native host needs a **new `RendererAdapter` implementation** (a GTK/wgpu host adapter), **not a contract redesign**. The data-representable boundary *is* the portability mechanism.

3. **Two realization routes, both host-portable:**
   - **Graphics-Component realizer** (existing): a Presentation Component → `wasi:webgpu` → host GPU/surface. For 3D, simulation, visualization, CAD, image tools.
   - **Semantic-UI realizer** (new generalization of the DOM lane): a Presentation → a small **semantic UI description** → a **host-native** realization. The current DOM realizer is reinterpreted as *the browser realization of this contract*; a Linux host realizes it as GTK, Android as Compose/native controls.

4. **The semantic-UI description is semantic, not a widget toolkit.** Its vocabulary is `text / action / choice / field / collection / group` — *what the user can do*, never pixel layout or a `LagrangeButton`-style cross-platform widget set. An `action` becomes a `<button>` in the browser, a Compose `Button` on Android, a GTK button on Linux. We are not writing another GUI toolkit; the host owns appearance and platform conventions (text shaping, IME, clipboard, screen-reader, focus visuals).

5. **JavaScript is the reference implementation of the environment contracts, not their definition.** The env core is headless and host-independent today (127 Node unit tests run with no DOM). Over time, increasingly important boundaries become **plain-data / WIT** contracts. Long-term options: **(A)** keep the env core JS and embed a JS runtime in the native host; **(B)** port the env core to Rust/native (browser build compiles to WASM); **(C)** make the env core itself a WASM Component so every host runs the same environment binary. **(C)** is the long-term goal; we do **not** pursue it now.

6. **Host progression: Browser (reference) → Linux native → Android.** The first native proof is a **minimal Linux host**: `navigator`/`inspector` as native controls + the **same GLB Component core binary** via a native `wasi:webgpu`/`wasi-gfx` surface. This is the empirical falsifier of host portability — if the same Component cannot run natively with host-provided imports, the invariant collapses. Android is the third proof, after the boundary has survived two genuinely different hosts.

## Consequences

- **Do not** expand DOM-specific semantics (DOM editing/text/menus as DOM concepts) above the `RendererAdapter` seam. New UI capability is specified against the **semantic-UI description**; the DOM is one realization.
- The existing `BrowserRendererAdapter` + jco instantiation lane stays the reference host and must keep passing (127 unit / 8 browser).
- A native Linux host is new work (a new `RendererAdapter` impl + a Wasmtime/wasi-gfx host for the Component + a native semantic-UI realization). It is **not** started by this ADR; it is a follow-up Bead gated on this ADR.
- **Named risks** (falsification, from the plan review): (i) the pinned `wasi:webgpu@0.3.0-rc.2` / `wasi-gfx:surface@0.2.0` versions may not yet be implemented by a native host runtime — the Linux proof must verify the **pinned versions**, not just the proposal families; (ii) the Component's `async start` / async host imports currently ride JSPI via the jco shim — mapping them onto Wasmtime's async host functions **without** the jco shim is a real portability risk to prove.
- `docs/architecture/portable-client-host.md` carries the working portable-vs-host-specific classification. If a distinct **semantic-UI contract owner** emerges, it is added to `docs/ownership.md` by that follow-up work (this ADR names no new subsystem owner).

## Rejected alternatives

- **Keep building DOM-first UI** — deepens browser lock-in; `BrowserRendererAdapter` stops being one host.
- **Implement the whole inspector UI in WebGPU** — rebuilds text shaping, IME, accessibility, clipboard, screen-reader, selection, platform conventions.
- **A `LagrangeButton`-style cross-platform widget toolkit** — becomes another GUI toolkit; keep the boundary semantic.
- **Jump straight to Android** — Tier 3, immature; prove Linux (Tier 1/2) first.
- **Rewrite the env core to native/WASM now** — premature; JS is the reference, evolve to data/WIT.
