# Stock Theme installation

`createEnvironmentProvisioner` installs the first compact Smalltalk workbench
Theme as ordinary image objects (ADR 0015). This T1 surface is trusted Node
installation, independent of the Smalltalk kernel. It does not select an
effective Theme, create profiles, style a renderer or grant access to data.

The trusted composition supplies Images' public `./graph` provisioning functions
and public canonical Value constructors to `createImageProvisioningPort` from
`src/image-client-adapter.js`. Pass that frozen capability to
`createEnvironmentProvisioner(port)`, then await
`provisioner.provision({imageId})` before normal interaction. Success returns the
frozen locator `{imageId, objectId: 'environment/catalog'}`. Knowing this locator
confers no authority. Ordinary adapters, Sessions and renderers do not expose
the provisioning port, and opening a Session performs no installation.

The port is generic. EnvironmentProvisioner alone supplies the schema, stock
identity, installation order and catalog-domain validation. Images' public
graph owner alone decides exact equivalence, insert-only concurrency and seed
adoption. Public provisioning errors propagate unchanged.

## Durable layout

All slot ids equal their names. Shapes are versioned; stock ids include the
stock release. There are no classes, Behaviors, JSON blobs or kernel nil refs.

| Shape id | Named slots | Indexed part |
| --- | --- | --- |
| `environment/shapes/catalog/v1` | `format`, `defaultTheme` | stock Theme refs |
| `environment/shapes/root-theme/v1` | `format`, `name` | DesignToken refs in lexical path order |
| `environment/shapes/derived-theme/v1` | `format`, `name`, `baseTheme` | DesignToken refs |
| `environment/shapes/design-token/v1` | `format`, `path`, `type`, `value` | none |

The catalog id is `environment/catalog`, with format `environment-catalog/v1`.
Its initial default and stock list refer to
`environment/themes/smalltalk-workbench/v1`, named `Smalltalk Workbench` with
format `environment-theme/root/v1`. A root has no base slot. A derived Theme has
format `environment-theme/derived/v1` and one same-image, unpinned `baseTheme` ref.
Its tokens override paths in its base. The derived Shape is installed before the
stock graph, but no derived object is created by installation. Upgrading a T1
installation adds this one Shape without rewriting any existing record.
Authorized creation remains separate: classless trusted installation does not
establish that the authorized creation lane can create these graphs.

Each token id is the stock Theme id followed by `/tokens/` and its semantic path.
Its format is `environment-design-token/v1`; path and type are text Values and
value is one text or integer Value.

| Path | Type | Stock value |
| --- | --- | --- |
| `accent` | color | `#245a81` |
| `focus` | color | `#b45a16` |
| `radius.normal` | dimension | 0 |
| `selection.background` | color | `#245a81` |
| `selection.text` | color | `#ffffff` |
| `spacing.compact` | dimension | 2 |
| `spacing.normal` | dimension | 6 |
| `surface.base` | color | `#e6e6e2` |
| `surface.raised` | color | `#f5f5f0` |
| `text.muted` | color | `#56616a` |
| `text.primary` | color | `#1c2428` |
| `typography.code.family` | fontFamily | `monospace` |
| `typography.code.size` | fontSize | 13 |
| `typography.ui.family` | fontFamily | `sans-serif` |
| `typography.ui.size` | fontSize | 13 |

Colors are lowercase `#rrggbb`, 8-bit sRGB with full opacity. Dimensions are
nonnegative integers and font sizes positive integers in logical layout units
before device scaling. Generic families are `monospace` or `sans-serif`.
EnvironmentProvisioner defines this release's stock data; [ThemeResolver](theme-resolution.md)
owns validation of token semantics. Classic Smalltalk `←` assignment and
`↑` return rendering is a separate syntax-aware source projection requirement
(Bead 0k7.3), not a token, font substitution or parser change in T1.

## Replay, conflicts and partial installation

Installation requests exact Shapes, exact Tokens sorted by path, the exact root
Theme, then a seed catalog. Identical replay writes nothing, including no
stored-version change. A divergent stock occupant is a public
`ProvisioningConflictError` and remains unchanged. Shape equivalence follows
Images' layout comparison; provenance metadata does not change that contract.

The catalog is mutable. A same-image unpinned default ref and legal stock list
are preserved, even when they differ from the initial defaults. Installation
does not dereference them: their readability and availability belong to later
authorized resolution. A wrong catalog kind, Shape, format, slot layout, default
ref or indexed ref is refused unchanged. Pinned and cross-image catalog refs
are outside this initial domain.

Installation is monotonic, not an atomic graph transaction. Failure may leave
Shapes and Tokens installed, but it never deletes them or reports completion.
A subsequent invocation resumes through the same insert-only owner. A returned
catalog locator is the completion signal; a pre-existing catalog alone is not
proof that an interrupted invocation finished.

`test/environment-provisioner.integration.test.js` proves the complete graph
through pinned public Node APIs, replay of every stored field/version,
per-object authorized reads of catalog/root/every token, child denial, stock
conflicts, partial resume, catalog preservation/refusal and ordinary startup
without provisioning. The generic read binding is installed directly; no
kernel or probe class is introduced for these proofs. These are direct reads,
not DOM/GTK appearance acceptance. Explicit inheritance and authorized traversal
are now proven separately by ThemeResolver. Portable provisioning, effective
selection, authorized creation, observation and renderer realization remain
separate work.
