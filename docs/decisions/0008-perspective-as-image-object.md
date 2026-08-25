# ADR 0008: A Perspective is an ordinary image object of one well-known Shape

## Status

**Amended** — the *representation* half of this ADR is superseded by [ADR 0012](0012-perspective-as-object-graph.md). ADR 0008's boundary and ownership decisions stand unchanged: the `ImageClientAdapter` owns the projection, the projection is pure/renderer-independent, and no authority is persisted.

The single-object representation chosen here proved unimplementable through any authorized image lane (nested values and writable metadata are excluded by decided substrate invariants). ADR 0012 records the child-object-graph representation that replaced it. This document is retained for the decision history.

## Context

ADR 0003 made Perspective durable intention and ADR 0006 kept the durable store in Lagrange Images. What was still undecided was the concrete representation: how an in-memory `Perspective` becomes durable image data and back, and who owns that mapping.

Lagrange Images ADR 0058 already fixes the boundary: Perspectives belong entirely to this repository and must be persisted as *ordinary image objects as a semantic convention, not a storage primitive*. Two image-level facts then constrain the design:

- Object and Shape `metadata` is JSON-only and **rejects references** (`normalizeMetadata` throws on any ref; graph edges are required to live in slots).
- The only graph-edge Value is a `ref`/`pinned-ref` naming an `imageId` + `objectId` (+ optional revision). A ref is data; per ADR 0005 and the architecture's authority boundary, carrying a ref confers no authority.

So the representation cannot be invented freely: anything that must point at another image object must be a slot holding a ref, and everything else must be JSON metadata.

## Decision

A durable Perspective is one ordinary image Object of a single well-known **Shape**, projected and reconstructed by the `ImageClientAdapter` (the owner of the Perspective ↔ durable-image interaction). The projection is a pure, renderer-independent encode/decode pair with no dependency on a running image.

### Shape

The Shape has a stable, environment-namespaced id (the contract the adapter writes and reads) and these slots:

- `subject` — the Perspective's root subject, as a ref Value.
- `presentations` — an ordered list of presentation records, encoded as data (see below).

All other durable intention lives in the Object's JSON `metadata`:

- `title` — optional human title.
- `layout` — an opaque JSON layout descriptor owned by the compositor policy.
- `formatVersion` — an integer marking this representation, starting at `1`.

### Encoding rules

1. **Edges are slots; scalars are metadata.** Any value that references an image object is encoded as a ref Value in a slot, never in metadata. Scalar/structural intention is JSON in metadata. This is enforced by the image layer, not merely preferred.
2. **The subject must be a ref.** A Perspective's durable subject has to name a durable image identity. Encoding a non-ref subject throws rather than silently dropping it. This matches the current in-memory `Perspective`, which requires a subject; an "unbound" Perspective is a possible future *model* change, not something the projection may invent.
3. **Presentations are data, not behavior.** Each presentation is encoded as `{id, kind, subject, context, state}` where `subject` is a ref Value and `context`/`state` are JSON. Presentation identity and kind are environment strings; the projection never stores renderer objects, callbacks or sessions.
4. **Unpinned refs by default; pinned refs preserved.** A live Perspective follows its subjects, so refs are unpinned. A deliberately pinned ref (a revision bookmark) is preserved unchanged so the pinned/unpinned distinction survives a round trip.
5. **Layout is opaque to the projection.** The compositor owns the layout schema; the projection stores it as JSON metadata so layout can evolve without a Shape migration.
6. **No authority is persisted.** The encoded object contains only refs and JSON. Decoding produces a `Perspective`; it does not produce any grant, token or authorization context.

### Versioning

`formatVersion` is the single migration seam. Readers reject an object whose `formatVersion` they do not understand rather than guessing. Shape evolution (new slots) is a separate, deliberate change because existing objects are validated against their Shape on write.

## Consequences

- The `ImageClientAdapter` is the single owner of this projection; nothing else in the environment decides how a Perspective is stored.
- The projection can be fully tested without a live image: round-trip, ref-vs-authority, no-session-leak and pinned/unpinned distinction are all provable against the pure encode/decode pair.
- Keeping `formatVersion` explicit lets a later, incompatible representation coexist with old objects instead of corrupting them.
- Because metadata cannot hold refs, any future need for additional edges (e.g. bookmarks) means new slots, which is a visible Shape change rather than hidden metadata drift.

## Alternatives considered

- **Store the whole Perspective as one JSON blob in a single slot/metadata.** Rejected: it hides edges from the image graph, defeats ref-aware tooling/observation, and fights the image layer's slot-vs-metadata rule.
- **Give each Presentation its own image object.** Rejected for the minimal representation: it multiplies objects and history churn for no proven need; presentations-as-data inside the Perspective keeps one durable unit. Can be revisited if shared/reusable presentations become a real requirement.
- **Encode subjects as plain strings.** Rejected: a string is not a graph edge; the image layer could not observe or traverse it, and it would blur the ref/authority distinction this ADR depends on.
