# Proposal: indexed-part lanes for ordered object collections (Perspective persistence)

**Status:** proposal from `lagrange-object-environment` to the `lagrange-images` owner. Not yet an ADR in either repository. Per environment ADR 0002, this proposes a missing image-level contract downward; the environment does not shadow it.

**Requested owner:** the `lagrange-images` owner. Environment-side consumption stays with `ImageClientAdapter`.

> **Cross-repo numbering note:** this document references *environment* ADR 0008 (`lagrange-object-environment` — the Perspective representation) and *substrate* ADRs 0035/0042/0046/0047/0062 (`lagrange-images`). The two repos number ADRs independently; substrate ADR 0008 is unrelated (WASM).

## 1. The need

The environment's headline Phase 1 deliverable is *save/load a Perspective as ordinary image data*. Environment ADR 0008 defines a Perspective as one image object holding: a `subject` ref (edge), an ordered `presentations` array of records `[{id, kind, subject(ref), context(JSON), state(JSON)}]`, and JSON metadata `{title, layout, formatVersion}`.

The authorized creation lane (`image-creation-binding/v1`, substrate ADR 0062) **cannot persist this encoding**, for reasons that are *decided substrate invariants*, not v1 oversights:

- **Nested values are excluded from the Value model.** Substrate ADR 0035: *"No `list`, `record`, `tuple`, `option` or `result` Value kind is introduced, now or as a consequence of anything below."* The lane enforces this (`image-creation-binding.js:131-135`, "v1 does not write nested values"). So the ordered `presentations` array cannot be a field.
- **Refs may not be buried in composites.** The flat graph walker resolves edges only through slot/indexed Values; a ref inside a composite is an *invisible* graph edge (substrate ADR 0035 §3; `composite-codec.js` `assertRefFree`). So a presentation's `subject` ref could not travel inside a nested array even if nesting were allowed.
- **No authorized metadata-write lane exists.** Creation hardcodes `metadata: {}` (`image-creation-binding.js:323`); mutation preserves metadata but never writes it. So `title`/`layout`/`formatVersion` have nowhere authorized to live.

**Consequence the environment accepts:** ADR 0008's chosen encoding is unimplementable through any near-term authorized lane. An environment-side ADR 0008 amendment is **unavoidable** — no substrate change smaller than "new Value kinds + a non-flat walker" would deliver it, and that contradicts decided substrate ADRs. This proposal does **not** ask for that.

## 2. What the substrate already has: indexed parts

The object model already supports an **ordered collection of refs with full walker visibility**: the indexed `VALUES` part (substrate ADR 0047).

- An indexed element is a canonical Value — *including `ref`/`pinned-ref`* (ADR 0047 §3).
- An indexed ref is a graph edge *everywhere* an edge is read: `referencesOfRecord` walks `record.indexed` (`graph/references.js`). So an ordered list of presentation refs in the indexed part is first-class, walk-visible structure — exactly what ADR 0008's `presentations` array semantically needs.

**The gap is at the interface, not the model.** ADR 0047's deferred list names it directly: *"projecting or mutating an indexed part across a callable interface."* Today:

- the **creation** lane only ever creates a *zero-length* indexed part (`image-creation-binding.js:310`); there is no interface to supply initial indexed elements;
- the **mutation** lane preserves the indexed part verbatim but cannot write it (`image-mutation-binding.js:233-237`);
- the **projection** lane *refuses* indexed objects outright (`image-projection-binding.js:124-127`, "v1 maps named slots only").

So the substrate's native ordered-ref collection is unreachable through every authorized lane.

## 3. The proposal

### 3.1 Substrate ask: extend the authorized lane surface for indexed parts

The smallest, precedented change: let the authorized lanes **create and read indexed parts**, per ADR 0047's deferred item.

1. **Creation with initial indexed elements.** Allow the creation lane's value record to supply initial indexed-element Values. Each indexed `ref`/`pinned-ref` element authorizes via the **existing per-target `object/edge-write` pattern** (substrate ADR 0062 §4) — a grant scoped to each target id, so narrow authority cannot become broad reach. This is a natural extension of §4, not a new operation.
2. **Indexed-aware read** (projection or an `object/read`-level path) so a client can read back the ordered collection. Until the projection lane supports indexed objects, the environment reads back via `object/read`-level access; this proposal notes the dependency explicitly rather than assuming projection support.

