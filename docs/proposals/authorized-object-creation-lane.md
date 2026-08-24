# Proposal: an authorized object-creation lane for Lagrange Images

**Status:** proposal from `lagrange-object-environment` to the `lagrange-images` owner. Not yet an ADR in either repository. Per environment ADR 0002, this is a downward proposal of a missing image-level semantic contract; the environment does not shadow it with unguarded `putObject`.

**Requested owner:** the `lagrange-images` owner. Environment-side consumption stays with `ImageClientAdapter` (`docs/ownership.md`).

## 1. The need

The environment's first durable operation in Phase 1 is *save a Perspective* — and a Perspective is an ordinary image object (environment ADR 0008). Creating that object has **no authorized public lane today**:

- `ImageService.putObject` performs **no authorization** (no `require` anywhere in `graph-image-service.js`); it is the host-side unguarded path.
- The only authorized write lane, `image-mutation-binding/v1`, deliberately **cannot** create objects, delete objects, change shapes, or write graph edges (images ADR 0042 §9), or span records (images ADR 0042 deferred list, "multi-object transactions").

So today the environment can read and observe objects and mutate the scalar slots of an existing object — but cannot durably create the Perspective object its own architecture is built around. This proposal requests the **smallest coherent** authorized lane that makes Phase 1 possible.

## 2. Scope: create an object, including its initial ref slots under per-target edge authority

The smallest *useful* increment is **not** "create-only." A create-only lane that forbids refs cannot persist a Perspective, because a Perspective's `subject` slot is a mandatory `ref` (environment ADR 0008: encoding a non-ref subject throws; there is no "unbound Perspective"), and the callable type language has no `ref` type (images ADR 0042 §7). A lane that cannot create the one object the environment needs delivers zero value.

Two alternatives were rejected:

- **Two-step (create with a placeholder subject, then attach the ref later).** Rejected: the intermediate object is observable through `object/read` and the change feed (environment ADR 0009) as a half-built Perspective — a durable invariant violation visible to other observers. It also violates `assertObjectMatchesShape` if `subject` is a declared shape slot. Environment ADR 0008 explicitly forbids the projection from inventing an "unbound" state.
- **Full ref-mutation lane.** Rejected as larger than necessary; ref *mutation on existing objects* stays deferred.

**In scope (this proposal):**

1. A new `object/create` operation on a **per-(image, shape)** resource.
2. Creation of one object of an existing durable Shape, with initial slot values.
3. Initial slot values may include `ref`/`pinned-ref` to *durable* objects, where **each ref is checked against a separate per-target authority** so narrow authority cannot become broad reach.
4. Server-minted object id; caller never supplies the id.
5. Insert-only (`expectedVersion: 0`); state + history commit atomically.

**Explicitly deferred (unchanged, per images ADR 0042 deferred list):**

- object deletion
- ref **mutation** on existing objects (writing an edge into an already-created object)
- multi-object transactions (needs authority-across-a-transaction)
- whole-object writes supplying every slot
- shape/behavior-changing writes

## 3. Authority model

### 3.1 Operation and resource

- **Operation:** `object/create`. A distinct operation rather than an overload of `object/write`, because creation has no existing object to read-for-write, no unmapped slots to preserve, and no prior version to conflict against — overloading would blur the granularity rule images ADR 0042 §2–3 established.
- **Resource:** a new injective helper `createResource(imageId, shapeId)`, following the same base64url + `.` rule as `objectResource` (images ADR 0039 §5 — concatenation is forbidden; only an injective helper may name a resource). **Only object-scoped `objectResource` exists today; this helper must be added.**

### 3.2 Granularity: per-(image, shape), not per-image

A per-image create grant would let its holder mint **unlimited objects of any shape** into the image. The grant algebra is exact-match `{operation, resource}` with **no wildcards and no quotas** (images ADR 0039), so there is no rate-limiting backstop — per-image create is a genuine resource-exhaustion/spam vector.

Images ADR 0046 §10 already published the inclination: *"Its likely useful granularity is class-scoped — permission to instantiate a particular class."* Scoping `object/create` to a **(image, shape)** pair:

- blunts the exhaustion vector (a Perspective-shape create grant does not authorize minting other shapes),
- matches ADR 0042 §2's rule of authorizing the thing the operation actually affects,
- composes with the shape requirement: the caller names the shape, the resource scopes to it, and the integrity check confirms it exists.

