# Architecture

## Purpose

Lagrange Object Environment is the interactive human layer above Lagrange Images. It should make a persistent object world directly inhabitable without introducing an application/file/workspace ontology on top of it.

The environment should be able to grow into an inspector, browser, editor, debugger, notebook, dashboard, diagramming surface and collaborative world without each becoming a separate application architecture.

## Dependency direction

```text
cluster / identity provider
        |
        v
Lagrange
  principal authentication, groups, cluster/session concerns
        |
        v
Lagrange Images
  object/value/reference model
  persistence and history
  code/artifact/language model
  capabilities and authorization enforcement
        |
        v
Lagrange Object Environment
  presentation discovery
  semantic commands
  perspectives
  generic object tools
  compositor/layout policy
        |
        v
renderer adapters
  browser/DOM, canvas, native or future substrates
  text, graphics, pointer, keyboard, touch, accessibility
        |
        v
local Session state
```

Dependencies point downward. The environment consumes public image contracts and must not become a backdoor around image authorization.

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
        -> authorized image operation
```

This is preferred over arbitrary widget callbacks because the same command can support menus, keyboard invocation, scripting, command palettes, undo/history integration and collaboration.

Command applicability is not authorization. The image remains authoritative at invocation time.

### 5. Generic tools

Inspectors, browsers, evaluators, debuggers, search, history views, graph browsers and process/runtime tools should be generic compositions of presentations and commands where possible.

They are not privileged applications. Domain-specific tools should use the same mechanisms.

### 6. Language personalities

Language support supplies presentations and commands for language-owned image structures. Examples include source/AST/bytecode presentations, senders/implementors, macro expansion or language-specific debugging views.

The environment should therefore host several languages without becoming a collection of unrelated IDEs.

### 7. Perspective

A Perspective is durable UI intention and arrangement. It says what part of the image matters and how a set of presentations should be composed.

It does not contain the image objects as owned resources. Its subjects are references into the image world.

Because a Perspective can itself be represented as an image object, the ordinary image authorization model can make it private, shared or writable by a group.

### 8. Session

Session state is ephemeral and client-local by default. Hover, open menus, active drag, caret blink, pointer position and rendering caches should not produce durable image history.

A deliberate user action can promote useful state into a Perspective; ordinary UI mechanics should not.

## Image is the workspace

There is no semantic `Workspace` layer between Image and Perspective.

```text
Image
  persistent world/workspace
  |
  +-- Projects and arbitrary objects
  +-- code, notes, tasks and data
  +-- shared/private Perspective objects
  `-- history and grants

Perspective
  durable way to inhabit some of that world

Session
  current transient interaction
```

The absence of Workspace is architectural, not merely a naming decision. If future requirements appear to need one, first determine whether they are actually about organization (Project), view state (Perspective), access (capabilities) or transience (Session).

## Non-goals for the first phase

- choosing a final visual language
- choosing a final windowing model
- building an application framework
- duplicating image storage or history
- duplicating principal/capability semantics
- remote eval as a generic UI escape hatch
- teaching `lagrange-images` about buttons, panes, windows or pixels
