# ADR 0011: Component-backed graphics are presentations, not applications

## Status

Accepted — architectural direction; no renderer implementation is claimed.

## Context

The environment needs to grow from text/object tooling into diagrams, spatial views, visualization and real 3D without becoming a collection of embedded applications or choosing one engine as the architecture.

The WebAssembly Component Model now has a credible portable graphics direction: `wasi:webgpu` expresses low-level GPU access through WIT, while the `wasi-gfx` ecosystem is developing independently versioned surface/frame-buffer interfaces plus native and browser hosts. Lagrange Images ADR 0063 adopts those interface families as the preferred low-level direction without making graphics part of the durable image model.

That lets this repository make a stronger decision than “the renderer may eventually use WebGPU.” A 3D view can be an ordinary Presentation whose renderer happens to be a portable Component.

## Decision

### 1. 2D and 3D remain ordinary Presentations

A graphical view does not introduce an application boundary.

```text
semantic subject + presentation context
        |
        v
Presentation
        |
        +-- ordinary renderer view
        |
        `-- Component-backed renderer
                 |
                 v
          explicit graphics capabilities
```

The same semantic object may simultaneously have a text inspector, source view, diagram, chart and 3D presentation. None replaces the object's identity.

There is no special “3D object” or “3D application” ontology in the Object Environment.

### 2. RendererAdapter owns concrete graphics-host integration

The planned `RendererAdapter` is the single owner of renderer-specific host resources and translation:

- browser/native GPU integration
- concrete device/queue/surface/frame resources
- WIT host providers needed by renderer Components
- conversion between environment renderer requests and the underlying host substrate
- renderer-resource error/lifetime mapping

It does not decide semantic image meaning, command authorization or durable Perspective semantics.

The `Compositor` separately owns logical arrangement: which presentation is visible, where it is placed, its size/transform/stacking/focus relationship and when its logical view enters/leaves the Session. The compositor does not implement WebGPU or WIT.

### 3. Prefer versioned `wasi:webgpu` plus `wasi-gfx`-style surface interfaces

The preferred low-level Component contract is the current ecosystem rather than a new Lagrange graphics ABI:

```text
renderer Component
  imports exact versioned wasi:webgpu interfaces
  imports exact versioned surface/presentation interfaces when required
        |
        v
RendererAdapter host provider
```

`wasi:webgpu` and `wasi-gfx` are still evolving. Therefore the durable invariant is **explicit versioned imports**, not “whatever upstream main means today.” A renderer artifact declares exactly what it needs; an adapter can support several interface versions while migration is useful.

Do not create a universal `lagrange:graphics` or environment-wide scene ABI merely to hide upstream draft churn.

### 4. Surface and GPU resources are Session/runtime resources

Native windows, canvas contexts, GPU adapters/devices/queues, swap chains/surfaces, command buffers and upstream WIT resource handles are transient implementation resources.

They must not be serialized into a Perspective or mistaken for image refs.

A Perspective may durably preserve **intention** such as:

- which semantic subject is presented
- which presentation kind/component is preferred
- layout/composition
- useful view parameters such as a camera pose or visualization settings when deliberately promoted

On restore, the Session and RendererAdapter recreate concrete GPU/surface resources from that intention.

```text
Perspective remembers the view
Session recreates the machinery
```

### 5. Graphics capability does not confer image authority

A Component renderer receives only explicitly declared host interfaces. Lagrange Images remains the authority-enforcing lower boundary described by ADRs 0005/0010 here and ADRs 0037/0038/0062 there.

GPU access does not imply permission to read or mutate the semantic subject. If a presentation needs semantic data, that data is projected through the normal authorized image boundary appropriate to the presentation. If an interaction mutates image state, it goes through a Command and `CommandDispatcher`/`ImageClientAdapter`.

A renderer callback is never a hidden authorization bypass.

### 6. Raw input and semantic commands are different layers

A 3D presentation may need high-rate pointer motion, wheel/touch events, camera controls or hover/picking that should remain local to the Session and renderer.

When an interaction means “perform a semantic operation on this subject,” it becomes the same Command path used by every other presentation.

Examples:

```text
mouse drag rotates camera
  -> Session/presentation-local state

