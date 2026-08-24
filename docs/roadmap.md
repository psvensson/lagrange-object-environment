# Roadmap

The early roadmap is ordered to prove the semantic interaction model before investing in polish.

This repository owns the graphical environment plus the human-facing Project/history/collaboration work that previously sat mixed into the `lagrange-images` roadmap. The durable Project model and generic history/versioning semantics remain in `lagrange-images`.

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
- [x] establish Component-backed 2D/3D graphics as ordinary Presentations, with concrete GPU/surface/WIT hosting owned by `RendererAdapter` (ADR 0011; paired with `lagrange-images` ADR 0062)

Success: the environment can represent its semantic state without inventing storage, Project, history, authorization or graphics-object machinery.

## Phase 1 — first live object loop

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

- [ ] image client adapter using only public `lagrange-images` exports
- [ ] observation/subscription abstraction
- [ ] presentation registry/discovery
- [ ] command registry/discovery
- [ ] generic object inspector
- [ ] generic object/reference navigation
- [ ] explicit unavailable/unauthorized reference presentation
- [ ] first Perspective load/save round trip as ordinary image data

Success: manipulating an object through the environment demonstrably manipulates the image rather than a shadow UI model.

## Phase 2 — composition and first renderer

Use a browser renderer first unless experiments show a strong reason not to. Keep semantic layers renderer-independent.

This absorbs the old `lagrange-images` "Graphical environment" roadmap without inheriting its assumption that windows/widgets are fundamental. ADR 0011 also makes portable Component-backed graphics part of this phase rather than a later separate 3D subsystem.

- [ ] drawing/input/rendering adapter contract
- [ ] `RendererAdapter` host-resource boundary for concrete browser/native surfaces and GPU/device/queue/frame lifecycle
- [ ] text/input/accessibility baseline
- [ ] retained presentation/view state where useful
- [ ] compositor with nested split/stack/scroll primitives
- [ ] surface policy; windows only as one optional composition
- [ ] replaceable world/composition policy
- [ ] selection/focus model linked to semantic subjects
- [ ] command palette/context menu/key binding policy
- [ ] Perspective composition persisted independently of Session mechanics
- [ ] exact-version `wasi:webgpu` plus `wasi-gfx`-style surface interface experiment behind `RendererAdapter`
- [ ] first Component-backed Presentation renders a minimal triangle without a Lagrange-specific GPU/scene ABI
- [ ] extend that proof to one small GLB/glTF-style asset or similarly meaningful 3D example
- [ ] tear down and recreate the Session, proving GPU/device/surface handles are recreated rather than persisted
- [ ] route one semantic interaction from the Component-backed view through the ordinary Command -> authorized image-operation path

Success: inspector/browser tools and Component-backed 2D/3D presentations can be arranged and restored through a Perspective without becoming applications, while concrete graphics resources remain transient renderer/session machinery.

Do not design a common scene graph before the low-level Component boundary is proven with existing ecosystem interfaces and examples.

## Phase 3 — generic live tools

- [ ] image/Project browser
- [ ] object inspector/editor
- [ ] history browser
- [ ] search/query presentations
- [ ] evaluator/transcript
- [ ] process/activation/runtime views where exposed by images
- [ ] debugger built from semantic presentations and commands
- [ ] inspect OpenSmalltalkVM-backed exported structures through explicit image identities/adapters

Success: built-in development feels like inhabiting the image rather than using an external IDE.

## Phase 4 — Project and collaborative-work interaction

The underlying Project model/history remains in Lagrange Images. This phase makes it pleasant to inhabit.

- [ ] Project navigation and relationship presentations
- [ ] creation/editing commands over image-level Project APIs
- [ ] mixed native/OpenSmalltalk Project browser
- [ ] working-view and object/Project-diff presentations
- [ ] merge/conflict commands and resolution UX over lower conflict data
- [ ] Git/file projection commands and progress UX
- [ ] multi-author conflict and activity UX

Success: Project work manipulates one durable image-level model rather than an IDE-side shadow project.

## Phase 5 — language personality integration

Start with Symmetric Smalltalk because it is image-native and exposes the architectural pressure most directly.

- [ ] source and method presentations
- [ ] class/protocol browser
- [ ] senders/implementors
- [ ] evaluation and debugging commands
- [ ] language-contributed presentation/command registration
- [ ] syntax-aware editing kept above language semantic/compiler APIs
- [ ] prove a second language personality uses the same environment substrate

Success: adding another language extends the environment rather than adding another IDE architecture.

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
