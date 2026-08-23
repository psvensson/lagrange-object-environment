# Roadmap

The early roadmap is ordered to prove the semantic interaction model before investing in polish.

This repository now also owns the Project/collaboration and graphical-environment work that previously lived in the `lagrange-images` roadmap. `lagrange-images` remains responsible for generic graph/history/execution primitives that are useful without this environment.

## Phase 0 — boundary and vocabulary

- [x] establish Image = workspace/world
- [x] establish Project vs Perspective vs Session responsibilities
- [x] establish `reference != authority` as an inherited security rule
- [x] establish environment as a public `lagrange-images` consumer
- [x] create headless Presentation, Command, Perspective and Session models
- [x] separate Project/collaboration/UI responsibility from `lagrange-images`
- [ ] decide the first ordinary-image-object representation/protocol for Project
- [ ] decide the minimal ordinary-image-object representation/protocol for durable Perspective
- [ ] identify the public image observation/change-feed seam needed by live presentations
- [ ] identify command invocation/transaction semantics without adding UI concerns to images

Success: the environment can represent its semantic state without inventing storage, identity or authorization machinery.

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

This absorbs the old `lagrange-images` "Graphical environment" roadmap without inheriting its assumption that windows/widgets are fundamental.

- [ ] drawing/input/rendering adapter contract
- [ ] text/input/accessibility baseline
- [ ] retained presentation/view state where useful
- [ ] compositor with nested split/stack/scroll primitives
- [ ] surface policy; windows only as one optional composition
- [ ] replaceable world/composition policy
- [ ] selection/focus model linked to semantic subjects
- [ ] command palette/context menu/key binding policy
- [ ] Perspective composition persisted independently of Session mechanics

Success: inspector/browser tools can be arranged and restored through a Perspective without becoming applications.

## Phase 3 — generic live tools

- [ ] image/project browser
- [ ] object inspector/editor
- [ ] history browser
- [ ] search/query presentations
- [ ] evaluator/transcript
- [ ] process/activation/runtime views where exposed by images
- [ ] debugger built from semantic presentations and commands
- [ ] inspect OpenSmalltalkVM-backed exported structures through explicit image identities/adapters

Success: built-in development feels like inhabiting the image rather than using an external IDE.

## Phase 4 — Projects and collaborative work

This absorbs the user-facing half of the old `lagrange-images` "Projects and collaborative history" roadmap.

- [ ] Project objects/relationships as an environment convention over ordinary image data
- [ ] code + notes + tests + data + work items
- [ ] package/binary/component/runtime artifacts as Project relationships/members
- [ ] Projects mixing image-native and OpenSmalltalkVM-backed code through explicit interfaces
- [ ] working-view and object/project-diff presentations over image history
- [ ] merge/conflict commands over generic lower-level revision primitives
- [ ] Git import/export as projection rather than canonical storage
- [ ] multi-author conflict and activity UX

Lower-level prerequisites stay in `lagrange-images`: revision-aware reads, logical revision/snapshot frontiers, version-aware mutation, and any generic diff/branch/merge primitive useful to non-UI clients.

Success: a Project is a durable organization of real image objects and artifacts, not a folder tree or shadow database.

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
- [ ] share object/project flow through trusted authorization APIs
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

These should remain experiments until the core Presentation -> Command -> Image loop is proven.
