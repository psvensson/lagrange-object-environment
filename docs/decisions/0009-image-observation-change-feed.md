# ADR 0009: Live observation is a pull-based change feed owned by the image adapter

## Status

**Amended** — the *full-record / raw-history / numeric-revision-cursor* half of this ADR is superseded
for the authorized feed by lagrange-images [ADR 0070] (`image-observation-binding/v1`). ADR 0009's
boundary and ownership decisions stand unchanged: the `ImageClientAdapter` owns observation end-to-end,
the seam is pull-based and async-iterable (no push), and receiving a Change confers no authority. What
changed is the *content* of the feed: for restricted principals the feed is a **metadata-only
invalidation** (`{type, kind, objectId, cursor}` — identity + kind + opaque cursor, **never** the
record payload, **never** a global revision), and state is re-read via the authorized `readObject`
seam. See the amended "The normalized Change" and "Cursor and resume" sections below.

## Context

Live presentations need to know when the image objects they show change. The obvious design is to give the environment a subscribe/notify mechanism. What the substrate actually offers constrains that.

Verified against the Lagrange Images source:

- Every image mutation commits current state and a history event **atomically** (images ADR 0032), so a change can never be visible in state but absent from history.
- Each event carries a **monotonically increasing `revision`** and the full stored record, on the per-image `history` stream.
- The **only** public read seam is `history(imageId, {afterRevision})` — a *pull* API. There is no watch, subscribe, callback or push anywhere in the public surface.
- The event vocabulary is `image.created`, `shape.put`, `object.put`, `code-artifact.put`, `lexical-environment.put`, `block.put`, `image.root-set`.

So the environment cannot consume a push feed that does not exist, and ADR 0002 forbids inventing shadow image semantics to pretend it does. At the same time, presentations should not each re-implement polling, revision bookkeeping and event interpretation.

## Decision

Live observation is a **pull-based change feed**, owned end-to-end by the `ImageClientAdapter` (the owner of the Object Environment → Lagrange Images interaction). The environment exposes one normalized seam. **Amended (substrate ADR 0070):** the adapter implements it over the **authorized observation lane** (`image-observation-binding/v1`) under per-call authority for restricted principals — not over the raw `history` stream, which is a privileged/host-internal seam carrying full records.

### The seam

The adapter exposes observation as an **async iterable**:

```text
observe(imageRef, { afterRevision }) -> AsyncIterable<Change>
```

Async iteration is the renderer-independent contract for "a sequence of changes over time": a consumer `for await`s changes; cancellation is breaking the loop; errors surface as iteration errors. The adapter hides polling intervals, retries and revision advancement behind it. The seam makes **no claim of push** — latency is bounded by the poll, and consumers must not assume real-time delivery.

### The normalized Change

**Amended for the authorized feed (substrate ADR 0070):** for restricted principals the feed is a
**metadata-only invalidation**, not a full-record Change. Each event is normalized to:

```
  type,            // 'record.put' (object.put in v1)
  kind,            // the raw record-kind string (e.g. 'object.put')
  objectId,        // the changed object's identity
  cursor,          // the lane's OPAQUE resume cursor (NOT a number, NOT a global revision)
```

There is deliberately **no `record` payload** and **no `revision`**: the lane filters per-event by
`object/read` inside the substrate and strips the global revision, so the feed discloses only the
*identity* of an object the caller may read — never its state, never the image's global clock. A
consumer that needs the new state re-reads the object through the authorized `readObject` seam. The
earlier full-record/revision shape described below applied to the *privileged* raw-history feed and is
superseded for restricted observation.

Every substrate event is normalized to one shape so presentations consume a single contract regardless of record kind:

```text
{
  revision,        // monotonic per image; the resume cursor
  type,            // 'record.put' | 'image.root-set' | 'image.created'
  kind,            // raw substrate event type, for filtering ('object.put', ...)
  record,          // the full stored record (null for root-set)
  at,              // ISO timestamp from the substrate
}
```

`record.put` covers all `*.put` record kinds; `kind` retains the distinction for consumers that care (e.g. only objects). This is a *normalization*, not new semantics: no information is added and nothing the substrate did not store is invented.

### Cursor and resume

**Amended for the authorized feed (substrate ADR 0070):** the cursor is the lane's **opaque token**
(`obs-cursor/v1:...`), not a numeric `revision`. An empty cursor means **live follow** (the lane
anchors at the current end and replays no backlog); a previously-returned token **resumes** after its
position (a valid older token idempotently re-emits earlier visible invalidations). The token is
opaque and integrity-protected, so the consumer cannot read a revision out of it or gap-analyze
writes to objects it cannot see. The earlier `afterRevision`-as-cursor text described the privileged
raw-history feed and is superseded for restricted observation.

### No authority

Observing yields data only. A `Change` is an inert record; receiving one confers no authority over the changed object, consistent with the architecture's authority boundary.

### Downward proposal (identified, not built)

A true push/subscribe feed would be an image-level addition. Per ADR 0002 that is a *future downward proposal* to Lagrange Images, to be made only if Phase 1 shows poll latency is a real product problem. This ADR deliberately does **not** build or shadow one; the pull seam is sufficient for the first live object loop.

## Consequences

- One component — the `ImageClientAdapter` — owns polling, revision bookkeeping and event normalization. Presentations consume a single, stable `Change` contract.
- The seam is honest about the substrate: async iteration over a poll, never a promise of push.
- Resume semantics make a Perspective able to re-attach and catch up after a disconnect using a stored revision.
- Because substrate history is atomic with state (ADR 0032), a consumer that has seen revision `n` has a consistent view; it cannot have seen a state whose event is missing.
- If push is ever added below, only the adapter changes; the presentation-facing `Change`/async-iteration contract can survive unchanged.

## Alternatives considered

- **Expose raw `history` to presentations.** Rejected: every consumer would re-implement polling, revision bookkeeping and event interpretation, duplicating policy the adapter should own once.
- **Invent a push/subscribe abstraction now.** Rejected: the substrate has no push; faking it above would hide latency and failure modes, and would be exactly the shadow-semantics ADR 0002 forbids. Recorded as a downward proposal instead.
- **Poll per-presentation rather than per-image.** Rejected: the history stream is per-image; the adapter polls once per image and fans out, rather than each presentation polling independently.
