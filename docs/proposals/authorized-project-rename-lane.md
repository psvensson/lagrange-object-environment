# Proposal: version-aware authorized Project read, and an authorized Project rename

**Status:** proposal from `lagrange-object-environment` to the `lagrange-images` owner. Not yet an ADR in either repository. Per environment ADR 0002, this is a downward proposal of a missing image-level semantic contract; the environment does not shadow it with an environment-declared slot mapping, unguarded `putObject`, or UI-side name state. Tracked as environment Bead `lagrange-object-environment-okv`.

**Requested owner:** Images ownership row *"Image-level Project working-state semantics"* (`src/project/working-state.js`). Environment-side consumption stays with `ImageClientAdapter` (environment `docs/ownership.md`, "Object Environment -> Lagrange Images").

**This fills a deferral Images already recorded.** Images ADR 0073 "Deferred by evidence" opens with *"durable Project object/member/relationship Shapes and mutation service"*. The Shapes half has since shipped (`src/project/working-state.js`); only the **mutation service** half remains. ADR 0073 already fixes the authority stance such a service must obey: *"Project membership != authority"*; *"Installation/upgrade requires explicit target create, write and edge authority. […] Project structure never widens authority transitively."* This proposal asks for the **first, smallest concrete slice** of that mutation service, plus the read-side complement it needs. It is two independently landable asks; (b) is useful on its own and should land first.

## 1. The need

The environment ships a read-only durable Project browser (Phase 3/4 first item, Bead `mky`) built on Images' single authorized Project seam, `authorizedReadProjectDescriptor` (`src/project/working-state.js`, public via `src/portable-runtime.js`). The next roadmap item — *creation/editing commands over image-level Project APIs* — has no authorized lane to stand on:

- `createProject` / `addProjectMember` are exported, but they take the raw `images` service and write with `putObject` under **no** `require`. They are host/control-plane helpers (the `portable-runtime.js` comment says exactly this), not an authorized lane.
- The only authorized write lane, `image-mutation-binding/v1` (ADR 0042), needs a caller-declared **field -> slot** map. The Project shape's slot ids are private by construction: `SLOT` is a module-local constant in `working-state.js`, absent from that module's export list and from `src/portable-runtime.js`. On the environment side, two ownership rows forbid knowing them — the adapter row (*"knows no Project storage IDs/slots"*) and the ProjectBrowser row (*"no backing Project id/slot/member record is known here"*).
- Consequence: **no Project field is writable through a public authorized path without a caller hardcoding Project slot ids**, which both repositories' ownership rules forbid.
- The environment's own rule (ADR 0002, AGENTS.md): a missing image-level contract is proposed downward, never worked around.

The smallest useful Project write is **rename**: one leaf text slot on one object. No new object, no edge, no member identity, no ref (the `namespace` slot is a ref and is explicitly out of scope; ADR 0042 §7 refuses to write through refs).

## 2. Scope: two asks, landable independently

### (b) — first: a version-aware authorized Project read

Today `authorizedReadProjectDescriptor` returns only the canonical descriptor. A writer needs the Project object's **current version token** for optimistic concurrency (ADR 0042's CAS rule), and it must obtain it **without learning storage ids**. That rules out the ADR 0068 whole-record read lane for two independent reasons: it requires the caller to name the Project's `objectId`, and its result lists slot entries `{name, value}` where *"each slot name is the durable slot id"* — the very ids that must stay private.

The token cannot be added to the descriptor itself: `normalizeProjectDescriptor` (`src/project/model.js`) asserts the exact keys `['format','members','name','namespace','projectId']` and freezes the record, and a transient concurrency token does not belong in a canonical semantic record.

**Request:** a sibling (or variant) of the read seam that returns the token **beside** the descriptor, coupled to the Project object record it was read from:

```js
authorizedReadProject({images, imageId, projectId, require})
  -> { descriptor, versionToken }
```

