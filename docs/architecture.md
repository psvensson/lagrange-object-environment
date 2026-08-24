# Architecture

## Purpose

Lagrange Object Environment is the interactive human layer above Lagrange Images. It should make a persistent object world directly inhabitable without introducing an application/file/workspace ontology on top of it.

The environment should be able to grow into an inspector, browser, editor, debugger, notebook, dashboard, diagramming surface and collaborative world without each becoming a separate application architecture.

## Dependency direction

```text
trusted control plane / identity provider
  authentication, principals/groups
  root authority issuance/revocation/policy
        |
        v
Lagrange
  distributed substrate and cluster/session concerns
        |
        v
Lagrange Images
  object/value/reference model
  Project/history/artifact/language semantics
  persistence, revisions and execution
  transient per-call authority + authorization checks
        |
        v
Lagrange Object Environment
  presentation discovery and semantic commands
  Project/history/collaboration interaction
  Perspectives and generic object tools
  compositor/layout policy and sharing UX
        |
        v
renderer adapters
  browser/DOM, canvas, native or future substrates
  text, graphics, pointer, keyboard, touch, accessibility
  concrete GPU/surface resources + versioned Component graphics hosts
        |
        v
local Session state
```

Dependencies point downward. The environment consumes public image/control-plane contracts and must not become a backdoor around authorization.

The split is semantic rather than based on durability: Lagrange Images can define a Project model using ordinary image objects; this repository defines how a person sees, edits, compares, shares and collaborates around those Projects.

## Layer ownership

### 1. Rendering and input substrate

Owns pixels, surfaces, text shaping, accessibility, keyboard/pointer/touch events, clipboard, animation and rendering caches.

Renderer adapters also own concrete browser/native graphics resources such as GPU adapters/devices/queues, surfaces and frames. For Component-backed presentations they may implement exact-version WIT graphics interfaces, with `wasi:webgpu` as the preferred low-level direction and `wasi-gfx`-style surface interfaces above it. Those interfaces are replaceable/versioned adapter contracts, not environment ontology.

Concrete GPU/surface handles are Session/runtime machinery. They are not image refs and must not become durable Perspective state.

It does **not** decide what image objects mean.

The first renderer may use browser technology. That is an implementation choice, not a commitment to browser/application semantics.

### 2. Composition

Owns arranging rendered presentations: split panes, scrolling, transforms, stacking, focus traversal and potentially spatial canvases.

The Compositor owns logical arrangement, visibility, size/transform, focus and view lifetime. It requests concrete surfaces from the RendererAdapter; it does not implement WebGPU, WIT or native GPU lifecycle itself.

A `Window` is not a fundamental semantic object. Traditional overlapping windows, tiling, notebook flow and an infinite canvas should be possible composition policies over the same presentation model.

### 3. Presentations

A Presentation binds a semantic subject to one way of showing it in context.

```text
subject + context -> presentation -> renderer view
```

Examples for one service object:

```text
ServiceRef
  -> compact list row
  -> ordinary object inspector
  -> source/code presentation
  -> running topology
  -> logs presentation
  -> purpose-built operations control
```

All are views of the same underlying subject. Presentation identity must not replace image object identity.

A graphical presentation may be backed by an ordinary WebAssembly Component. That does not create an application boundary or a separate 3D object model:

```text
semantic subject
      |
      v
Presentation
      |
      v
renderer Component
  imports exact versioned graphics/surface interfaces
      |
      v
RendererAdapter
  supplies runtime-local host resources/providers
      |
      v
browser WebGPU or native GPU backend
```

2D and 3D use the same presentation boundary. Scene graphs, plotting APIs, CAD geometry, physics and game-engine facilities are optional libraries/components above it rather than kernel concepts.

Presentation discovery should eventually be extensible by environment packages and language personalities. A Smalltalk personality can expose semantic/source services that this environment turns into source/senders/implementors presentations without creating a separate Smalltalk IDE.

### 4. Commands

A command is an inspectable operation over semantic subjects.

```text
gesture / key / menu / script
        -> subject selection
        -> applicable command
        -> authorized lower-level operation
```

This is preferred over arbitrary widget callbacks because the same command can support menus, keyboard invocation, scripting, command palettes, undo/history integration and collaboration.

