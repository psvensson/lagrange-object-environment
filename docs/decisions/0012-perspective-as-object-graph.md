# ADR 0012: A Perspective is a small object graph — a Perspective plus child presentation objects

## Status

Accepted. Supersedes the **representation** half of ADR 0008. ADR 0008's boundary and ownership decisions stand unchanged: the `ImageClientAdapter` owns the projection, the projection is pure/renderer-independent, and no authority is ever persisted.

## Context

ADR 0008 defined a durable Perspective as *one* image object holding its presentations as a nested array in a slot and its scalars as JSON metadata. That encoding turned out to be **unimplementable through any authorized image lane**, for reasons that are decided substrate invariants (verified against Lagrange Images ADR 0035/0047/0062; the environment's proposal to un-defer indexed parts is `lagrange-images#119`):

- **Nested values are excluded from the substrate's Value model** (substrate ADR 0035: "no `list`/`record`/`tuple` Value kind is introduced"). The ordered `presentations` array cannot be a field.
- **Refs may not be buried in composites** — the substrate's flat graph walker resolves edges only through slot/indexed Values, so a ref inside a nested array is an *invisible* graph edge. A presentation's `subject` ref could not travel inside one.
- **No authorized metadata-write lane exists.** Creation hardcodes `metadata: {}`, so `title`/`layout`/`formatVersion` had nowhere authorized to live.

ADR 0008's rejection of "each Presentation its own image object" was explicitly conditional (*"can be revisited if shared/reusable presentations become a real requirement"*). The premise that has now changed is stronger than that condition: ADR 0008's chosen encoding **cannot be persisted at all**, so the conditional alternative becomes the only viable shape.

## Decision

A durable Perspective is a **small object graph**: one **Perspective object** plus one **child object per presentation**. All scalar/structural data lives in leaf slots (text/integer); all graph edges are ref slot Values. Nothing is stored in metadata.

### Presentation child object

Each presentation is its own image object with these slots:

- `subject` — a ref/pinned-ref Value (the edge to what is presented). Authorized per-target by the substrate's `object/edge-write` grant (substrate ADR 0062 §4).
- `id`, `kind` — environment strings, as leaf **text** slots.
- `context`, `state` — **ref-free JSON serialized into leaf text slots.** Parsed adapter-side on read. The serializer asserts the value is ref-free first (a ref must never hide in a text slot — the same flat-walker rule as the substrate's `assertRefFree`).
- `ordinal` — an **integer** leaf slot giving this presentation's position.
- `perspective` — a ref edge to the parent Perspective object (the membership edge).

### Perspective object

- `subject` — a ref/pinned-ref Value (the Perspective's root subject).
- `title` — a leaf **text** slot (empty string when untitled).
- `layout` — the compositor's opaque JSON layout descriptor, serialized into a leaf **text** slot. Still owned by the compositor policy; the projection treats it as opaque.
- `formatVersion` — an **integer** leaf slot; the migration seam. (The integer Value stores a decimal-string payload; readers parse it, they do not expect a JS number.)

### Ordering and creation sequence

The Perspective is created **first**, as an empty-but-valid Perspective (a Perspective with zero presentations is a legitimate state, not a partial object). Each presentation child is then created referencing it via the child's `perspective` slot. Order is recovered by reading the children whose `perspective` slot names this Perspective and sorting by `ordinal`.

This inverts the naive "presentations first" intuition on purpose: the rejected failure mode is a durable Perspective that references *not-yet-existing* children. An empty Perspective references nothing, so it is never half-built; children appear after it, each complete.

### The named cost: no forward enumeration

There is **no reverse-ref index in any authorized lane today.** A Perspective object cannot, through an authorized read, enumerate the children that point at it. Until Lagrange Images delivers indexed-part lanes (`lagrange-images#119`), the adapter/session must supply the child records to the decoder (it knows the ids it created, or reads them via `object/read`-level access). This cost is accepted and stated plainly; it is the price of keeping every edge a real, walker-visible graph edge instead of burying ids in a text slot.

### Versioning and the path to indexed parts

`formatVersion` is **2**. Version **1** (ADR 0008's nested-array form) was **never durably written** — the projection was never wired to a live save — so it is abandoned cleanly rather than migrated: readers reject 1 and accept 2.

When `lagrange-images#119` lands, the ordered membership moves to the Perspective's **indexed part** (ordered refs, walker-visible), the per-child `ordinal` and `perspective` back-edge are dropped, and `formatVersion` becomes 3. *Revisit condition: delivery of `lagrange-images#119`.*

## Consequences

- The representation is persistable through the **current** authorized creation lane (leaf text/integer slots + ref edge slots) — no substrate change required for the child-object form. Only the indexed *ordering* waits on `#119`.
- Every edge stays a real graph edge; nothing hides in a text slot or metadata. The cost of that integrity is the forward-enumeration gap above.
- `formatVersion` as its own integer slot is a *more* visible migration seam than ADR 0008's metadata number.
- The projection's contract changes shape: encode produces a small graph, decode assembles one. It stays pure and renderer-independent.

## Alternatives considered

- **Perspective-first with an ordered forward list of presentation refs in slots.** Impossible: a Shape has a fixed slot set, so a Perspective cannot hold a variadic number of presentation-ref slots.
- **An ordered JSON id-list in a text slot.** Rejected as the worst option: it buries N invisible graph edges in a leaf, exactly what the substrate's flat-walker invariant forbids (and what ADR 0008 already rejected for subject strings).
- **Child→Perspective back-ref with the Perspective created last.** Impossible: children cannot reference a parent that does not yet exist. (The chosen design uses a forward-created parent, so the child's `perspective` ref *is* settable at child creation.)
- **Keep ADR 0008's single-object encoding.** Rejected: unimplementable through any authorized lane (see Context).