### 3.3 Authorize before any write

`require({operation: 'object/create', resource: createResource(imageId, shapeId)})` runs **before** any object is minted or written — matching ADR 0042 §4's ordering. A caller without the grant learns nothing.

### 3.4 Ref slots: separate per-target authority

A created object may carry initial `ref`/`pinned-ref` slot values naming **durable** objects. Writing a ref naming target `T` triggers a **separate `require`** scoped to `T` — so create-with-an-edge cannot reach an object the caller has no edge authority over. This preserves ADR 0042 §7's invariant ("authority for A must not imply authority for what it points at") at creation time; without it, the lane would reintroduce the broad-reach hole it was designed to avoid.

The exact per-target operation/resource shape (whether a distinct `object/edge-write` operation scoped to `objectResource(imageId, targetId)`, or a resource that names the edge) is a substrate-owned decision; this proposal flags it as the one authority question that must be settled for the lane to be safe.

### 3.5 Shape existence is integrity, not exposure

The created object must satisfy `assertObjectMatchesShape` against an existing durable Shape. That check does **not** require `object/read` on the shape: the caller never receives the shape's contents, and already had to name the shape id to call create — so the id is not leaked. This follows ADR 0042 §3's read-for-write-is-not-an-exposure logic.

**Caveat to state honestly:** since `require` precedes the shape check (§3.3), an *unauthorized* caller learns nothing; but an *authorized* creator who names a wrong shape id learns "that shape does not exist." That is a shape-existence oracle within a scope the caller can already create into — acceptable because the shape id is caller-supplied, but it should be a conscious decision.

## 4. Object identity and versioning

- **Server-minted id:** the lane mints the new object's id (the existing `putObject` default, `randomUUID()`), and the caller **never supplies** it. This avoids identity-collision and reserved-namespace games (images ADR 0052/0060). This is *create-a-durable-object*, **not** *promote-a-transient-one*: there is no arena instance to promote, so the transient→durable `durableIdFor` derivation does not apply; the service-level UUID default is the coherent regime.
- **No version token on the request:** with no prior state there is nothing to conflict against, so the opaque-version-token machinery (ADR 0042 §5) does not apply. Insert-only (`expectedVersion: 0`) is the entire guard.
- **Returns the initial object-scoped version token:** a successful create returns the new object's id and its initial version token so subsequent mutations chain (ADR 0042's "a successful mutation returns the next token"). The token is object-scoped and therefore bound to the **server-minted** id, not a caller-chosen one.

## 5. Atomicity and failure

Creation commits the materialized record and its history event in **one backend transaction** via the existing `putWithHistory` contract (images ADR 0032 / ADR 0042 §6). A failed create commits nothing: no partial object, no orphaned history event, no version increment.

## 6. Guardrails (mirroring the ADR 0042 style)

```text
object/create != object/write                 (distinct operation, distinct resource)
create resource is per-(image, shape)          (never per-image: no wildcards, no quotas)
resource named by createResource()             (injective helper, never concatenation)
authorize before any write                     (an unauthorized caller learns nothing)
server mints the object id                     (caller never supplies it)
create != promote                              (service UUID default, not durableIdFor)
no version token on create                     (nothing to conflict against)
create returns the initial object-scoped token (so mutations chain)
a ref slot requires a separate per-target require (narrow != broad reach)
shape existence is integrity, not exposure     (with the authorized-creator oracle caveat)
state and history commit in one transaction, or neither commits
delete / ref-mutation / multi-record stay deferred
```

## 7. What the environment will consume

Once this lane exists, `ImageClientAdapter` implements *save Perspective* as: build the Perspective object record (environment ADR 0008 encoding) and create it through the authorized lane, passing the per-call authority context through (environment ADR 0010). The environment never calls unguarded `putObject`.

Until then, the environment's Phase 1 is blocked on this substrate contract — which is exactly why this proposal is made before the environment builds its live loop.

## 8. Open questions for the substrate owner

1. The exact per-target **edge authority** shape for ref slots (§3.4) — a distinct `object/edge-write` operation on `objectResource(target)`, or an edge-naming resource?
2. Whether `createResource(imageId, shapeId)` is the right helper, or a class-level resource (per ADR 0046's "class-scoped") that resolves through the shape/behavior.
3. Whether initial ref slots should be restricted to *durable* targets only (this proposal assumes yes) and how that interacts with the reserved transient namespace (ADR 0052).
