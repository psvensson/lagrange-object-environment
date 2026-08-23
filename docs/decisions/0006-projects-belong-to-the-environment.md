# ADR 0006: Projects and graphical work belong to the Object Environment

## Status

Accepted

## Context

Before this repository existed, the `lagrange-images` roadmap carried two higher-level areas:

- Projects and collaborative history
- Graphical environment

That was useful while there was no other home for them, but it blurred the responsibility of the image substrate. A Project is not needed to define Value, ObjectRef, Shape, CodeArtifact, Block, history or execution. Windows, inspectors and widgets are even more clearly above that line.

At the same time, some collaboration primitives are genuinely substrate concerns: stable revisions, pinned refs, version-aware mutation and future generic diff/branch/merge operations can be useful to any image client.

## Decision

The Object Environment owns:

- Project as a semantic organization convention represented by ordinary image objects/refs
- code/notes/tests/data/work-item organization
- relationships to package/binary/component/runtime artifacts
- working-view/history/diff/merge presentation and interaction
- Git import/export as a user/tooling projection
- multi-author collaboration UX
- drawing/input/rendering adapters
- presentation composition, surfaces/world policies
- inspectors, browsers, debugger and other human-facing tools

Lagrange Images owns only the generic lower primitives these features consume:

- stable object/artifact identity and refs
- durable history and revisions
- pinned historical refs / revision-aware reads
- version-aware atomic mutation and conflict signaling
- generic graph traversal/export/import
- generic revision/diff/branch/merge primitives if pressure proves they are useful independent of this environment
- language/artifact/execution semantics
- transient per-call authority enforcement

A Project does not become a new core image record kind. Its durable instances live *in* an image as ordinary objects; the convention defining what those objects mean lives here.

## Consequences

`lagrange-images` can become narrower and more reusable. A headless server, alternate UI or automation client can use the image substrate without inheriting this project's product/UI concepts.

This repository, conversely, can evolve Project, Perspective and graphical semantics rapidly without forcing substrate ADRs for every UX experiment.

When this project discovers a missing generic primitive, it should propose that primitive downward through the public `lagrange-images` boundary rather than reach into internals.
