# ADR 0001: The image is the workspace

## Status

Accepted

## Context

Interactive environments often add a Workspace or Project container above the resources being edited. Lagrange Images is already a persistent object world containing code, data, history and arbitrary semantic objects. Adding a second persistent workspace would duplicate containment, persistence and sharing semantics.

The useful requirements behind a workspace still exist: users need private arrangements, subsets, purpose-specific views and partial sharing.

## Decision

The Image is the persistent workspace/world. The object environment will not introduce a second semantic Workspace container.

Use more specific concepts instead:

```text
organization/subset       -> Project or query/root object
persistent view/intention -> Perspective
current interaction       -> Session
access                     -> image capabilities/grants
```

A Perspective may be rooted at an Image, Project or arbitrary subject, but it does not own the subject graph.

## Consequences

There is one persistent ontology for the objects being worked on. Sharing part of an image does not require creating a smaller fake image/workspace. The UI can still support many simultaneous work arrangements through Perspectives.

If a later requirement appears to need Workspace, it must first demonstrate that it is not actually one of Project, Perspective, Session or authority.
