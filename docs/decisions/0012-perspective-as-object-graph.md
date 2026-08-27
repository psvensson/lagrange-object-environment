# ADR 0012: A Perspective is a small object graph — a Perspective plus child presentation objects

## Status

Accepted. Supersedes the **representation** half of ADR 0008. ADR 0008's boundary and ownership decisions stand unchanged: the `ImageClientAdapter` owns the projection, the projection is pure/renderer-independent, and no authority is ever persisted.

**Amended (2026-08-25):** the indexed-part lane this ADR anticipated has been delivered (substrate ADR 0064; the `lagrange-images#119` revisit condition has fired). The representation now uses the Perspective's **indexed part** for ordered membership, the creation order is **presentations-first / Perspective-last** (substrate ADR 0064 §6), the per-child `ordinal` and `perspective` back-edge are dropped, and `formatVersion` is **3**. Versions 1 and 2 were designed but **never durably persisted**, so they are abandoned, not migrated. The amendment is recorded inline; the superseded form is described under "Superseded (formatVersion 2)" for the decision history.

## Context

ADR 0008 defined a durable Perspective as *one* image object holding its presentations as a nested array in a slot and its scalars as JSON metadata. That encoding turned out to be **unimplementable through any authorized image lane**, for reasons that are decided substrate invariants (verified against Lagrange Images ADR 0035/0047/0062):

- **Nested values are excluded from the substrate's Value model** (substrate ADR 0035: "no `list`/`record`/`tuple` Value kind is introduced"). The ordered `presentations` array cannot be a field.
- **Refs may not be buried in composites** — the substrate's flat graph walker resolves edges only through slot/indexed Values, so a ref inside a nested array is an *invisible* graph edge. A presentation's `subject` ref could not travel inside one.
- **No authorized metadata-write lane exists.** Creation hardcodes `metadata: {}`, so `title`/`layout`/`formatVersion` had nowhere authorized to live.

ADR 0008's rejection of "each Presentation its own image object" was explicitly conditional (*"can be revisited if shared/reusable presentations become a real requirement"*). The premise that changed is stronger than that condition: ADR 0008's chosen encoding **cannot be persisted at all**, so the conditional alternative becomes the only viable shape.

Substrate ADR 0064 then delivered the missing piece: the creation lane accepts an **edge indexed field** — an ordered list of ref targets, each authorized per-element by the existing `object/edge-write` grant — so an ordered collection of refs with full flat-walker visibility can be written through an authorized lane.

## Decision

A durable Perspective is a **small object graph**: one **Perspective object** plus one **child object per presentation**. All scalar/structural data lives in leaf slots (text/integer); all graph edges are ref slot Values or indexed ref elements. Nothing is stored in metadata.

### Presentation child object

Each presentation is its own image object with these slots:

