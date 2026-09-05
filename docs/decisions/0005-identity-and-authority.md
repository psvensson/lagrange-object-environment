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

### Amendment (2026-09-05, Bead eij.1, with Images ADR 0087): following a locator is a fresh authorization

The rule above says what a ref is *not*. Consuming Images' semantic description seams needs the matching rule for how the environment *reads*, because a description legitimately reports relationships:

> A semantic description may expose relationships owned by its subject. Following an independently authoritative target requires that target's own image authorization.

Concretely, an authorized native class description reports its superclass and class-side refs, and the class's own selector names, under ONE `object/read` on the class object — because a class's own method dictionary is that class's storage representation, sitting at an id derived from it, and is not an independently addressable semantic object. The superclass, the metaclass and the Block behind a selector ARE independently addressable, so each needs its own grant, and the environment obtains one by making a NEW authorized read, not by reusing the read that disclosed the ref.

Two consequences bind the consumer, not just the substrate:

- **Never fetch the graph recursively and filter afterward.** Prefetching a superclass chain "for the browser" and hiding the parts the caller may not see performs reads the caller was not authorized to make, and turns an authority boundary into a display filter. Read exactly what was asked for; follow a locator only when a caller acts on it, under the authority they supply then.
- **A description's own reach is the subject's, not the graph's.** Where the substrate deliberately declines to answer — an inverse edge it does not store, a provenance association it does not own — the environment reports that absence truthfully instead of deriving the answer from an id spelling or retaining a shadow source of its own.

This is a specialization of "a ref never grants authority", not a new principle: it says what the environment must *do* about it when it consumes a semantic read.

## Consequences

External SSO, installation-local identity and future group providers can share one environment contract. Users can inhabit overlapping subsets of one image. References into inaccessible regions can remain opaque rather than leaking transitive access.

Project/Perspective models remain clean durable data because they do not need to embed principals, grants or authorization tokens.
