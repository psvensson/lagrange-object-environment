# ADR 0005: Identity is external; authority is transient and enforced below the environment

## Status

Accepted

## Context

The environment needs users, groups, sharing and invitations, but authentication and authority already belong below the UI. Reimplementing either here would create inconsistent security semantics.

`lagrange-images` ADR 0037 is stronger than a conventional object ACL model: authority is execution context, not program data. A ref identifies; it never grants. Root authority issuance/revocation is trusted host/control-plane work, while concrete image reads/writes/calls re-authorize at use time.

The original scaffold incorrectly summarized this as "Lagrange Images owns durable grants." There are deliberately no durable image grant objects.

## Decision

Authentication and principal/group identity belong to the cluster/control-plane identity layer.

Trusted authority-root APIs own issuance, revocation and policy. `lagrange-images` defines/enforces the per-call authority semantics used by image execution, including the check-only `require` seam and the invariant that authority never becomes a canonical Value or durable graph state.

The object environment owns sharing **intent, UX and orchestration** only. It may request an authority-policy change through a trusted API, but it does not mint authority or persist a UI-local ACL.

An ObjectRef, Project, Presentation, Command or Perspective never grants authority by its mere existence.

Current exact-match grants do not make Project relationships into a capability hierarchy. "Share this Project" therefore needs an explicit future authority contract below the environment.

## Consequences

External SSO, installation-local identity and future group providers can share one environment contract. Users can inhabit overlapping subsets of one image. References into inaccessible regions can remain opaque rather than leaking transitive access.

Project/Perspective models remain clean durable data because they do not need to embed principals, grants or authorization tokens.