This is deliberately narrow. It does **not** touch ref-visibility, the Value model, or metadata semantics — it un-defers one interface boundary on a model the substrate already decided.

### 3.2 Environment-side ADR 0008 amendment (owned by the environment)

The premise behind ADR 0008's "one durable unit / presentations-as-data" decision has changed: that encoding cannot be persisted through any authorized lane. ADR 0008's rejection of "each Presentation its own image object" was explicitly conditional (*"until shared/reusable presentations become a real requirement"*). The environment will amend ADR 0008 so that:

- **Each presentation becomes a child image object**: `subject` as a ref edge slot; `id`/`kind` as leaf text slots; `context`/`state` as **ref-free JSON serialized in leaf text slots**. (Refs stay in slots/indexed; the JSON is ref-free scalar data — the same rule as metadata, relocated to text slots because no metadata-write lane exists and none is needed.)
- **The Perspective** holds its `subject` ref slot and the **ordered list of presentation refs in its indexed part** (once the substrate lane lands).
- **`title`/`layout`/`formatVersion` move from metadata to leaf text slots.** `formatVersion` becomes its *own* slot — more visible and greppable, not less. A metadata-write lane is therefore **not** requested.

### 3.3 What this proposal does NOT ask for

- **Nested composite writes** — contradicts substrate ADR 0035's Value model ("no `list`/`record` Value kind").
- **Refs inside composites** — violates the flat-walker invariant.
- **A metadata-write lane** — unnecessary once `title`/`layout`/`formatVersion` become slots.
- **Multi-record transactions** — remain deferred (see §4).

## 4. Honesty about what v1 costs

**Sequential creation, not atomicity.** Saving a Perspective creates 1 + N objects (presentations, then the Perspective). Without multi-record transactions (substrate ADR 0062 §8, deferred), this cannot be atomic. The environment mitigates by **ordering**: create presentations first, the Perspective last — so the *Perspective object is the commit point*. Observers on the change feed (environment ADR 0009) may see orphan presentation objects, but never a half-built Perspective that references not-yet-existing children. Each individual creation is atomic (insert-only, `putWithHistory`). This is a real degradation from ADR 0008's "one durable unit" and is stated plainly; multi-record transactions are the deferred substrate work that would remove it. (This is the same partial-observability argument the environment's *first* proposal used to reject two-step create-then-attach — consistency requires naming it here.)

**Interim readability.** Until the projection lane supports indexed objects, an indexed Perspective cannot be projected through `image-projection-binding/v1`. The environment reads back via `object/read`-level access (already authorized) or waits for the indexed-aware read in §3.1. This dependency is explicit.

## 5. Falsification

What would prove this proposal wrong:

- The substrate owner rules that indexed-element edges need a **new** operation rather than reusing per-target `object/edge-write` — that changes §3.1's "no new operation" claim.
- The substrate owner rules that **JSON-in-leaf-text-slots is shadow semantics** — rebuttal: refs stay in slots/indexed, the JSON is ref-free scalar data, exactly the metadata rule relocated; but if rejected, the environment needs another answer for `context`/`state`.
- The indexed part turns out **not** to be walk-visible as the environment assumes — refuted by `graph/references.js` today, but the proposal rests on it.

## 6. Open questions for the substrate owner

1. Is reusing per-target `object/edge-write` for indexed ref elements the right authorization, or does an indexed collection want its own grant shape?
2. Should indexed support land as create-with-initial-elements, indexed-aware mutation, or both? (ADR 0047 defers "projecting **or** mutating" as one item.)
3. Is the projection lane's indexed refusal to be lifted as part of this, or is an `object/read`-level read sufficient for the first consumer?

## 7. References

- Environment ADR 0008 (Perspective representation, to be amended); environment ADR 0009 (change feed).
- Substrate ADR 0035 (callable interface / Value model / ref-free composites), ADR 0042 (mutation lane), ADR 0046 (`basicNew` / class-scoped creation), ADR 0047 (indexed object parts; deferred "projecting or mutating an indexed part across a callable interface"), ADR 0062 (creation lane; per-target `object/edge-write`).
