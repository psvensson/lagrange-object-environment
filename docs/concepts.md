# Core concepts

## Image

The Image is the persistent computational world and therefore the workspace.

The environment does not own image storage or image identity. It observes and invokes objects through public Lagrange Images contracts.

## Project

A Project is semantic organization inside an image: a useful root or relationship structure for code, notes, tasks, data, artifacts and other projects.

Project is an **object-environment concept represented using ordinary image objects**, not a new durable record kind in `lagrange-images`.

Projects should not recreate filesystem assumptions. An object may participate in several projects or relationships, and project composition need not imply exclusive ownership. Language personalities may contribute package/project adapters, but the generic image substrate does not need to understand their meaning.

A useful test is: if a feature only needs stable refs, ordinary objects, artifacts and history to represent a Project, it belongs here. If it needs a new generic revision/reference/storage primitive useful without Project semantics, that primitive belongs in `lagrange-images`.

## Presentation

A Presentation answers: **how should this subject appear in this context?**

It carries enough semantic identity that selecting or invoking on the rendered result can recover the subject rather than merely a string or pixel region.

A subject may have many simultaneous presentations. Presentation state should be split carefully between durable intention and transient rendering state.

A presentation is neither the object nor an authority token.

## Command

A Command answers: **what operation can be attempted on this semantic subject?**

Commands are first-class environment objects so invocation can be decoupled from individual widgets.

Useful properties to explore later include:

- stable command identity
- applicability predicates
- arguments and argument presentations
- result presentations
- undo/compensation metadata where the underlying operation supports it
- discoverability/menu grouping
- key/gesture bindings as separate policy
- command composition/macros

Authorization is deliberately not on this list. A command may be visible/applicable while the protected operation is denied below the environment.

## Perspective

A Perspective answers: **what am I working with, and how do I want to see it?**

Typical durable contents may include:

- a subject/root or query
- chosen presentations
- composition/layout
- pinned/bookmarked objects
- semantic selections worth preserving
- tool configuration which expresses user intention

A Perspective should avoid storing incidental client mechanics.

Perspectives can support several modes without changing the object model:

```text
personal development perspective
shared incident perspective
published dashboard
language-learning perspective
operations perspective
notebook-like investigation
spatial/diagram perspective
```

A Perspective can be persisted as ordinary image data, but neither the Perspective nor its refs confer authority.

## Session

A Session answers: **what is happening in this client right now?**

Examples:

- pointer/hover target
- open popup/menu
- caret and IME state
- drag operation
- animation progress
- local scroll inertia
- renderer cache
- temporary focus

Sessions may know the authenticated user-facing principal and active Perspective, but they should not turn a lower-level authority context into storable program data.

## Compositor

The Compositor arranges presentations. It should be less opinionated than a conventional window manager.

Possible policies include overlapping windows, tiling, nested panes, documents, notebooks, spatial canvases and focused single-view modes. They should compose the same semantic presentations rather than require different application APIs.

## Tools are compositions, not applications

An inspector can be a Presentation plus Commands. A code browser can compose several presentations over class/method objects. A debugger can present activation/process objects and attach commands to them.

The architectural test is whether a domain-specific tool can be built using the same public mechanisms as the built-in inspector. If built-in tools require privileged internal paths, the model is probably incomplete.
