# ADR 0005: Identity is external; image authorization is authoritative

## Status

Accepted

## Context

The environment needs users, groups, sharing and invitations, but authentication and object authority already belong below the UI. Reimplementing either here would create inconsistent security semantics.

The image model also deliberately separates reference from authority. Partial sharing depends on preserving that distinction through the UI.

## Decision

Authentication and principal/group identity belong to the Lagrange cluster/control-plane identity layer. The object environment consumes authenticated principal identities and may resolve human-friendly profile/contact information for UX.

Lagrange Images owns durable object capability/grant semantics and performs authorization enforcement.

The environment owns sharing UX and orchestration only. A successful share operation results in an authorized image grant (and optionally a shared Perspective), not a UI-local ACL.

An ObjectRef, Presentation, Command or Perspective never grants authority by its mere existence.

## Consequences

External SSO, Keycloak-like providers and installation-local identity can share one environment contract. Users can inhabit overlapping subsets of one image. References into inaccessible regions can remain opaque rather than leaking transitive access.