Rationale is Images' own ADR 0068 one-read rule (`src/callable/image-object-read-binding.js`): *"One read: the token and the value both come from this record, so the token always describes the state the value was taken from."* Same `require` ordering as the existing seam: `object/read` on `objectResource(imageId, projectObjectId(projectId))` **before** any existence disclosure (no existence oracle). The token is the ordinary object-scoped `objectVersionToken(imageId, projectObjectId(projectId), _version)` — opaque to the caller.

**Token scope (stated so it is not re-asked):** the descriptor read is one Project-object read plus one read per member; the token is coupled to the **Project object record only** — its `projectId`/`name`/`namespace` slots and its indexed member linkage. A member **retarget** rewrites the *member* object under that object's own version and does **not** bump the Project token; a member **add** rewrites the Project's indexed part and does. It is a Project-object version, not a descriptor version. The existing seam's TOCTOU note (*"the require check and the subsequent read are two reads … for a read-only consumer this is benign"*) carries over; the token is what makes a subsequent write safe.

### (a) — second: an authorized rename

```js
authorizedRenameProject({images, imageId, projectId, name, expectedVersionToken, require})
  -> { versionToken }   // the new Project-object token
```

Required behavior, mirroring the read seam and ADR 0042 (how it is implemented is Images' call):

1. Validate `imageId`, `projectId`, `name` (non-empty text), `expectedVersionToken` (**mandatory**; there is no unconditional rename), `require` (function).
2. `require({operation: 'object/write', resource: objectResource(imageId, projectObjectId(projectId))})` **before** any read or existence disclosure. A denied caller learns nothing — the error for a denied+missing Project must be indistinguishable from denied+existing.
3. A missing Project is a distinct not-found error to an **authorized** caller only.
4. A stale `expectedVersionToken` fails with an **opaque stale-token error that never exposes the actual version** (the mutation lane's own rationale: attaching the backend conflict *"would leave actualVersion reachable"*). The environment already maps the name `ObjectMutationConflictError` to its `CommandConflictError`, so reusing that error is the environment's preference, not a requirement.
5. Exactly the `name` slot changes, atomically with its history entry, as the ADR 0042 lane does; nothing else on the record moves.
6. Return the new object-scoped token so further writes can chain.

The seam owns field -> slot translation entirely; the caller passes the semantic word `name`. No Shape id, slot id or backing object id crosses the boundary in either direction.

### Explicitly deferred (not in this proposal)

- add / retarget / remove member — a materially larger authority surface: member object creation (ADR 0062 §4 initial ref slots under per-target edge authority), Project-local key identity, and the per-target `object/edge-write` on the indexed append (ADR 0065 §2); removal is deferred by Images itself (ADR 0062 §8, ADR 0065 §3).
- namespace change — a ref slot.
- delete Project.
- Project-level sequencing across frontier axes (ADR 0073's own deferral list).

## 3. Authority model

- **Operation/resource for (a):** `object/write` on `objectResource(imageId, projectObjectId(projectId))` — the same resource the read seam requires `object/read` on. Renaming a Project is writing the Project object; no new operation name is needed.
- **Members, two distinct things.** `object/write` on the Project object confers nothing over member **targets** (ADR 0073: structure never widens authority; ADR 0042 §7: a mutation never follows a ref). Whether it covers the Project's own backing member **records** is the write analogue of Images' unit-level Project read rule (`working-state.js`: *"ONE authorized `object/read` on the Project object authorizes reading the Project's own backing member records … NOT a transitive ref-follow"*). **Rename does not require deciding that** — it touches only the Project object — and this proposal does not ask for it (see Q4).
- **Authorize before any read or write**, in both seams (ADR 0042 §4 ordering; the read seam's no-existence-oracle property).
- `require` is caller-supplied, check-only, over a live transient context (ADR 0037); the environment bridges it exactly as `readProject` does today and never constructs a demand.

## 4. Identity and versioning

- The Project's **identity is `projectId`**; `name` is a mutable label. Release identity is unaffected: ADR 0073's proof list already requires *"canonical release identity independent of source refs/order/display name"*, and `releaseBody` (`src/project/model.js`) is `{projectId, profileId, members, dependencies}` — `name` is not part of it.
- Consequence worth deciding explicitly: `createProject`'s replay check compares the existing `projectId` **and** `name` (not `namespace`) and throws *"already exists with different identity"* on divergence. After a rename, a replayed `createProject` carrying the original name would throw. Proposed: replay identity keys on `projectId` alone. Images' call.
- Version token: ordinary object-scoped token, mandatory on rename, returned by both seams.

## 5. Atomicity and failure

One object, one slot, one expected-version write: the same atomicity the ADR 0042 lane has. A conflict leaves the Project unchanged and surfaces the opaque stale-token error; an authority denial leaves it unchanged and surfaces the authority error before any read.

## 6. Guardrails (mirroring the ADR 0042 style)

```text
rename == object/write on the Project object        (no new operation; nothing over member targets)
authorize before any read or existence disclosure   (denied+missing == denied+existing)
expectedVersionToken is mandatory                   (no unconditional rename)
stale token -> opaque conflict error                (actual version never reachable)
the seam owns field -> slot                          (caller passes the word `name`, never a slot id)
no Shape id / slot id / backing object id crosses   (either direction)
token beside the descriptor, never inside it        (canonical descriptor keeps its exact keys)
token and the Project object record from ONE read   (ADR 0068's rule)
name is a label, never identity                     (release identity unaffected)
namespace / members / delete stay deferred
```

## 7. Alternatives the environment considered (so they need not be re-proposed)

- **A. An Images-installed Project-specific `image-mutation-binding/v1`** (`name -> <slot>` map owned by Images). Cheapest-looking. It still needs a version token for the Project object, and the only generic token source — the ADR 0068 whole-record read — discloses the slot ids the map exists to hide. So A collapses into needing (b) anyway, and additionally forces the environment to pass `projectObjectId(projectId)` as an `objectId` and to generalize its adapter's single-purpose mutation type declarations. Acceptable only if paired with (b) and if Images is content that the environment names the Project **object id** (`projectObjectId` is public, and the environment's control-plane compositions already use it for grants).
- **B. A `projectVersion` inside the canonical descriptor.** Not asked for: it would require relaxing `normalizeProjectDescriptor`'s exact-key, frozen contract, and a transient concurrency token does not belong in a canonical record.
- **C. A general plain-JS "authorized semantic write" family**, of which rename is the first member. Honest note: every authorized **write** in Images today is a callable-binding lane (ADR 0042/0062/0065/0067); the only plain-JS `require`-injected seam is the Project **read**. Ask (a) would be Images' first plain-JS authorized write. The environment is equally happy with a binding-shaped rename **if** it still hides slots and returns tokens; what it asks is that the **family** shape be settled once, because add/retarget-member will want the same.

## 8. What the environment will consume

- `ImageClientAdapter.readProject` (or a sibling) returns `{descriptor, versionToken}`; the browser holds the token as **transient** state beside its active subject (never in a Presentation, descriptor, durable intent or SemanticUi document), replaced on each authorized reread, cleared on retarget/error.
- `ImageClientAdapter.renameProject({imageId, projectId, name, versionToken, authority})` bridges `require` exactly like `readProject` and knows no slots; a composition-registered `rename-project` Command dispatches through the ordinary Command path; a stale token maps to the environment's `CommandConflictError`.

Until (b) lands the environment cannot hold a Project token without learning storage ids; until (a) lands it cannot rename. Roadmap Phase 4's first editing item is blocked on this contract.

## 9. Open questions for the Project owner

1. Shape of (b): a new sibling `authorizedReadProject -> {descriptor, versionToken}`, or an options flag on the existing seam? The environment prefers the sibling (the existing return shape stays stable for read-only consumers).
2. Plain-JS seam (mirroring the read) vs a callable-binding lane for (a) — and whether to settle the family shape now (§7 C).
3. `createProject` replay identity after a rename (§4).
4. Whether `object/write` on the Project object should later cover the Project's own backing member records (the write analogue of the unit-level read rule) and/or member add/retarget on the indexed part, or whether those get the ADR 0062/0065 edge treatment — not needed for rename, but it determines whether (a)'s resource choice is future-proof.