Command applicability is not authorization. Every protected read/write/invocation is authorized below the environment at use time.

High-rate presentation-local input may remain Session state. For example, dragging to rotate a 3D camera need not mutate the image. When input means a semantic operation—delete this object, change this property, invoke this method—it returns to the ordinary Command path. A Component renderer is never a hidden image-mutation channel.

### 5. Project and collaborative-work interaction

The durable Project model belongs below this repository in Lagrange Images: relationships among code, notes, tests, data, work items, package/binary/component/runtime artifacts and other Projects should remain useful to headless clients and agents.

The Object Environment owns the human interaction over that model:

```text
Lagrange Images
  Project objects / relationships / namespaces
  history / revisions / working-frontier semantics
  generic diff / merge / conflict data
  Git/file projection services where headless use matters

Object Environment
  Project browser and navigation
  working-view and history presentations
  diff / merge / conflict interaction
  Git projection commands and UX
  multi-author activity and collaboration UX
```

If a semantic primitive is useful without this UI, it belongs below this repository. How a human sees and manipulates it belongs here.

### 6. Generic tools

Inspectors, browsers, evaluators, debuggers, search, history views, graph browsers and process/runtime tools should be generic compositions of presentations and commands where possible.

They are not privileged applications. Domain-specific tools should use the same mechanisms.

### 7. Language personalities

Language semantics, source structures, lookup/compiler/runtime adapters and debugging metadata stay in Lagrange Images language personalities. This environment supplies presentations and commands over those public semantic structures.

The environment should therefore host several languages without becoming a collection of unrelated IDEs.

### 8. Perspective

A Perspective is durable UI intention and arrangement. It says what part of the image matters and how a set of presentations should be composed.

It does not contain the image objects as owned resources. Its subjects are references into the image world.

A Perspective may deliberately retain useful presentation intention such as the chosen presentation kind, layout, camera pose or visualization parameters. It never retains native/window/GPU handles; a restored Session recreates those through the Compositor and RendererAdapter.

A Perspective may itself be persisted as ordinary image objects. Its existence or visibility grants no authority to anything it references.

### 9. Session

Session state is ephemeral and client-local by default. Hover, open menus, active drag, caret blink, pointer position, GPU/device/surface resources and rendering caches should not produce durable image history.

A deliberate user action can promote useful state into a Perspective; ordinary UI mechanics should not.

## Image is the workspace

There is no semantic `Workspace` layer between Image and Perspective.

```text
Image
  persistent world/workspace
  |
  +-- domain/program objects
  +-- image-level Projects
  +-- ordinary objects representing Perspectives
  `-- durable history/revisions

Project
  durable semantic organization within the Image

Perspective
  durable way to inhabit some of that world

Session
  current transient interaction
```

The absence of Workspace is architectural, not merely a naming decision. If future requirements appear to need one, first determine whether they are actually about organization (Project), view state (Perspective), authorization (lower authority layer) or transience (Session).

## Authority boundary

The environment does not own grants and should not persist authorization tokens in a Project, Perspective or Session.

`lagrange-images` ADR 0037 makes authority execution context rather than program data. A trusted host/control plane issues and revokes root authority; image execution receives only a checkable per-call context and enforces concrete operations. The environment drives user-facing sharing intent through those lower APIs.

Graphics authority is independent from image authority. A renderer Component may be permitted to use a GPU/surface without thereby gaining permission to read or mutate its semantic subject. Protected semantic reads and mutations still cross the normal authorized image APIs.

Current v0 authority is exact-match. There is no implied rule that "read Project A" recursively authorizes every object in A. Project-wide sharing needs an explicit future authority contract rather than UI convention masquerading as security semantics.

## Non-goals for the first phase

- choosing a final visual language
- choosing a final windowing model
- choosing one scene graph or 3D engine for all presentations
- inventing a Lagrange GPU ABI before concrete ecosystem pressure requires one
- building an application framework
- duplicating Project, image storage or history semantics
- defining a second authorization/grant model
- remote eval as a generic UI escape hatch
- teaching `lagrange-images` about Perspectives, presentations, panes, windows or pixels
