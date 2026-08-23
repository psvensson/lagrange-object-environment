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
  persistence, revisions and history
  code/artifact/language execution substrate
  transient per-call authority + authorization checks
        |
        v
Lagrange Object Environment
  Project conventions and collaborative-work semantics
  presentation discovery and semantic commands
  Perspectives and generic object tools
  compositor/layout policy and sharing UX
        |
        v
renderer adapters
  browser/DOM, canvas, native or future substrates
  text, graphics, pointer, keyboard, touch, accessibility
        |
        v
local Session state
```

Dependencies point downward. The environment consumes public image/control-plane contracts and must not become a backdoor around authorization.

`lagrange-images` does not need to know what a Project, Perspective, pane or window is in order to persist the ordinary objects that represent them.

## Layer ownership

### 1. Rendering and input substrate

Owns pixels, surfaces, text shaping, accessibility, keyboard/pointer/touch events, clipboard, animation and rendering caches.

It does **not** decide what image objects mean.

The first renderer may use browser technology. That is an implementation choice, not a commitment to browser/application semantics.

### 2. Composition

Owns arranging rendered presentations: split panes, scrolling, transforms, stacking, focus traversal and potentially spatial canvases.

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

Presentation discovery should eventually be extensible by environment packages and language personalities. A Smalltalk personality can add source/senders/implementors presentations without creating a separate Smalltalk IDE.

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

### 5. Project and collaborative-work semantics

Project is a higher-level organization convention over ordinary image objects and artifacts. It can relate code, notes, tests, data, work items, package/binary/component/runtime artifacts and other projects without turning those relationships into a new storage model.

The split with Lagrange Images is:

```text
Lagrange Images
  identity / refs / history / pinned revisions
  atomic version-aware mutation
  future generic revision/diff/branch primitives

Object Environment
  Project meaning and navigation
  working-view and history presentations
  merge/conflict interaction
  Git import/export as a projection
  multi-author collaboration UX
```

If a branch/merge primitive is useful for arbitrary image clients, it belongs below this repository. How a human sees and resolves that history belongs here.

### 6. Generic tools

Inspectors, browsers, evaluators, debuggers, search, history views, graph browsers and process/runtime tools should be generic compositions of presentations and commands where possible.

They are not privileged applications. Domain-specific tools should use the same mechanisms.

### 7. Language personalities

Language support supplies presentations and commands for language-owned image structures. Examples include source/AST/bytecode presentations, senders/implementors, macro expansion or language-specific debugging views.

Language semantics and compiler/runtime adapters stay in their lower language personality; the environment owns editing/presentation/interaction integrations over those semantics.

### 8. Perspective

A Perspective is durable UI intention and arrangement. It says what part of the image matters and how a set of presentations should be composed.

It does not contain the image objects as owned resources. Its subjects are references into the image world.

A Perspective may itself be persisted as ordinary image objects. Its existence or visibility grants no authority to anything it references.

### 9. Session

Session state is ephemeral and client-local by default. Hover, open menus, active drag, caret blink, pointer position and rendering caches should not produce durable image history.

A deliberate user action can promote useful state into a Perspective; ordinary UI mechanics should not.

## Image is the workspace

There is no semantic `Workspace` layer between Image and Perspective.

```text
Image
  persistent world/workspace
  |
  +-- arbitrary domain/program objects
  +-- ordinary objects representing Projects
  +-- ordinary objects representing Perspectives
  `-- durable history/revisions

Project
  environment-defined semantic organization in the Image

Perspective
  durable way to inhabit some of that world

Session
  current transient interaction
```

The absence of Workspace is architectural, not merely a naming decision. If future requirements appear to need one, first determine whether they are actually about organization (Project), view state (Perspective), authorization (lower authority layer) or transience (Session).

## Authority boundary

The environment does not own grants and should not persist authorization tokens in a Project, Perspective or Session.

`lagrange-images` ADR 0037 makes authority execution context rather than program data. A trusted host/control plane issues and revokes root authority; image execution receives only a checkable per-call context and enforces concrete operations. The environment drives user-facing sharing intent through those lower APIs.

This matters because current v0 authority is exact-match. There is no implied rule that "read Project A" recursively authorizes every object reachable from A. Project-wide sharing needs an explicit future authority contract rather than UI convention masquerading as security semantics.

## Non-goals for the first phase

- choosing a final visual language
- choosing a final windowing model
- building an application framework
- duplicating image storage or history
- defining a second authorization/grant model
- remote eval as a generic UI escape hatch
- teaching `lagrange-images` about Projects, Perspectives, buttons, panes, windows or pixels