click selects semantic object under cursor
  -> semantic selection

Delete selected object
  -> Command -> authorized image operation
```

This keeps rendering latency low without teaching the GPU layer how to mutate the image.

### 7. Higher-level graphics libraries are optional packages, not the environment kernel

Scene graphs, retained vector APIs, CAD geometry, plotting, physics and game-engine facilities can be libraries or Components above the low-level capability boundary.

The environment may eventually provide convenient shared packages when repeated pressure appears, but it does not require every graphical presentation to use one scene model.

Existing ecosystems should be reusable. A Bevy-like renderer, a tiny library such as `mugl`, or a purpose-built GLB viewer should all be able to coexist if they target an import contract the host supports.

### 8. The first browser renderer does not make the browser semantic

Phase 2 still prefers a browser renderer for convenience. Its WebGPU/canvas/DOM implementation belongs behind `RendererAdapter`.

The same Presentation and Component-backed graphics contracts should admit a later native renderer. Browser DOM objects must not leak upward into Presentation, Perspective, Command or image semantics.

### 9. First proof is a small existing-style Component, not a 3D framework

The first implementation experiment should prove the boundary with the least machinery possible:

1. create one Presentation backed by a Component renderer
2. acquire one logical surface through the compositor/renderer boundary
3. provide one exact-version graphics interface set through `RendererAdapter`
4. render a triangle or similarly minimal example
5. then render one small asset such as GLB/glTF
6. destroy/recreate the Session and prove concrete graphics resources are recreated rather than persisted
7. route one semantic interaction back through the ordinary Command path

Only after that proof should higher-level scene/toolkit abstractions be considered.

## Consequences

A durable object can acquire a rich 3D view without changing the image model:

```text
Image object
  + renderer Component artifact
  + mesh/texture/shader/GLB artifacts
        |
        v
Presentation
        |
        v
Compositor -> RendererAdapter
                |
                +-- surface
                +-- wasi:webgpu-style host provider
                `-- browser/native GPU backend
```

This makes 3D a normal extension of the Smalltalk/Interlisp-style live environment rather than an embedded game engine. Multiple graphics libraries can coexist. Renderer Components remain language-neutral. Native and browser hosts can converge on the same Component contract.

The cost is interface-version churn while `wasi:webgpu`/`wasi-gfx` mature and some additional adapter work. That churn is intentionally localized to `RendererAdapter` and explicit renderer bindings.

## Ecosystem references (non-normative)

Status snapshot: 2026-08-24.

- [`wasi:webgpu`](https://github.com/WebAssembly/wasi-webgpu) — proposed WIT GPU interface; screen/window presentation is deliberately outside its scope.
- [`wasi-gfx`](https://wasi-gfx.dev/) — Component Model graphics/UI interfaces, native runtime and browser shim.
- [`wasi-gfx` interface direction](https://wasi-gfx.dev/blog/posts/future-of-wasi-gfx/) — surface/frame-buffer work moves under the independently versioned `wasi-gfx` namespace.
- [`wasi-gfx` examples](https://github.com/wasi-gfx/wasi-gfx-examples) — small examples and links to larger graphics/GLB examples.
- [`mugl`](https://github.com/andykswong/mugl) — prior art for a small WebGPU/WebGL API exposed toward WASM/WIT; not an environment dependency.

## Guardrails

```text
3D presentation != application
presentation identity != semantic object identity
RendererAdapter owns concrete GPU/surface/WIT host integration
Compositor owns logical arrangement, not GPU semantics
GPU/surface handle != Perspective state
GPU authority != image authority
raw interaction != semantic mutation
semantic mutation -> Command -> authorized image operation
prefer explicit versioned ecosystem WIT over a Lagrange GPU ABI
scene/engine APIs are optional packages above the boundary
browser is an adapter, not the environment ontology
```
