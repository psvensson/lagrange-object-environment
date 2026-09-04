# Roadmap

The early roadmap is ordered to prove the semantic interaction model before investing in polish.

This repository owns the graphical environment plus the human-facing Project/history/collaboration work that previously sat mixed into the `lagrange-images` roadmap. The durable Project model, native-import semantics and generic history/versioning semantics remain in `lagrange-images`.

`lagrange-images` ADR 0085 makes progressive native import of an existing application the primary language-convergence path. This environment owns the human interaction over that path — import commands/progress/diagnostics, source/provenance presentation and ordinary navigation/editing of the resulting native objects — but it does not own import semantics, runtime fallback or a shadow language-object store.

## Current product vertical

Take an existing Cuis application progressively from source/provenance through Images-native classes, methods and application state, and make those native objects usable through the ordinary Object Environment. Environment work follows the public Images native-import milestones; it never implements the importer or mirrors the Cuis heap.

The forcing distinction is:

```text
language origin != runtime representation != object identity
```

After native import, Cuis provenance may influence presentations and available Commands, but the class, method or object remains the same ordinary Images-native identity reached through the ordinary authority and mutation paths.

## Phase 0 — boundary and vocabulary

- [x] establish Image = workspace/world
- [x] establish Project vs Perspective vs Session responsibilities
- [x] establish `reference != authority` as an inherited security rule
- [x] establish environment as a public `lagrange-images` consumer
- [x] create headless Presentation, Command, Perspective and Session models
- [x] split image-level Project/history semantics from environment-level Project/history UX
- [x] decide the minimal ordinary-image-object representation/protocol for durable Perspective (ADR 0008; `src/perspective-projection.js`)
- [x] identify the public image observation/change-feed seam needed by live presentations (ADR 0009; `src/image-observation.js`)
- [x] identify command invocation/transaction semantics without adding UI concerns to images (ADR 0010; `src/command-dispatcher.js`)
- [x] establish Component-backed 2D/3D graphics as ordinary Presentations, with concrete GPU/surface/WIT hosting owned by `RendererAdapter` (ADR 0011; paired with `lagrange-images` ADR 0063)

Success: the environment can represent its semantic state without inventing storage, Project, history, authorization, import or graphics-object machinery.

## Phase 1 — first live object loop ✅ **COMPLETE**

