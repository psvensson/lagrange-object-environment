# ADR 0006: Project semantics stay image-level; Project interaction and graphical work belong here

## Status

Accepted

## Context

Before this repository existed, the `lagrange-images` roadmap carried both Project/collaboration work and graphical-environment work.

The graphical work is clearly higher-level, but the Project section is mixed. A language-neutral Project model is valuable to headless agents, import/export tools, language services and alternate frontends. Moving Project semantics into a UI repository would force those clients to depend on the UI layer or invent competing Project models.

At the same time, Project browsers, working views, diff/merge interaction and collaboration UX clearly belong here.

## Decision

The durable **Project model stays in Lagrange Images**, implemented as an image-level convention/library over ordinary image objects and refs rather than a new storage/backend primitive.

Lagrange Images owns:

- Project identity/relationships/namespaces
- code/notes/tests/data/work-item organization
- relationships to package/binary/component/runtime artifacts
- generic Project history/working-frontier/diff/merge/conflict semantics
- headless file/Git projection services where standardized

The Object Environment owns:

- Project browsing/navigation/presentation
- interactive creation/editing commands
- working-view/history/diff presentations
- merge/conflict-resolution interaction
- Git/file projection UX
- multi-author activity/collaboration UX
- the graphical environment: rendering, presentations, composition, tools and Perspectives

Perspective remains an Object Environment concept even when persisted as ordinary image objects.

## Consequences

Headless clients and alternate frontends share one Project model without taking a dependency on this UI repository.

The environment can evolve its Project interaction rapidly without changing Project identity or history semantics.

When this project discovers a missing semantic primitive, it should propose that primitive downward through the public `lagrange-images` boundary rather than implement a shadow Project/history store.
