# ADR 0016: One semantic browser exposes first-class documentation as a common facet

## Status

Accepted as architectural direction. Implementation is deliberately DEFERRED, and remains so: E2 (live native class/method navigation) merged on 2026-09-05, satisfying the first activation condition, but the second — a real source/documentation consumer supplying pressure — is not met. Note also that Images truthfully reports `source: null` and `provenance: null` for a native method today, so there is no authoritative source or documentation content for this facet to display; E3's own readiness audit records that as a lower dependency rather than an Environment gap. This ADR is direction, not a licence to start.

## Context

The Object Environment is growing its first language-oriented browser through the Cuis-first native-import vertical. Images deliberately makes a successfully imported Cuis class or method an ordinary native Smalltalk semantic entity. The Environment has therefore been able to browse Cuis-origin classes and methods through the same native Smalltalk path rather than creating a Cuis IDE beside a Symmetric Smalltalk IDE.

That is the architectural direction we want to preserve as additional languages arrive: one browser model and interaction loop, with language personalities contributing only the semantic facets and Commands that really differ.

Documentation is an especially useful forcing case. Traditional Smalltalks commonly store class comments, and most languages have some source-comment or doc-comment convention. Making those language-specific comment forms the Object Environment's primary documentation model would couple a generic human-facing capability to source syntax, force languages without equivalent comment conventions into different UX, and mix two things with different lifecycles:

- executable/source representation;
- explanatory documentation about a semantic code entity.

Lagrange already has a better place for durable semantic information: the image. The Object Environment can therefore present documentation beside source without requiring the documentation to be embedded in the source text at all.

This ADR decides the Environment-side architecture. It does **not** define or implement the lower durable Documentation/attachment representation; that belongs below this repository because headless clients, agents, history/search and collaboration need the same semantics.

## Decision

### 1. There is one semantic browser architecture

The Object Environment has one browser interaction/composition model for code and other semantic subjects.

Language personalities extend that browser. They do not introduce parallel browser architectures.

The common browser owns or composes generic concerns such as:

- logical view/composition lifecycle;
- selection and semantic navigation;
- navigation history/breadcrumb policy when implemented;
- authorization/error presentation;
- command discovery/invocation;
- common facets such as Documentation, History, References and Tests when those exist;
- renderer-neutral SemanticUi realization;
- live refresh through ordinary authorized observation.

A language personality may contribute language-specific semantic facets and Commands, for example:

```text
Smalltalk
  class hierarchy
  class/instance side
  protocols/selectors
  senders/implementors

Common Lisp
  packages/symbols
  functions/macros
  generic functions/methods

JavaScript
  modules/imports/exports
  classes/prototypes/functions
```

Those contributions feed the ordinary PresentationRegistry/CommandRegistry and, when real pressure proves the need, the planned PersonalityExtensionRegistry. A personality must not acquire its own Compositor, selection model, activation router, authority path, durable object store, history implementation or renderer route.

`NativeSmalltalkBrowser` is the first concrete pressure/proof, not a declaration that every language gets a sibling `*Browser`. Extraction of a generic `SemanticBrowser` owner should happen only when E2 plus a second substantially different semantic shape demonstrate the smallest useful common contract.

### 2. Documentation is a common browser facet, not a language personality

Documentation belongs conceptually beside Source, History, References and Tests as a generic facet of a semantic code subject.

The Object Environment should be able to present, for example:

```text
Class / Method / Function / Module / Package / Project
                         |
                         +--> Source facet
                         +--> Documentation facet
                         +--> History facet
                         +--> References facet
```

A Smalltalk method and a JavaScript function should therefore use the same documentation UX even though their language-specific source and member semantics differ.

The browser may realize Source and Documentation side-by-side, vertically, in tabs or according to another Perspective/theme/composition policy. That arrangement is Environment UX, not durable documentation semantics.

### 3. Durable documentation is separate from source

The durable authority for curated documentation must not be a source comment, a Markdown file beside a checkout, browser-local storage or an Environment-side database.

The lower image-level documentation model is expected to support the equivalent of:

```text
Documentation
  title?              optional
  body                textual content initially
  format              e.g. text/markdown

DocumentationAttachment
  target              semantic code subject
  document ----------> Documentation
  role                overview | rationale | example | migration | ...
  scope               entity | exact-revision
```

