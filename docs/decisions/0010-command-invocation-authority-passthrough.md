# ADR 0010: Command invocation passes authority through; the environment never holds it

## Status

Accepted

## Context

ADR 0004 made Commands first-class environment objects and established that command applicability is not authorization. ADR 0005 fixed that authority is transient execution context, never durable and never a Value. What was still undefined was the seam by which a `Command`'s invocation actually crosses into an *authorized* image operation — who threads the authority, who owns errors, and what the environment may and may not do with a per-call authority context.

Verified against the Lagrange Images source:

- **Authority** is an opaque `AuthorityContext` issued by a control-plane authority service. `issue`/`attenuate`/`revoke` are control-plane operations; `attenuate` can only *narrow* (no widening exists by construction); `require` is check-only and returns nothing. Grants live in a module-private `WeakMap`; the context object handed out is an empty frozen object with nothing to read, stash or forge.
- **Invocation** composes two public steps: `invocations.invokeBlock(blockRef, args)` / `sendMessage(...)` produces a frozen activation, then `executor.execute(activation, {authority, ...})` threads the authority as *transient per-execution context*. Authority never reaches an activation record, a Value or durable state (substrate invariant, proven by images tests). Both steps are exposed on the object `createRuntime()` returns.
- **The only authorized write lane today** is the `image-mutation-binding/v1` callable. Per images ADR 0042 it deliberately **cannot** create objects, delete objects, change shapes, or write graph edges (no `ref` in the callable type language), and multi-object transactions are deferred pending an authority-across-a-transaction decision. `ImageService.putObject` performs **no authorization at all** — it is the host-side, unguarded path.
- **Errors**: authorization denial throws `AuthorityError` (including the revoked-ancestor case). Concurrency conflict on the authorized lane throws `ObjectMutationConflictError` — the substrate *deliberately translates and never propagates* the raw `VersionConflictError`, so the environment structurally cannot see backend version numbers there.

So the invocation path *exists* publicly, but any command meaning "create an object", "link two objects", or spanning multiple records has **no authorized public lane** today.

## Decision

Command invocation is owned end-to-end by the `CommandDispatcher` (the owner of the Command → image-operation interaction), which delegates the actual image crossing to the `ImageClientAdapter`. The environment **passes authority through**; it never holds it.

### Authority is pass-through, never held

- The dispatcher receives a per-call authority context at invocation time and hands it, uninspected, to the adapter. It never mints, stores, caches, attenuates, widens or branches on it. The context is opaque to the environment exactly as it is to an executor.
- The `ImageClientAdapter` owns the authority **crossing**: expressing the operation through public image APIs (`invokeBlock` + `execute(activation, {authority})`) is the adapter's contract. The dispatcher merely *supplies* the context it was given.
- Between invocations, the per-principal authority context is held by the **Session's connection locus** (the ephemeral, per-client connection state) — never in `Session.state` (plain mutable data) and never in a `Perspective` (durable, per ADR 0008). Persisting authority is exactly what ADR 0005 forbids.

### Command → operation mapping

A v0 command invocation is **one logical operation**. Whether that operation needs multi-record atomicity is an image concern (backend transactions, images ADR 0032), not something the environment orchestrates with raw `putObject`. The dispatcher forwards the caller's argument bag (`context`) to the seam unchanged — including any version token the caller supplies — and never retries a conflict silently. Optimistic-concurrency tokens are opaque by substrate design: the authorized lane takes a `version-token` string (never raw backend version numbers), so there is nothing for the dispatcher to inspect or rewrite.

### Errors are typed at the boundary

The dispatcher maps outcomes into a small typed taxonomy so a presentation/command layer can *react* without the dispatcher deciding policy:

- `CommandNotApplicableError` — the command's applicability predicate failed. Environment-side; the image seam is **not** called.
- `CommandAuthorizationError` — the image denied authority (an `AuthorityError`, including revocation). Distinct from generic failure so a presentation can show "unauthorized".
- `CommandConflictError` — an optimistic-concurrency conflict (`ObjectMutationConflictError`). Not retried; surfaced so the UI can offer reload/retry.
- `CommandExecutionError` — any other underlying failure (e.g. missing block/artifact), passed through without misclassification.

Because the substrate hides raw version numbers on the authorized lane, the conflict error carries no backend `actualVersion` — the taxonomy is honest about what the substrate reveals.

### Downward proposal (identified, not built)

Per ADR 0002, the environment does not shadow missing image semantics. Recorded as a future downward proposal to Lagrange Images, citing images ADR 0042's deferred list: **authorized lanes for object creation, deletion, graph-edge writes, and multi-record transactions.** Until those exist, the environment's commands are limited to what the `image-mutation-binding/v1` lane (slot mutation of an existing object) and read/observation can express; it does not route around the gap with unguarded `putObject`.

## Consequences

- One component — the `CommandDispatcher` — owns invocation sequencing, result/error mapping and the decision of which image operation a Command means; the `ImageClientAdapter` owns how that operation (and its authority) is expressed on the wire. Neither duplicates the other.
- Authority can never leak into durable environment state: there is no field that holds it, and the two tempting homes (Session state, Perspective) are explicitly ruled out.
- The typed error taxonomy lets presentations react to unauthorized/conflict distinctly, without the dispatcher inventing retry or authorization policy.
- The downward proposal is concrete and cited, so a future agent finds the real gap (creation/edge/multi-record lanes) rather than a vague "if needed".

## Alternatives considered

- **Let each Command invoke the image directly.** Rejected: every command would re-implement authority threading, sequencing and error mapping — duplicated policy the dispatcher should own once.
- **Give the dispatcher retry/authorization policy.** Rejected: silent conflict retry hides lost-update hazards from the user, and authorization decisions belong below the environment. The dispatcher surfaces; it does not decide.
- **Orchestrate multi-record commands via raw `putObject`.** Rejected: `putObject` is unauthenticated; using it to work around the missing authorized lanes would be exactly the shadow-semantics ADR 0002 forbids, and would bypass the image's authorization boundary.

## Claims cited to substrate, not proven here

Two invariants are substrate-owned and proven by Lagrange Images' own tests; this ADR cites rather than re-proves them:

- Authority threaded into `execute` never becomes a Value or durable graph state (images ADR 0037, proven in `execution-authority.test.js`). The environment tests only that *it* never persists the context.
- `ObjectMutationConflictError` genuinely implies nothing was written (images ADR 0042 proof case). The environment tests only the error *mapping*.