_All deliverables landed; the success criterion is proven by `test/phase1-e2e.integration.test.js` (PR #19). Phase 2 begins on a proven semantic core._

Build the smallest end-to-end experience against a real/mock Lagrange Image:

```text
connect as principal
  -> choose/open image
  -> present root/project/object
  -> inspect object
  -> select semantic subject
  -> discover command
  -> invoke authorized mutation
  -> observe change
  -> presentation updates
```

Deliverables:

- [x] image client adapter using only public `lagrange-images` exports (`src/image-client-adapter.js`)
- [x] observation/subscription abstraction (ADR 0009; `src/image-observation.js`)
- [x] presentation registry/discovery (`src/presentation-registry.js`)
- [x] command registry/discovery (`src/command-registry.js`)
- [x] generic object inspector (`src/object-navigator.js` + `src/object-presentation-providers.js`)
- [x] generic object/reference navigation (`src/object-navigator.js`)
- [x] explicit unavailable/unauthorized reference presentation (`src/object-presentation-providers.js`)
- [x] first Perspective load/save round trip as ordinary image data (ADR 0012; `src/image-client-adapter.js`)

Success: manipulating an object through the environment demonstrably manipulates the image rather than a shadow UI model. **Proven by the Phase 1 end-to-end proof (`test/phase1-e2e.integration.test.js`, PR #19): the full loop — open → present (discovered) → inspect → navigate a stored ref → command (discovered) → invoke through `CommandDispatcher` → authorized in-place mutation → observe → presentation updates — runs against the real runtime, and a shadow model cannot satisfy it.**

## Phase 2 — composition and first renderer

Use a browser renderer first unless experiments show a strong reason not to. Keep semantic layers renderer-independent.

This absorbs the old `lagrange-images` "Graphical environment" roadmap without inheriting its assumption that windows/widgets are fundamental. ADR 0011 also makes portable Component-backed graphics part of this phase rather than a later separate 3D subsystem.

- [x] rendering adapter contract — the 6-op lifecycle-only, data-representable `RendererAdapter` contract (`src/compositor.js` `RENDERER_ADAPTER_METHODS`), realized by `FakeRendererAdapter` and `BrowserRendererAdapter`; opaque transient Session-scoped handles; contained failure; idempotent teardown. (Input routing lives behind the same adapter — see "route one semantic interaction" below.)
- [x] `RendererAdapter` host-resource boundary for concrete browser/native surfaces and GPU/device/queue/frame lifecycle — `BrowserRendererAdapter` owns all concrete host resources (canvas, WebGPU contexts, the instantiated Component, shim `navigator.gpu` resources) and returns only opaque handles upward (`docs/ownership.md`, `src/browser-renderer/`).
- [ ] text/IME/accessibility baseline (split out from the old "drawing/input" item; NOT part of the adapter contract — separate concern)
- [ ] retained presentation/view state where useful
- [x] nested Presentation/Split/Stack composition kernel (`src/composition-tree.js`): renderer-independent, immutable, validated; durable viewId leaves; no focus/selection/geometry/window-policy. Plus durable logical-view identity (`openView` re-admits persisted viewIds).
- [ ] Scroll composition primitive (when a real tool demands it)
- [ ] surface policy; windows only as one optional composition
- [ ] replaceable world/composition policy
- [x] selection/focus model linked to semantic subjects — focus (which logical view; transient Session state; Compositor) strictly distinct from selection (which semantic subject; `SelectionModel`); subject from presentationDescriptor, never renderer input; selection keyed by identity (survives renderer teardown), confers zero authority, transient, never in Perspective (`src/selection-model.js`, `src/compositor.js`).
- [ ] command palette/context menu/key binding policy
- [x] Perspective composition persisted independently of Session mechanics (`src/composition-persistence.js`): tree↔presentation bijection, versioned layout payload, `empty()`, viewDescriptor-free (realization policy supplies it on restore); round-trips through the real authorized save/load; destroy/recreate with new handles restores the identical composition.
- [x] exact-version `wasi:webgpu` plus `wasi-gfx`-style surface interface experiment behind `RendererAdapter` — the real triangle Component (`wasi:webgpu/webgpu@0.3.0-rc.2` + `wasi-gfx:surface/*@0.2.0`, jco-transpiled) runs behind `BrowserRendererAdapter` (`src/browser-renderer/`), consuming ONLY the public `@wasi-gfx/wasi-gfx-shim/webgpu` host provider (pinned `0.1.0`); Lagrange owns the surface/multi-view/lifecycle. The renderer renders to a host-side **RenderTarget** realization the Component never sees (`src/browser-renderer/render-target.js`): `CanvasRenderTarget` (on-screen browser presentation) or `TextureRenderTarget` (headless/test/export, deterministic read-back) — the seam a future remote renderer plugs into.
- [x] first Component-backed Presentation renders a minimal triangle without a Lagrange-specific GPU/scene ABI — pixel proof is split by environment: **CI (gating, Xvfb/headless SwiftShader)** verifies real Component → WIT → shim → `TextureRenderTarget` → triangle pixels, plus the `CanvasRenderTarget` two-surface/resize/teardown/recreate lifecycle, without canvas pixels (`test/browser/browser-proof.test.js`); the **full on-screen canvas pixel proof** is a manual real-display test (`npm run test:browser:canvas`), because reading back an on-screen canvas's WebGPU texture crashes Chrome+SwiftShader under Xvfb/headless (an environment limitation, not an implementation bug).
- [x] extend that proof to one small GLB/glTF-style asset or similarly meaningful 3D example
- [x] tear down and recreate the Session, proving GPU/device/surface handles are recreated rather than persisted — proven in both the texture-target CI proof and the canvas lifecycle proof (fresh Session recreates the render view from durable intent).
- [x] route one semantic interaction from the Component-backed view through the ordinary Command -> authorized image-operation path

Success: inspector/browser tools and Component-backed 2D/3D presentations can be arranged and restored through a Perspective without becoming applications, while concrete graphics resources remain transient renderer/session machinery.

Do not design a common scene graph before the low-level Component boundary is proven with existing ecosystem interfaces and examples.

## Phase 3 — generic live tools

- [x] first read-only durable Project browser: authorized canonical descriptor, Project Presentation, DOM+GTK SemanticUi, member activation through generic cross-Image navigation, explicit refresh/retarget and observation-driven reread (`src/project-browser.js`; Bead mky)
- [ ] broader image browser/query roots
- [ ] object inspector/editor
- [ ] history browser
- [ ] search/query presentations
- [ ] evaluator/transcript
- [ ] process/activation/runtime views where exposed by images
- [ ] debugger built from semantic presentations and commands
- [ ] inspect native-imported classes/methods/objects through the ordinary generic object/language paths
- [ ] inspect semantic-export/source/provenance artifacts as import evidence without treating them as the editable runtime object model

Success: built-in development feels like inhabiting the image rather than using an external IDE. A Cuis-origin object that has been native-imported is edited as the same ordinary Images object any other tool sees.

## Phase 4 — Project and collaborative-work interaction

The underlying Project model/history and native-import semantics remain in Lagrange Images. This phase makes them pleasant to inhabit.

- [x] read-only Project navigation and member relationship presentation (canonical Images descriptor, no shadow Project model; Bead mky)
- [x] first authorized Project edit command: rename through the Images-owned ADR 0080 seam and the ordinary Environment Command path (Bead okv)
- [ ] further Project creation, member and namespace editing as future public Images semantics provide evidence and contracts
- [ ] language/application import command + progress/diagnostic presentation over public Images-owned import APIs
- [ ] mixed Project browser showing source/provenance, native-imported members and any deliberately retained explicit foreign-service boundaries without conflating them
- [ ] working-view and object/Project-diff presentations
- [ ] merge/conflict commands and resolution UX over lower conflict data
- [ ] Git/file projection commands and progress UX
- [ ] multi-author conflict and activity UX

Success: Project work manipulates one durable image-level model rather than an IDE-side shadow project, and import UX never becomes a second semantic importer.

## Phase 5 — language personality integration

**Cuis is the first end-user language personality target.** Symmetric Smalltalk remains the native semantic/compiler baseline and an important reference implementation, but the product sequence does not build a complete Symmetric-Smalltalk IDE before proving an imported language.

The first pressure comes from real Cuis classes, methods and objects that Images has successfully native-imported. Those are ordinary Images-native identities. Cuis provenance may contribute presentation choices, Commands and presentation-specific semantic policy; it must never select another navigator, dispatcher, authority path, renderer route, mutation mechanism or object store.

- [ ] present one Cuis-origin, Images-native class through ordinary discovery: name, superclass, protocol/category where exposed, methods, and provenance as secondary information
- [ ] browse that native class to native methods and present selector, source and protocol while preserving native method identity
- [ ] introduce the smallest useful `PersonalityExtensionRegistry` contract only when the first real Cuis-native consumer requires personality-contributed Presentation providers or Commands
- [ ] route the first useful edit/evaluation operation through SemanticUi intent -> ordinary Command -> public Images semantic operation -> fresh authoritative reread
- [ ] add senders/implementors, syntax-aware editing, history or debugging only when the real Cuis workflow supplies concrete pressure
- [ ] prove one independently authored Cuis application can be browsed, understood and edited here while its authoritative native state survives restart without a live Cuis heap
- [ ] prove a later language personality uses the same environment substrate after the Cuis path has established the reusable native-import boundary

Success: an existing Cuis application becomes ordinary native classes, methods and durable objects operated through the generic environment, with OpenSmalltalkVM retained only as explicit importer, provenance, oracle or deliberately bounded foreign-service machinery. Adding another language extends the environment rather than adding another IDE architecture.

## Phase 6 — identity and collaboration UX

After the live interaction loop and lower authority APIs are stable:

- [ ] principal/group picker backed by cluster identity APIs
- [ ] define the lower authority contract needed to express "share this Project" without transitive-ref assumptions
- [ ] share object/Project flow through trusted authorization APIs
- [ ] share/publish Perspective independently of referenced-object authority
- [ ] pending invitation handoff for principals who do not yet exist
- [ ] collaborative Perspective semantics
- [ ] presence as ephemeral/session data unless deliberately persisted

Success: two users can inhabit overlapping parts of one image with different authority and independently chosen views.

## Later experiments

- spatial/infinite-canvas worlds
- notebook/document composition
- overlapping-window policy
- semantic drag/drop as commands between subjects
- macro/command composition
- user-authored presentations inside the image
- remote/multi-image presentations
- collaborative debugging and operational views
- alternate native renderers
- shared higher-level scene/plotting/CAD libraries only where repeated Component presentations demonstrate common pressure

These should remain experiments until the core Presentation -> Command -> Image loop and the low-level renderer/Component boundary are proven.
