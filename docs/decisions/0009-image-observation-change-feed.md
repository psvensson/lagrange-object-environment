# ADR 0009: Live observation is a pull-based change feed owned by the image adapter

## Status

Accepted

## Context

Live presentations need to know when the image objects they show change. The obvious design is to give the environment a subscribe/notify mechanism. What the substrate actually offers constrains that.

Verified against the Lagrange Images source:

- Every image mutation commits current state and a history event **atomically** (images ADR 0032), so a change can never be visible in state but absent from history.
- Each event carries a **monotonically increasing `revision`** and the full stored record, on the per-image `history` stream.
- The **only** public read seam is `history(imageId, {afterRevision})` — a *pull* API. There is no watch, subscribe, callback or push anywhere in the public surface.
- The event vocabulary is `image.created`, `shape.put`, `object.put`, `code-artifact.put`, `lexical-environment.put`, `block.put`, `image.root-set`.

So the environment cannot consume a push feed that does not exist, and ADR 0002 forbids inventing shadow image semantics to pretend it does. At the same time, presentations should not each re-implement polling, revision bookkeeping and event interpretation.

## Decision

Live observation is a **pull-based change feed**, owned end-to-end by the `ImageClientAdapter` (the owner of the Object Environment → Lagrange Images interaction). The environment exposes one normalized seam; the adapter implements it over the public `history` contract.

### The seam

The adapter exposes observation as an **async iterable**:

```text
observe(imageRef, { afterRevision }) -> AsyncIterable<Change>
```

Async iteration is the renderer-independent contract for "a sequence of changes over time": a consumer `for await`s changes; cancellation is breaking the loop; errors surface as iteration errors. The adapter hides polling intervals, retries and revision advancement behind it. The seam makes **no claim of push** — latency is bounded by the poll, and consumers must not assume real-time delivery.

### The normalized Change

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

A change's `revision` is the only cursor. A consumer that wants **catch-up** passes a stored `afterRevision`; a consumer that wants **live follow** starts from the current end of the stream. The two modes are distinct and both must be provable: catch-up must replay events the consumer missed, and live-follow must not replay a backlog it never asked for.

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
