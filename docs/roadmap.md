# Roadmap

The early roadmap is ordered to prove the architecture before investing in polish.

## Phase 0 — boundary and vocabulary

- [x] establish Image = workspace/world
- [x] establish Project vs Perspective vs Session responsibilities
- [x] establish `reference != authority` as an inherited security rule
- [x] establish environment as a public `lagrange-images` consumer
- [x] create headless Presentation, Command, Perspective and Session models
- [ ] decide the minimal image-side representation/protocol for durable Perspective objects
- [ ] identify the public image observation/change-feed seam needed by live presentations
- [ ] identify command invocation/transaction semantics without adding UI concerns to images

Success: the environment can represent its own semantic state without inventing storage, identity or authorization machinery.

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
- [ ] first Perspective load/save round trip as an image object

Success: manipulating an object through the environment demonstrably manipulates the image rather than a shadow UI model.

## Phase 2 — composition and first renderer

Use a browser renderer first unless experiments show a strong reason not to. Keep semantic layers renderer-independent.

- [ ] rendering adapter contract
- [ ] text/input/accessibility baseline
- [ ] compositor with nested split/stack/scroll primitives
- [ ] selection/focus model linked to semantic subjects
- [ ] command palette/context menu/key binding policy
- [ ] Perspective composition persisted independently of Session mechanics

Avoid implementing a full traditional window manager until real tools demonstrate why it is needed.

Success: inspector/browser tools can be arranged and restored through a Perspective without becoming applications.

## Phase 3 — generic live tools

- [ ] image/project browser
- [ ] object inspector/editor
- [ ] history browser
- [ ] search/query presentations
- [ ] evaluator/transcript
- [ ] process/activation/runtime views where exposed by images
- [ ] debugger built from semantic presentations and commands

Success: built-in development feels like inhabiting the image rather than using an external IDE.

## Phase 4 — language personality integration

Start with Symmetric Smalltalk because it is image-native and exposes the architectural pressure most directly.

- [ ] source and method presentations
- [ ] class/protocol browser
- [ ] senders/implementors
- [ ] evaluation and debugging commands
- [ ] language-contributed presentation/command registration
- [ ] prove a second language personality uses the same environment substrate

Success: adding another language extends the environment rather than adding another IDE architecture.

## Phase 5 — identity and collaboration UX

After image capability semantics and the live interaction loop are stable:

- [ ] principal/group picker backed by cluster identity APIs
- [ ] share object/project flow which creates image grants
- [ ] share/publish Perspective independently of referenced-object grants
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