This is a conceptual requirement, not a storage schema owned by this repository. The exact representation, identity, authority and mutation API belong in Lagrange Images or the appropriate lower semantic owner.

Documentation and attachments should be ordinary durable image semantics so they naturally participate in authorization, history/versioning, replication, observation, Projects, search and collaboration. The Environment must not create a shadow documentation store while waiting for that contract.

### 4. Documentation normally follows the logical entity, with explicit revision-pinned documentation when needed

Most documentation describes a semantic entity over time:

```text
MyClass >> #jsonWriteOn:
  -> overview documentation
  -> examples
```

Changing the current method implementation should not automatically detach that documentation.

Some documentation instead describes one exact implementation/revision, for example a migration note or rationale for a historical implementation. The lower contract must therefore leave room to distinguish:

- **entity documentation** — follows the logical class/method/function/module identity across revisions;
- **revision documentation** — attaches to one exact revision/version identity.

The Environment must not infer one scope from the other.

### 5. One subject may have multiple documents with explicit roles

Do not reduce documentation to one `comment` or `docString` field.

A subject may have independently editable/authorizable documents such as:

- overview;
- design rationale;
- examples;
- migration notes;
- performance notes;
- security notes;
- generated summary.

Roles make those documents separately presentable and allow generated material to remain visibly distinct from curated human-authored documentation.

The initial implementation may support only one or two roles, but it must not choose a representation that makes multiplicity impossible.

### 6. Source comments remain valid, but are optional projections

Language comments/doc-comments continue to work and should survive import/export faithfully where the relevant language semantics require it.

They are not the Object Environment's documentation authority.

A language/import personality may eventually offer explicit operations such as:

```text
import source/class comments -> Documentation attachments
export selected Documentation -> language comment/doc-comment representation
```

Those are projections across a language boundary. They must be explicit and owner-controlled.

There is no automatic bidirectional synchronization between source comments and Documentation objects. Silent synchronization would create two competing authorities and ambiguous conflict semantics.

For Cuis specifically, existing class comments may be imported or shown as source/provenance material, while curated Lagrange documentation can live independently and appear beside the same native class/method.

### 7. Documentation is distinct from discussion, review, work items and diagnostics

The browser may eventually show several adjacent facets, but they have different owners and lifecycles:

```text
Source | Documentation | History | Discussion | Tests | Diagnostics
```

Do not collapse the following into Documentation merely because they are textual:

- source comments;
- review comments;
- chat/discussion;
- TODO/work items;
- runtime/import diagnostics;
- generated explanations.

They may link to or be presented beside the same semantic subject without becoming one annotation blob.

### 8. Documentation reads/writes use ordinary authority and live observation

A documentation ref/attachment confers no authority.

Reading an attached document requires the lower owner's normal authorized read semantics; editing it requires the lower owner's authorized mutation semantics. The Environment passes authority per use through ImageClientAdapter and does not issue, cache or infer grants.

Because documentation is ordinary durable image state, a live documentation view updates through the same authorized observation/live-query mechanism as other image state. No polling, file watcher or documentation-specific distributed channel is introduced.

Two users with authority to the same document should therefore see edits propagate through the same generic invalidation -> fresh authorized reread rule used elsewhere in the Environment.

### 9. Semantic links inside documentation may come later through the same navigation owner

The initial body format may be plain text or Markdown.

The architecture should leave room for semantic links whose target is a real semantic subject rather than only a textual spelling such as `Foo>>bar:`. If/when such links are introduced, clicking them must route through the same generic semantic activation/navigation owner being proven by E2; Documentation does not receive a private navigation mechanism.

The renderer still receives only descriptor-local action keys, never authority or semantic refs in action payloads.

### 10. Missing lower documentation semantics are a named boundary dependency

If the Environment reaches the point where it needs durable Documentation/attachment semantics and Lagrange Images does not expose them, work stops at this repository's boundary.

The Environment should then:

1. record the local blocked Bead;
2. state the exact headless semantic contract needed;
3. send the cross-repository handoff to the owning repository;
4. remain blocked rather than inventing an Environment-local store or deriving documentation identity from source text.

This follows ADR 0002 and the repository's existing cross-repository handoff discipline.

## Ownership consequences

The intended ownership split is:

