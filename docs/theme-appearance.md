# Renderer-native Theme appearance (T4)

This slice realizes a ThemeResolver-produced **resolved token array** in browser
DOM and native Linux GTK tool panes (ADR 0015). It is not Theme selection,
provisioning, observation, profile preference, editing, or image storage.

## Host composition boundary

First perform the ordinary, authorized read in Environment/Images:

```js
const {tokens} = await resolver.resolveCatalogDefault({imageId, authority, blockId});
// or: resolver.resolve({themeRef, authority, blockId})
const renderer = createBrowserRendererAdapter({
  loadComponent, mount, resolvedTokens: tokens,
});
```

The browser adapter's optional `resolvedTokens` input is **host composition**
and passes only semantic scalar values. A null input leaves the existing pane
unstyled; it is not a request to instantiate a stock Theme. The adapter owns
lifetime and the DOM realizer materializes all fifteen tokens as scoped CSS
custom properties on its pane root; static CSS rules give those properties
meaning in GTK-independent DOM terms.

Native host composition has the equivalent explicit constructor:

```rust
let adapter = LinuxRendererAdapter::with_resolved_tokens(glb_runner, &tokens)?;
```

The same resolved tokens produce a GTK-owned stylesheet, applied with
`CssProvider` to the actual widget contexts in each pane. Providers are never
registered on the global display; other panes, other adapters and default GTK
surfaces have no implicit Theme. They are retired with the GTK widget tree.
The host's existing six lifecycle operations are unchanged. The GLB Component
path and other non-tool kinds receive no CSS.

## Identity, data and failure boundaries

The input is the fifteen `{path,type,value}` records from
`ThemeResolver.resolve` / `resolveCatalogDefault`. A renderer never receives a
Theme ref, image service, opaque version token or authority. Host-specific
styling code validates the complete resolved token grammar before building
native declarations. Unknown, missing, duplicated, incompatible and unsafe CSS
values fail explicitly, without partial styling or substituting another
palette. The renderer does **not** choose inheritance, precedence or catalog
default: those remain the ThemeResolver's authority.

No semantic `appearance` fields or CSS/GTK values were added to `SemanticUi`.
The same documents, descriptor-local action keys and interaction intents
continue to drive both hosts. CSS custom properties and GTK providers are
transient realizations; neither is a durable source of truth.

## Proof scope

`test/fixtures/theme/{stock,derived}-tokens.json` contain exact outputs proven
against real authorized Images/ThemeResolver integration. Both hosts read
these same fixture bytes. Browser CI uses the production
`BrowserRendererAdapter` path with live `getComputedStyle` assertions for two
distinct Themes plus an unthemed pane, click/intent equivalence and destruction
isolation. Native Linux tests create real GTK widgets, install scoped CSS,
compare computed foreground colors, ensure separate Themes coexist, and
exercise the production `LinuxRendererAdapter` constructor/attach path.
Negative tests reject malformed/injection-capable token values.

This is **static per-Session appearance**. The next milestone is authorized
observation-driven Theme re-resolution and replacement of the current native
realizations without creating a parallel polling or settings system. It makes
no claim about the distributed Lagrange server or published package.
