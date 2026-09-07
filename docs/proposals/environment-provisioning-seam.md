# Proposal: a public provisioning seam for Environment-owned well-known objects

**Status:** OPEN. Sent from `lagrange-object-environment` to the `lagrange-images` owner. Originating Bead `lagrange-object-environment-0k7.1` (Object-native Theme foundation). Per environment ADR 0002 this is a downward proposal of a missing image-level semantic contract; the Environment does not shadow it with an unguarded `putObject`, a read-then-put of its own, or another subsystem's provisioning helper.

Audited against pinned Images `9af24da93eba17357b05168ad5fc657be51bce94`, which was the pinned revision when this proposal was written. **Not re-audited at `15fcb811`** (the E3 admission) **or at `ccd8321`** (the method-position authority admission): neither bump touched this proposal's area — the first was scoped to the native method replacement seams, the second to method-read authority plus unrelated M4 language work — so the gap is believed to stand, but this proposal does not assert it for either revision.

**Sent as:** [lagrange-images#224](https://github.com/psvensson/lagrange-images/issues/224). Discovered-from Bead `lagrange-object-environment-qa3`.

## What the Environment is trying to do

ADR 0015 decided that every durable semantic thing the Object Environment owns is ordinary image objects and refs — Themes, design tokens, environment profiles, future durable defaults — with no settings database, preference file, browser-local authority, CSS file or JSON document as the source of truth.

Its §6 requires shared defaults to be **real objects created at environment provisioning time**, reachable later from **one well-known catalog object at a stable id**, because a later session must find the same catalog without scanning the image and without a browser-local registry.

That is the whole of the request. This proposal asks for no theme semantics in Images; Themes are ordinary Environment data.

## The gap

Provisioning that catalog needs a write **at an id the caller chooses**, with idempotent replay. Neither is reachable through a public, correctly-owned seam.

**No authorized lane can place an object at a chosen id.** `image-creation-binding/v1` mints it (`const candidate = newObjectId()`, defaulting to `randomUUID`), and `newObjectId` is an *executor-construction* option rather than a per-call parameter, so a consumer cannot supply one without constructing its own executor — which would be a second object-creation lane. `image-creation-batch-binding/v1` mints likewise.

**The ensure owner is not public.** `src/graph/ensure-records.js` has exactly the semantics ADR 0015 §6 needs — insert-only (`putObject(..., {expectedVersion: 0})`), projection-compared, race-tolerant, adopt-an-identical-record, refuse a divergent one, with a `seed` mode for records a later release may deliberately move. But `src/graph/index.js` re-exports only `references.js` and `bundle.js`, `package.json` declares no wildcard subpath, and no `index.js` in the tree re-exports it.

**What *is* public under those names is a different owner's wrapper.** `src/runtime.js` does export `ensureObject`/`ensureShape` — but they are `src/language/smalltalk-kernel.js`'s, delegating to the real owner and differing by throwing `SmalltalkKernelConflictError`. Verified: `runtime.ensureObject === graphEnsureRecords.ensureObject` is `false`.

We consider that a wrong-owner path rather than a usable one, and are not taking it. It would make the Environment's durable-state provisioning depend on the Smalltalk personality module for data that is not Smalltalk's, and would surface an Environment provisioning conflict to a user as a Smalltalk *kernel* error. A name collision that behaves correctly in the happy path is a worse trap than an absent export, which is why this proposal exists rather than a quiet import.

## What we are asking for

A public, correctly-owned way for a trusted host to provision an Environment-owned record at a **caller-chosen id**, idempotently. Shape, naming and decomposition are entirely the lower owner's decision. Concretely it must answer:

1. **Chosen id.** The caller names the id; the operation does not mint one.
2. **Idempotent exact replay.** Replaying identical provisioning is a no-op — and specifically **write-free**, so a second run does not bump the record's version. We intend to prove that from the consumer side by asserting the version token is byte-identical across two provisioning runs, so "no-op" needs to mean genuinely no write, not a rewrite of equal content.
3. **A divergent occupant is refused,** not overwritten, and the error identifies the *provisioning* concern rather than another subsystem's.
4. **A deliberate move is expressible.** A later release must be able to repoint the catalog's `defaultTheme` without that being a hard conflict — the `seed`-style adoption the existing owner already has, with the domain decision left to the caller.
5. **Races converge** rather than surfacing an uncaught version conflict.
6. **Shapes too,** on the same terms: the environment schema installs Shapes at chosen ids with the same replay/refusal semantics.

We are explicitly **not** asking for: Theme, token or profile semantics in Images; a generic key-value store; an authorized user-facing creation-at-chosen-id lane (provisioning is trusted, install-time, host-invoked — every subsequent *read* still crosses `object/read` normally); or any change to the existing authorized creation lanes.

## Why the existing Environment precedent is not an answer

`ImageClientAdapter.ensureSchema` and `ensurePerspectiveSchema` already provision Shapes and classes with a read-then-write: if a record exists at the id they adopt **whatever is there**, with no comparison, and because `putShape` is insert-only two concurrent provisioners race into an uncaught `VersionConflictError`. That is the defect this request would let us avoid rather than a pattern to extend — and copying it into a third place is precisely what we are declining to do.

## Unblock criteria

`lagrange-object-environment-0k7.1` resumes when a pinned Images revision publishes such a seam through a reviewed public root. The Environment then admits that revision once through its normal reviewed pin procedure and builds `EnvironmentProvisioner` on top.

Until then the Theme lane stays blocked at the Environment boundary. We will not work around it with an unguarded `putObject`, an Environment-side read-then-put, or the Smalltalk kernel's wrapper.

## Note on the native lane

`ensureObject`/`ensureShape` — under either owner — are absent from `src/portable-runtime.js`, so a native host cannot provision either. That is recorded as a secondary observation, not part of this request: no consumer needs native provisioning yet, and we do not want the portable surface widened for test convenience (compare `lagrange-object-environment-aov`). If a real native provisioning consumer appears, that gets weighed on its own merits.