- `subject` — a ref/pinned-ref Value (the edge to what is presented). Authorized per-target by the substrate's `object/edge-write` grant (substrate ADR 0062 §4).
- `id`, `kind` — environment strings, as leaf **text** slots.
- `context`, `state` — **ref-free JSON serialized into leaf text slots.** Parsed adapter-side on read. The serializer asserts the value is ref-free first (a ref must never hide in a text slot — the same flat-walker rule as the substrate's `assertRefFree`).

There is **no `ordinal` and no `perspective` back-edge** (see "Ordering" below — both would duplicate a semantic now owned by the Perspective's indexed part).

### Perspective object

- `subject` — a ref/pinned-ref Value (the Perspective's root subject).
- `title` — a leaf **text** slot (empty string when untitled).
- `layout` — the compositor's opaque JSON layout descriptor, serialized into a leaf **text** slot. Still owned by the compositor policy; the projection treats it as opaque. (As of E2, when the layout IS a composition it carries the versioned payload `{kind:'composition', version:1, root}` whose *meaning* is owned by `src/composition-persistence.js`; this projection still treats the slot as opaque ref-free JSON.)
- `formatVersion` — an **integer** leaf slot; the migration seam. (The integer Value stores a decimal-string payload; readers parse it, they do not expect a JS number.)
- **Indexed part** — the list of presentation refs (`ref`/`pinned-ref` elements), one per presentation. This owns durable child **membership** and the **canonical record enumeration order**, in one walk-visible place (substrate ADR 0047/0064). It does **not** own arrangement/layout order: once E2 exists, the composition tree (in the `layout` slot) owns how the presentations are *arranged*; the indexed part's order is record enumeration, independent of arrangement. The Perspective class is defined with an **indexed instance Shape** (`indexed: 'values'`), and the list is written through the creation lane's single edge indexed field.

### Ordering and creation sequence

**Presentations first, the Perspective last** — the Perspective object is the commit point (substrate ADR 0064 §6):

1. Create each presentation child (each is independently complete and immediately durable).
2. Create the Perspective with its indexed part naming the children **in order**; each indexed element fires a per-target `object/edge-write` grant.

**Commit semantics (explicit).** The indexed Perspective is the single commit point: until its create succeeds there is no durable Perspective, only children. A Perspective can never reference a not-yet-existing child, so it is never half-built. The cost is the inverse failure mode: a save that fails *after* some children are created but *before* the Perspective commits leaves **orphan presentation objects** — durable, unreachable, observable on the change feed. That degradation from "one durable unit" is real and accepted until multi-record transactions exist (deferred, substrate ADR 0062 §8).

### Staged authority

Creating the children mints their object ids server-side, and the substrate authority service matches resources **exactly** (no wildcards). So no single authority context issued up front can authorize both the children's subject edges and the Perspective's indexed edges to those not-yet-existing children. Saving is therefore a **staged authorized workflow**: the adapter obtains a *fresh, opaque* authority context for each image invocation from a connection/control-plane **authority provider**, after that invocation's exact resources are known — one context to create the children, then a new context (authorizing the Perspective subject edge and an `object/edge-write` per now-known child id) to create the Perspective. The environment neither issues nor inspects these contexts; it passes them through opaquely (ADR 0010). This composes creation under exact-match authority without deterministic ids or adapter-held authority-root. The residual ergonomic gap — creation returns identity+version but no transient capability over the new object, forcing the re-issuance step — is recorded as substrate follow-up `lagrange-images-3zm` (a created-object capability; version tokens are not to be overloaded).

### Forward enumeration

The indexed part lives **on the Perspective object**, so a reader enumerates a Perspective's presentations directly from it. The projection lane refuses indexed objects, so the read is via `object/read`-level access (`ImageService.getObject` — the unguarded host path, per substrate ADR 0064 §4). Forward enumeration is **restored**; the formatVersion-2 "no forward enumeration" cost no longer applies.

### Versioning

`formatVersion` is **3**. Readers reject 1 and 2. Both earlier forms were designed but **never durably persisted** — the projection was never wired to a live save before the indexed form was adopted — so there is nothing to migrate and no dual-format reader is kept.

## Consequences

- The representation is persistable through the **current** authorized creation lane (leaf text/integer slots + ref edge slots + one edge indexed field). No further substrate change is required for save/load.
- Membership and ordering have **exactly one owner** — the Perspective's indexed part. Dropping `ordinal` and the back-edge avoids two competing sources of the same semantic (an ownership-drift defect).
- Saving a Perspective creates 1 + N objects with no multi-record transaction; the Perspective is the commit point and orphans (never half-built Perspectives) are the accepted cost until multi-record transactions exist.
- `formatVersion` as its own integer slot remains a greppable migration seam.

## Superseded (formatVersion 2)

Before the indexed lane existed, this ADR (as first accepted) could not put an ordered ref-list on the Perspective, so it used an interim: each presentation child carried an `ordinal` integer slot and a `perspective` back-ref, the Perspective was created **first** (empty-but-valid), and order/membership were recovered by reverse lookup of children pointing at it. That form had the named cost of **no forward enumeration** (no reverse-ref index in any authorized lane). It was **never durably persisted**. Substrate ADR 0064 removed the constraint, and §6 of that ADR prescribes the opposite creation order (presentations-first), so the interim was superseded before ever being written.

## Alternatives considered

- **Perspective-first with an ordered forward list of presentation refs in slots.** Impossible: a Shape has a fixed slot set, so a Perspective cannot hold a variadic number of presentation-ref slots. (The indexed part is the substrate's variadic, ordered, walk-visible answer.)
- **An ordered JSON id-list in a text slot.** Rejected as the worst option: it buries N invisible graph edges in a leaf, exactly what the substrate's flat-walker invariant forbids (and what ADR 0008 already rejected for subject strings).
- **Child→Perspective back-ref with the Perspective created last.** Impossible: children cannot reference a parent that does not yet exist.
- **Keep `ordinal` and/or the `perspective` back-edge alongside the indexed part.** Rejected: order and membership would then have two owners that can disagree — precisely the ownership-drift defect the single-owner principle forbids.
- **Keep ADR 0008's single-object encoding.** Rejected: unimplementable through any authorized lane (see Context).