- **lower durable documentation semantics** — Lagrange Images / the appropriate lower semantic owner: Documentation identity, attachment identity/targeting, entity-vs-revision scope, persistence, authorization, history and mutation semantics;
- **ImageClientAdapter** — the sole Environment -> Images translation/authority bridge once public documentation reads/writes exist;
- **generic browser Documentation facet** — one Environment owner, created only when the first concrete consumer exists; owns human presentation, role selection and edit orchestration, never durable identity or authorization policy;
- **language personality/import/export owner** — explicit source-comment <-> Documentation projection for that language when needed; never generic Documentation storage/UX;
- **EnvironmentShell/semantic activation owner** — any documentation semantic links use the same generic activation route, not a documentation-specific router;
- **RendererAdapter/DOM/GTK** — realize the resolved SemanticUi only and do not own documentation meaning or storage.

The existing `PersonalityExtensionRegistry` remains a language-contribution boundary, not the owner of Documentation itself.

## Consequences

- Smalltalk class comments stop being the architecture for documentation while remaining fully usable language material.
- Languages with very different comment/docstring conventions can share one documentation experience.
- Source can stay concise while rich explanations live beside it.
- Documentation can receive image history, authorization, sharing, observation and search without copying it into source.
- Multiple documents/roles can coexist without inflating source text.
- AI-generated explanations can be stored/presented under a distinct role rather than overwriting curated documentation.
- The one-browser architecture gains a genuinely language-independent facet, increasing confidence that language personalities extend one environment rather than create separate IDEs.

## Rejected alternatives

- **Use source comments/docstrings as the canonical documentation model.** Rejected: language-specific, coupled to source representation and unsuitable as a generic cross-language Environment facet.
- **Synchronize comments and Documentation automatically.** Rejected: creates two mutable authorities with ambiguous conflict and history semantics.
- **Store Markdown files beside projected source.** Rejected as authority: useful interchange/projection, but outside the image's semantic identity/history/authorization model.
- **Create an Environment-local documentation database.** Rejected: a shadow durable subsystem unavailable to headless clients and agents.
- **Give each language its own documentation panel/browser.** Rejected: duplicates generic browser interaction and defeats the one-browser direction.
- **Make one giant annotation object contain docs, discussion, diagnostics and work items.** Rejected: different lifecycle, authority and ownership concerns.

## Future epic seed — create in Beads when activated

This is a planning seed, **not a second task tracker**. Beads remains authoritative. Do not create this epic merely because this ADR exists.

### Activation condition

Create the epic only after:

1. E2's live native class/method navigation is merged and stable; and
2. a real code-detail/source workflow (preferably the selected real Cuis application) needs documentation beside source, or a lower documentation contract already exists and has a concrete consumer.

### Suggested epic

**Generic first-class code documentation facet**

Goal: a semantic code subject can show and edit durable, authorized documentation beside source through the one browser, without embedding documentation in source or creating an Environment-side store.

Suggested dependency-ordered slices:

**D0 — contract investigation / lower-boundary handoff**
- audit existing Images semantics for any reusable generic document/attachment representation;
- specify only the missing headless contract;
- if absent, block locally and send a cross-repo handoff rather than implementing storage here.

**D1 — read-only Documentation facet**
- consume one public authorized documentation read/attachment seam through ImageClientAdapter;
- present documentation beside one real class/method/function subject through generic Presentation/SemanticUi;
- prove the same facet works independent of language origin;
- no editing and no comment import/export yet.

**D2 — editing + live update**
- ordinary Command -> authorized lower mutation -> observation -> fresh reread;
- two live views/sessions converge through ordinary observation, with no polling;
- conflict/denial behavior remains lower-owner truth.

**D3 — first language comment projection (Cuis)**
- explicit import of a real Cuis class/method comment into Documentation OR explicit export in the other direction, whichever the real workflow pressures first;
- no automatic sync;
- prove comment text and Documentation may intentionally diverge without hidden reconciliation.

**D4 — richer generic documentation navigation, only if pressured**
- multiple roles/documents;
- entity-vs-revision-pinned presentation;
- semantic links through the existing activation owner;
- search/history integration through their generic owners.

### Stop conditions

The epic must not pre-emptively build:

- a new generic browser framework before E2/second-language pressure proves the extraction;
- a documentation-specific renderer vocabulary if ordinary SemanticUi is sufficient;
- an Environment-side durable Documentation schema/store;
- background synchronization with language comments;
- AI documentation generation as part of the core documentation contract.
