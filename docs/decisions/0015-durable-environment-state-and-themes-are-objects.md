# ADR 0015: Durable environment state, themes and user preferences are ordinary image objects

## Status

Accepted.

## Context

The Object Environment is meant to make an image directly inhabitable. It must not gradually grow a second durable configuration world beside the image just because some state is conventionally called UI configuration, preferences, a theme, a design system or defaults.

ADR 0001 says the Image is the workspace. ADR 0008/0012 proved the same rule concretely for Perspectives: durable environment intention is represented as ordinary image objects/object graphs, while Session and renderer machinery stay transient. This ADR generalizes that rule.

The immediate forcing case is theming. The environment needs a renderer-neutral way to express appearance, reuse existing design-system tooling, let users visually modify themes, and eventually let multiple sessions observe theme changes. A JSON/CSS configuration file or a DTCG blob held outside the image would be convenient, but it would create a shadow durable model that ordinary object inspection, references, history, observation and collaboration could not see.

Identity is a second forcing case. ADR 0005 correctly keeps authentication and principal/group identity in the trusted control-plane identity layer. The environment nevertheless needs durable preferences associated with the authenticated principal. Treating those preferences as control-plane account settings would again create a second durable state model.

Finally, some environment objects must exist before an individual user has created anything: the canonical default theme and the object through which shared defaults are discovered. Their lifecycle must be explicit so normal sessions do not race to create duplicates or silently manufacture hidden in-memory defaults.

## Decision

### 1. Object-native durability is an environment invariant

Every durable semantic thing owned by the Object Environment is represented as ordinary Lagrange image objects and references between them.

Examples include Perspectives, Themes, design tokens, environment profiles/preferences and future durable environment defaults. There is no separate settings database, preference file, browser-local durable authority, CSS file or JSON document that is the source of truth for those semantics.

This does **not** mean transient mechanics become objects. Session state, renderer handles, GPU resources, caches, open menus, hover state and other runtime-only machinery remain transient exactly as ADR 0003 requires. Executable implementation code and schema definitions are also not confused with user data. The rule is about durable environment **semantic state**.

### 2. Theme is an ordinary object graph

A Theme is an ordinary image object. Its semantic token definitions are ordinary child objects, not one opaque whole-theme JSON blob.

The initial conceptual graph is:

```text
Theme
  name
  baseTheme? -----------> Theme
  tokens[]  ------------> DesignToken

DesignToken
  path                  # e.g. surface.raised, text.primary, spacing.normal
  type                  # color, dimension, fontFamily, duration, ...
  value                 # ordinary leaf values and/or refs appropriate to the type
```

The exact Shape representation is an implementation decision constrained by the ordinary Images Value/ref model. Composite token values may use ordinary leaf fields or small child objects where needed, but the environment must not collapse the complete theme into an opaque serialized authority.

Token names are semantic (`surface.raised`, `text.primary`, `accent`, `selection`, etc.), not renderer-specific (`css.background`) and not palette-implementation names such as `blue-500` where semantic meaning is required.

Theme inheritance/derivation is expressed with ordinary refs. A custom Theme may refer to a base Theme and override only selected token paths. The resolver must reject inheritance cycles and type-incompatible overrides rather than guessing.

### 3. DTCG is an interchange projection, not the source of truth

The W3C Design Tokens Community Group format is the preferred external interchange representation for compatible token types. Penpot, Style Dictionary and similar open-source tooling may import/export or transform that projection.

The direction is:

```text
Penpot / DTCG / Style Dictionary
           ^       |
           |       v
      import/export adapter
           ^       |
           |       v
 Theme + DesignToken object graph     <- durable authority
           |
           v
       ThemeResolver
        /        \
       v          v
 DOM variables   GTK/native values
```

A DTCG document can therefore be generated from, or applied to, an object graph. It is never an independent durable theme whose values can drift from the image objects.

### 4. One owner resolves theme semantics; renderers only realize them

`ThemeResolver` is the single environment owner of Theme inheritance, token-name lookup, token-type validation and the resolved semantic token set for a given Theme ref.

Renderer adapters own only native realization of that resolved set. For example, a browser adapter may materialize CSS custom properties and a GTK adapter may materialize GTK CSS/custom properties. They must not own a second set of semantic default values.

Presentations/SemanticUi may name stable semantic appearance roles when a real consumer requires a distinction that cannot be derived from the semantic node itself. They never carry concrete CSS, GTK style strings, colors, font families or other renderer-specific appearance values.

No renderer framework (PatternFly, Carbon, Web Awesome or another toolkit) becomes the semantic theme owner. Such systems may supply inspiration, components or token mappings behind a renderer boundary.

### 5. User preferences are ordinary `EnvironmentProfile` objects

Authentication and principal identity remain external per ADR 0005. A durable user-facing environment profile is ordinary image data and does **not** become an identity or authority object.

Conceptually:

```text
EnvironmentProfile
  principalKey          # opaque external principal identity key; descriptive, not authority
  theme? --------------> Theme
  defaultPerspective? --> Perspective
  ... future durable environment preferences as ordinary fields/refs
```

The authenticated Session supplies the external principal identity. A `ProfileResolver` is the single owner of mapping that identity to the principal's default `EnvironmentProfile` in an image.

The `principalKey` cannot authenticate anybody, confer authority or substitute for the control-plane principal. A forged profile object with somebody else's key has no security effect. Reads and writes still use the normal authorized image paths.

The initial profile scope is image-local. Cross-image sharing/reuse can later be expressed with ordinary cross-image refs if the lower image/authority contracts permit it; this ADR does not invent a global account-settings store.

### 6. Shared defaults are real objects created at environment provisioning time

