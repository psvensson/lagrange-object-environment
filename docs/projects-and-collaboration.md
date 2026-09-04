# Projects and collaborative work

The audit of `lagrange-images` found a mixed responsibility rather than something to move wholesale.

**Project itself stays image-level. Project interaction moves here.**

That distinction matters because a Project should remain useful to headless agents, import/export tools, language services and alternate frontends, while browsing, diffing, merging and collaborating are ways humans inhabit that Project.

## Image-level Project model

Lagrange Images defines the language-neutral durable Project convention using ordinary image objects and refs, not a special backend table or environment-owned record kind. Its authorized Project read returns the canonical descriptor `{format, projectId, name, namespace, members:[{key, role, target}]}`; Images alone owns storage translation, canonical key ordering and authorization-before-existence.

A Project may relate:

- source and semantic code
- notes and documentation
- tests
- arbitrary data
- work items / quests / investigations
- package manifests and locks
- imported binary/JAR/component/WASM artifacts
- language import/provenance artifacts
- native-imported classes, methods and application roots
- explicit runtime definitions and interfaces that deliberately remain foreign
- other Projects

Relationships need not be single-parent or exclusive. One object can matter to several Projects without being copied.

This semantic model belongs below the Object Environment.

## What this repository owns

The Object Environment owns human interaction over Projects:

- Project browsers and navigation
- creation/editing commands using public Project APIs
- language/application import commands, progress and diagnostics over public Images import APIs
- presentation of source/provenance and unsupported-import diagnostics
- history and working-view presentations
- object/Project diff views
- merge/conflict explanation and resolution interaction
- Git import/export commands and progress UX
- multi-author activity views
- sharing/invitation flows
- Project-specific Perspectives

Those must not create a shadow Project/history/import model.

## Current read-only browser

The first vertical slice is implemented by `ProjectBrowser` and the existing generic environment owners:

```text
Project subject {imageId, projectId}
  -> ImageClientAdapter.readProject (explicit Project authority)
  -> canonical Images ProjectDescriptor
  -> exact-one Project Presentation
  -> SemanticUi Project view (DOM and GTK)
  -> activate descriptor-local member index
  -> EnvironmentShell resolves current member target
  -> ObjectNavigator reads that target under separate explicit authority
```

The Presentation retains the canonical descriptor by identity; it does not copy or normalize membership. The durable member key remains member identity when a target is changed, while the renderer sees only a transient integer action key. Observation events are metadata-only invalidations: the browser performs a fresh authorized Project read before presenting an update. This slice is deliberately read-only—there are no Project mutation Commands yet.

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

## Mixed-language projects and native import

ADR 0085 in `lagrange-images` makes progressive native import the primary convergence path. Language origin and execution representation are therefore deliberately separate.

A Project may contain both the inputs/provenance of an imported ecosystem and the native image structures produced from them:

```text
Project
  +-> Cuis source/package/provenance artifacts
  +-> native-imported Smalltalk classes/methods/application roots
  +-> Rust source + Cargo artifacts
  +-> callable Component/WASM interfaces
  +-> explicit foreign runtime/service boundaries, where deliberately retained
  `-> notes/tests/data/work items
```

After successful native import, a Cuis-origin class, method or application object is an ordinary Images-native semantic object. The Object Environment navigates and edits it through the same public Images APIs used for other native objects. It may present origin/provenance such as "imported from Cuis", but that provenance must not select a second identity, storage or mutation path.

In particular, the environment must not preserve a shadow `CuisExportClass`/Spur-object world as the editable application model once Images has produced the native class/object. Behaviorless semantic-export objects may still be inspected as import/provenance artifacts when useful.

OpenSmalltalkVM remains Images-owned importer/oracle/explicit foreign-service machinery. The environment may expose commands and diagnostics around those operations, but it does not decide whether unsupported native semantics silently fall back to the VM; ADR 0085 forbids that fallback.

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
