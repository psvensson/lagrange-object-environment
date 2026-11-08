# Explicit Theme resolution

`createThemeResolver({readObject})` resolves an explicitly selected Theme through
`ImageClientAdapter.readObject`. Call
`resolver.resolve({themeRef, authority, blockId})` with a same-image unpinned ref
and the ordinary object-read binding. The exact caller authority and binding
are passed to every reached Theme and DesignToken read. A readable parent never
authorizes its children. Lower denied, unavailable and backend errors propagate
unchanged; malformed Theme data throws `ThemeResolutionError`.

The authorized projection contains only `slots`, `indexed` and an opaque
`versionToken`. Resolution validates the visible format and field contract from
[Theme installation](theme-installation.md); it does not infer stored Shape,
kind, behavior, identity or revision. Trusted installation owns Shape identity.
The requested ref identifies each read; the Images binding owns selecting that
object and checking access before existence.

Root Themes contain token refs. Derived Themes also name one base Theme. The
resolver traverses bases iteratively, rejects cycles and validates every token,
including shadowed tokens. Within a Theme, duplicate paths and duplicate token
refs are errors. A nearer derived definition wins over the same path in its
base. Shared token refs across different Themes are read again through the
authorized boundary.

This first version requires all fifteen semantic paths listed in the installation
document, with exactly their declared types. Unknown paths and incompatible
types fail the entire resolution. Colors are lowercase opaque `#rrggbb`; layout
dimensions are nonnegative safe integers; font sizes are positive safe integers;
font families are `monospace` or `sans-serif`. These are semantic values, with no
CSS or GTK property names. Missing paths never obtain values from code or another
Theme implicitly.

The result is deeply frozen:

```js
{themeRef, tokens: [{path, type, value}, ...]} // lexical path order
```

Integer Values become JavaScript numbers only after range validation. The result
contains no authority, version tokens, renderer handles or image services.
Each call rereads the graph. These are sequential authorized observations, not
an atomic multi-object snapshot. There is no cross-call cache, write, default
creation or automatic substitution after failure.

This implements explicit inheritance and validation from ADR 0015. Effective
selection through EnvironmentProfile/EnvironmentCatalog, aliases, live
observation, authorized customization and DOM/GTK realization remain separate
work. No renderer is styled merely by creating a resolver. Classic Smalltalk
`←` and `↑` are handled by the separate source-projection boundary.

`test/theme-resolver.integration.test.js` uses real public Images APIs, its
authority service and actual generic read binding with mock storage. It proves
stock values, conflicting multilevel overrides, shadowed denial/malformed data,
missing graphs and paths, cycles, immutable output, fresh rereads and unchanged
stored records/versions. It makes no physical-cluster or native appearance claim.