Each image with the Object Environment installed has exactly one well-known ordinary `EnvironmentCatalog` object in the environment namespace.

Conceptually:

```text
EnvironmentCatalog
  defaultTheme ---------> Theme
  stockThemes[] --------> Theme ...
  formatVersion
```

The catalog and the canonical stock/default Theme graphs are created **once, idempotently, by the environment package/schema provisioning path**, before normal user interaction. The provisioning path may use the trusted installation/control-plane APIs already used to install environment Shapes/classes. After creation these are ordinary image objects with ordinary refs/history/observation semantics.

The catalog has a stable well-known object id in the environment namespace so consumers do not need to scan the image or maintain an external registry merely to discover defaults.

A normal Session must never opportunistically create shared defaults. If provisioning is required, the host invokes the one idempotent provisioner before opening the environment. There is no second "create defaults if missing" path hidden in a renderer or shell.

Stock defaults should be treated as shared prototypes. User customization creates/derives another Theme object; it does not mutate the canonical stock Theme as a side effect of changing one user's appearance.

A release that wants a materially new canonical default should provision the new Theme graph and move the catalog's `defaultTheme` ref deliberately, preserving normal image history. It must not silently change a code-only constant while claiming the same durable Theme identity.

### 7. Per-user objects are lazy; absence means inheritance, not missing bootstrap

Opening an image as a principal does **not** by itself create an `EnvironmentProfile`.

If no profile exists, the effective preference is the catalog default. This lets read-only users inhabit an image without requiring a write merely because they opened the UI.

The default profile is materialized only on the first deliberate durable personalization (for example, selecting a different Theme or saving another user preference). Creation is owned by one `ProfileResolver.getOrCreateDefault(principalKey)` interaction and must be atomic/uniqueness-safe for `(image, principalKey, default-profile-kind)`.

A read-then-create race in the shell is not an acceptable substitute. If the current lower public API cannot provide a uniqueness-safe get-or-create/lookup boundary, that is a named lower-boundary dependency to resolve separately; the Object Environment must not compensate with a UI-local registry or multiple competing creation paths.

### 8. Theme/profile changes use ordinary observation, never polling

Because Theme, DesignToken, EnvironmentProfile and EnvironmentCatalog are ordinary objects, live sessions observe their relevant changes through the environment's normal authorized image observation/live-query path.

A token update re-runs `ThemeResolver` and causes renderer adapters to realize the new resolved values. A profile theme-ref change similarly changes the effective Theme. The theming subsystem must not introduce polling, filesystem watchers or a special distributed change channel.

The same ref/authority rule applies: observing an invalidation or carrying a Theme ref confers no authority to read it.

## Default-resolution order

The effective Theme for a Session is owned by one resolver and follows this order:

1. If an authorized `EnvironmentProfile` exists and has an explicit Theme ref, resolve that Theme.
2. Otherwise resolve `EnvironmentCatalog.defaultTheme`.

There is no separately hard-coded "real default theme" behind this order. Renderer/native toolkit defaults may exist only as transient mechanics before/while the durable Theme is being resolved; they are not environment semantics and must not be consulted as an alternative source of theme values.

Failures to read or validate an explicitly selected Theme must remain diagnosable; they must not silently rewrite the user's profile or create a replacement Theme.

## Ownership consequences

The intended owners are:

- **Environment provisioning** — sole owner of environment Shapes/classes plus the one `EnvironmentCatalog` and stock default object graphs.
- **ProfileResolver** — sole owner of authenticated-principal -> default `EnvironmentProfile` lookup/lazy materialization.
- **ThemeResolver** — sole owner of Theme inheritance/token resolution/validation.
- **ImageClientAdapter** — remains the sole Object Environment -> Lagrange Images interaction owner; all ordinary reads/writes/observation for these objects route through it.
- **RendererAdapter implementations** — own only native realization of resolved semantic token values.
- **DTCG/tool adapters** — own only import/export transformation between external design-token representations and the authoritative object graph.

No one else may duplicate these interactions locally.

## Consequences

- Theme editing becomes ordinary object editing. The generic inspector can eventually inspect a Theme and its DesignToken children without a special settings database.
- Themes receive normal image history, references, sharing and change observation for free.
- Two Sessions viewing the same authorized Theme can see edits propagate through the same generic live-observation mechanism used for other image state.
- A user's selected Theme can follow them across renderers because the durable preference names a semantic Theme, not CSS/GTK values.
- Penpot/DTCG/Style Dictionary remain useful without becoming architectural dependencies or alternate sources of truth.
- Read-only users do not create profile garbage merely by connecting.
- Shared defaults have one explicit lifecycle and identity instead of being recreated by every client.
- Principal/profile association remains non-authoritative data and therefore does not weaken ADR 0005.
- A missing lower uniqueness primitive for lazy profile creation is exposed as a real boundary requirement rather than hidden by an unsafe local workaround.

## Rejected alternatives

- **Store the theme in CSS/GTK files.** Rejected: renderer-specific and outside the image's durable object/history model.
- **Store one DTCG JSON blob as the Theme authority.** Rejected: useful interchange, but too opaque as the environment's semantic object model and an easy route to a shadow configuration subsystem.
- **Create a full profile/theme copy for every principal on login.** Rejected: creates writes/garbage for users who never customize anything and prevents read-only use.
- **Keep preferences in the identity provider/control plane.** Rejected for environment semantics: identity authenticates the principal; it does not need to become a second object-environment database.
- **Let each renderer choose its own defaults.** Rejected: visual meaning would drift between DOM, GTK and future renderers.
- **Have the shell read-then-create missing shared/user defaults.** Rejected: duplicate creation under concurrency and a second owner for bootstrap semantics.
