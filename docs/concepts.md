# Core concepts

## Image

The Image is the persistent computational world and therefore the workspace.

The environment does not own image storage or image identity. It observes and invokes objects through public Lagrange Images contracts.

Durable environment semantics also live in the Image as ordinary objects. Perspectives are the first implemented example; Themes, DesignTokens, EnvironmentProfiles and the EnvironmentCatalog follow the same rule (ADR 0015). There is no separate durable settings/theme store beside the image.

## Project

A Project is language-neutral semantic organization inside an image: a useful root or relationship structure for code, notes, tasks, data, artifacts and other Projects.

The **durable Project model belongs to Lagrange Images**, because Projects must be usable by headless agents, compilers/tooling, import/export services and alternate frontends. Images exposes an authorized canonical `ProjectDescriptor`; this environment consumes it without copying membership into a second model.

The current `ProjectBrowser` owns Project-specific browsing orchestration: authorized version-aware descriptor read, exact-one Project Presentation selection, open/refresh/follow requests, current-descriptor member-key resolution, and the transient Project edit-token pairing. SemanticUi projects the same Project presentation into browser DOM and native GTK controls. Activating a member uses the ordinary EnvironmentShell -> ObjectNavigator path; membership never supplies target authority. The first edit vertical renames a Project through an ordinary composition-registered Command and the Images-owned ADR 0080 seam, then performs a fresh authoritative reread. Project creation/member/namespace editing, working views, history/diff/merge UX, collaboration and sharing commands remain later work.

Projects do not recreate filesystem assumptions. An object may participate in several Projects or relationships, and Project composition does not imply exclusive ownership.

## Presentation

A Presentation answers: **how should this subject appear in this context?**

It carries enough semantic identity that selecting or invoking on the rendered result can recover the subject rather than merely a string or pixel region.

A subject may have many simultaneous presentations. Presentation state should be split carefully between durable intention and transient rendering state.

A presentation is neither the object nor an authority token. It does not own concrete appearance values; a semantic appearance role may be named only where necessary, while Theme resolution remains renderer-neutral and renderer adapters materialize native values.

## Command

A Command answers: **what operation can be attempted on this semantic subject?**

Commands are first-class environment objects so invocation can be decoupled from individual widgets.

Useful properties to explore later include:

- stable command identity
- applicability predicates
- arguments and argument presentations
- result presentations
- undo/compensation metadata where the underlying operation supports it
- discoverability/menu grouping
- key/gesture bindings as separate policy
- command composition/macros

Authorization is deliberately not on this list. A command may be visible/applicable while the protected operation is denied below the environment.

## EnvironmentCatalog

The EnvironmentCatalog is the one well-known ordinary image object through which shared environment defaults are discovered.

It is provisioned idempotently with the environment package/schema, not opportunistically by user Sessions. Its initial responsibility is small: point at the canonical default Theme and the set of stock Themes. Future shared defaults belong here only when they truly need an image-level discovery point.

The catalog is not a settings service and confers no authority to the objects it references.

## Theme and DesignToken

A Theme answers: **what renderer-neutral visual language should the environment use?**

A Theme is an ordinary image object graph. Its semantic token definitions are ordinary `DesignToken` child objects, and it may refer to a base Theme for inheritance/derivation.

Typical semantic token paths include:

- `surface` / `surface.raised`
- `text.primary` / `text.secondary`
- `accent`
- `selection`
- spacing/density roles
- typography roles
- border/radius/shadow roles
- motion roles where relevant

A DesignToken carries a stable semantic path, a type and its ordinary value data. Complete Theme authority must not be hidden in one opaque CSS/DTCG blob.

DTCG is the preferred interchange projection for compatible design-token types; Penpot, Style Dictionary and similar tools may import/export that projection. The Theme/DesignToken object graph remains authoritative.

`ThemeResolver` owns inheritance, token override/type validation and the resolved semantic token set. Renderer adapters only realize that result in native mechanisms such as CSS custom properties or GTK style values.

Because Theme/DesignToken state is ordinary image state, live edits use the ordinary authorized observation/live-query path rather than polling or a theme-specific change channel.

## EnvironmentProfile

An EnvironmentProfile answers: **what durable environment preferences has this principal deliberately chosen in this image?**

It is an ordinary image object which may refer to a selected Theme, a default Perspective and future durable preferences. It contains an opaque external `principalKey` only to associate the data with the authenticated principal.

The profile is **not identity and not authority**. Authentication/principal identity stay in the trusted control plane; a profile object cannot authenticate somebody or grant access merely because its `principalKey` names them.

No profile is created just because a principal opens an image. If none exists, catalog defaults apply without a write. The default profile is created lazily on the first deliberate durable personalization through the one ProfileResolver interaction, with uniqueness-safe creation rather than shell read-then-create.

## Perspective

A Perspective answers: **what am I working with, and how do I want to see it?**

Typical durable contents may include:

- a subject/root or query
- chosen presentations
- composition/layout
- pinned/bookmarked objects
- semantic selections worth preserving
- tool configuration which expresses user intention

A Perspective should avoid storing incidental client mechanics.

Perspectives can support several modes without changing the object model:

```text
personal development perspective
shared incident perspective
published dashboard
language-learning perspective
operations perspective
notebook-like investigation
spatial/diagram perspective
```

A durable Perspective is persisted as ordinary image data (ADR 0012); neither the Perspective nor its refs confer authority.

## Session

A Session answers: **what is happening in this client right now?**

Examples:

- pointer/hover target
- open popup/menu
- caret and IME state
- drag operation
- animation progress
- local scroll inertia
- renderer cache
- temporary focus

Sessions may know the authenticated user-facing principal and active Perspective, but they should not turn a lower-level authority context into storable program data.

## Compositor

The Compositor arranges presentations. It should be less opinionated than a conventional window manager.

Possible policies include overlapping windows, tiling, nested panes, documents, notebooks, spatial canvases and focused single-view modes. They should compose the same semantic presentations rather than require different application APIs.

## Tools are compositions, not applications

An inspector can be a Presentation plus Commands. A code browser can compose several presentations over class/method objects. A debugger can present activation/process objects and attach commands to them.

The architectural test is whether a domain-specific tool can be built using the same public mechanisms as the built-in inspector. If built-in tools require privileged internal paths, the model is probably incomplete.
