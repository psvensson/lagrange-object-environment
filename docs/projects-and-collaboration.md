# Projects and collaborative work

The audit of `lagrange-images` found a mixed responsibility rather than something to move wholesale.

**Project itself stays image-level. Project interaction moves here.**

That distinction matters because a Project should remain useful to headless agents, import/export tools, language services and alternate frontends, while browsing, diffing, merging and collaborating are ways humans inhabit that Project.

## Image-level Project model

Lagrange Images should define a language-neutral Project convention represented by ordinary image objects and refs. It does not need a special backend table or record kind.

A Project may relate:

- source and semantic code
- notes and documentation
- tests
- arbitrary data
- work items / quests / investigations
- package manifests and locks
- imported binary/JAR/component/WASM artifacts
- runtime definitions and interfaces
- other Projects

Relationships need not be single-parent or exclusive. One object can matter to several Projects without being copied.

This semantic model belongs below the Object Environment.

## What this repository owns

The Object Environment owns human interaction over Projects:

- Project browsers and navigation
- creation/editing commands using public Project APIs
- history and working-view presentations
- object/Project diff views
- merge/conflict explanation and resolution interaction
- Git import/export commands and progress UX
- multi-author activity views
- sharing/invitation flows
- Project-specific Perspectives

Those should not create a shadow Project/history model.

## Files and Git are projections

The underlying file/Git projection service can be image-level or another headless tooling package; the UI for driving it belongs here.

```text
image Project + history
        |
        +-> source/file projection
        +-> Git import/export
        +-> package-manager projection
        `-> environment-native history/diff views
```

A Git projection should preserve enough provenance to round-trip usefully without making a pathname or commit hash the object's fundamental identity.

## History ownership

Lagrange Images owns generic durable history and Project-versioning semantics:

- stable object identity independent of revision
- version-aware atomic mutation
- pinned historical refs
- revision/history storage
- revision-aware reads and logical snapshot/frontier primitives
- branch/working-view semantics when standardized
- generic diff/merge/conflict data

The Object Environment owns the human model built on those primitives:

- history browsers
- working-view presentations
- object/project diff presentations
- merge commands and conflict-resolution UX
- multi-author activity views

The environment should not implement a shadow revision database merely to get a branch UI. If it needs a generic primitive, that pressure should go down through a public `lagrange-images` API.

## Mixed-language projects

The image-level Project model can relate image-native and foreign/runtime-backed code without pretending they share a physical heap:

```text
Project
  +-> Symmetric Smalltalk classes/methods
  +-> imported Cuis package/class/method structures
  +-> Rust source + Cargo artifacts
  +-> callable Component/WASM interfaces
  `-> notes/tests/data/work items
```

The Object Environment makes those relationships directly navigable and editable without redefining them.

## Collaboration

Collaboration has three different kinds of state:

```text
durable program/Project state     -> Image / Project
shared durable view intention     -> Perspective objects
live interaction/presence         -> Session/presence service by default
```

Do not persist pointer motion, cursors or presence heartbeats merely because the image is durable. Promote only deliberate collaborative artifacts into the image.

## Project does not define authority

Project membership and access rights are separate.

Current `lagrange-images` authority is exact-match and object access never follows refs transitively. Therefore:

```text
Project A -> Object X
```

does **not** mean authority for Project A automatically authorizes Object X.

A future Project sharing flow needs an explicit lower authority contract. Plausible directions include an authority resource-set/group abstraction, control-plane expansion to concrete grants, or another capability algebra proven against real Project operations. That decision belongs below the UI.

The environment owns the user's intent — "share this Project with Anna" — and presents the consequences. It does not get to redefine what that means cryptographically or operationally.
