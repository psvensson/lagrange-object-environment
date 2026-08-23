# Projects and collaborative work

This material used to sit partly in the `lagrange-images` roadmap. It belongs here because Project is how humans organize work in an image, while `lagrange-images` should stay a language-neutral graph/execution substrate.

## Project is an image-resident convention

A Project is represented by ordinary image objects and refs. It does not require a special backend table, record kind or filesystem tree.

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

## Files and Git are projections

Files and Git remain valuable interoperability surfaces, but they need not become canonical identity.

```text
image objects + history
        |
        +-> source/file projection
        +-> Git import/export
        +-> package-manager projection
        `-> environment-native history/diff views
```

A Git projection should preserve enough provenance to round-trip usefully without teaching the image graph that a pathname or commit hash is the object's fundamental identity.

## History ownership

Lagrange Images owns generic durable history semantics:

- stable object identity independent of revision
- version-aware atomic mutation
- pinned historical refs
- revision/history storage
- future revision-aware reads and logical snapshot/frontier primitives
- future generic diff/branch/merge primitives when they are useful outside this UI

The Object Environment owns the human model built on those primitives:

- history browsers
- working views
- object/project diffs
- merge presentations and commands
- conflict explanation/resolution
- multi-author activity views
- Git import/export UX

The environment should not implement a shadow revision database merely to get a branch UI. If it needs a generic branch primitive, that pressure should go down through a public `lagrange-images` API.

## Mixed-language projects

A Project can relate image-native and foreign/runtime-backed code without pretending they share a physical heap:

```text
Project
  +-> Symmetric Smalltalk classes/methods
  +-> imported Cuis package/class/method structures
  +-> Rust source + Cargo artifacts
  +-> callable Component/WASM interfaces
  `-> notes/tests/data/work items
```

`lagrange-images` supplies the artifact and interface graph. The environment supplies the Project relationship semantics and the tools for navigating them.

## Collaboration

Collaboration has three different kinds of state:

```text
durable program/work state       -> Image
shared durable view intention    -> Perspective objects
live interaction/presence        -> Session/presence service by default
```

Do not persist pointer motion, cursors or presence heartbeats merely because the image is durable. Promote only deliberate collaborative artifacts into the image.

## Project does not define authority

Project membership and access rights are separate.

Current `lagrange-images` authority is exact-match and object access never follows refs transitively. Therefore:

```text
Project A -> Object X
```

does **not** mean authority for Project A automatically authorizes Object X.

A future Project sharing flow needs an explicit lower authority contract. Plausible directions include an authority resource-set/group abstraction, a control-plane-maintained expansion to concrete grants, or another capability algebra proven against real Project operations. That decision should be made in the authority layer, not smuggled into Project traversal.

The environment owns the user's intent — "share this Project with Anna" — and presents the consequences. It does not get to redefine what that means cryptographically or operationally.
