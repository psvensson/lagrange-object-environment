# Live Theme updates (T5)

T5 connects the existing **authorized Images observation lane** to a single
ThemeResolver traversal and host-native style updates. It does not add a
Theme-specific poller, a second Theme graph, a global CSS/GTK settings store,
or a seventh RendererAdapter lifecycle operation.

## The only data and authority path

The host already owns one `ImageClientAdapter` and a caller authority context.
Give the resolver its ordinary read and observation ports:

```js
const themeResolver = createThemeResolver({
  readObject: request => adapter.readObject(request),
  observe: (imageId, options) => adapter.observe(imageId, options),
  observePull: request => adapter.observePull(request),
});
const following = await themeResolver.followCatalogDefault({
  imageId, authority, blockId: readBlockId,
  observationBlockId, onUpdate: ({tokens}) => renderer.setResolvedTokens(tokens),
  onError(error) {
    renderer.setResolvedTokens(null); // explicit fail-closed withdrawal, not a stock Theme
    reportError(error);              // the product host owns how to surface it
  },
});
try {
  // The view continues to receive authorized Theme updates.
} finally {
  following.stop();
  await following.done;
}
```

For an explicitly selected Theme, use `followTheme({themeRef, ...})` with the
same authority, block ids and callbacks. The follow handles are transient
and return `{stop, signal, done}`. A failed initial read or failed initial
render rejects the follow start. Later errors are passed to the required
`onError` callback, then follow terminates. No implicit fallback is attempted.

The **underlying Images feed is pull-based**, not a push subscription:
`ImageClientAdapter.observe` already uses bounded, authorized pulls.
This design reuses that existing loop and does not create a second Theme
timer, history reader or out-of-band event channel. Observation delivers
metadata-only `object.put` invalidations and an opaque encrypted cursor.
ThemeResolver never decodes, compares or reconstructs cursors or object
payloads. Every invalidation that matters triggers a complete, fresh,
authorized Theme read, not a patch to an old token or a state override.

The initial `observePull(afterCursor:'')` anchors a live-follow cursor
**before** the first Theme read. A mutation during that read is replayed
after the initial state is displayed; the process does not silently skip
the bootstrap window. Only the full authorized traversal owns the private
dependency set: catalog (for catalog-default selection), every Theme in
the inheritance chain, and every DesignToken including shadowed parent
tokens. After an authorized default/ancestor change, the dependency set is
replaced atomically with the newly read graph. Unrelated objects and
future observation kinds do not trigger a Theme reread.

No rendered Theme result exposes the dependency set or authority:
`onUpdate` receives only the immutable `{themeRef,tokens}` and an optional
metadata-only Change. The Change **does include an opaque observation cursor**
from the existing Images contract; callers must not inspect, parse or derive
ordering information from it. The renderer receives only the scalar tokens.
Both explicit and catalog paths use the same `resolve` traversal semantics.
Invalid/denied/missing reads fail explicitly; the lower error identity is
preserved and no CSS or GTK pane is restyled to a guessed stock value.

## Updating existing views, not rebuilding them

Browser: `BrowserRendererAdapter.setResolvedTokens(tokens|null)` is a
**concrete host-side control**, not one of the six RendererAdapter operations.
The DOM realizer validates the complete array first and reuses the same
style node and CSS properties on existing roots. Null removes only its
own properties and style node. No view handle, user-edited field value,
focus, intent binding, or Component/GLB surface is replaced.

Native Linux: `LinuxRendererAdapter.set_resolved_tokens(Some(&tokens))`
or `set_resolved_tokens(None)` is the analogous host-side control. Existing
GTK panes retain their widget tree and a single per-widget CssProvider, whose
CSS data is updated in place. Removal withdraws that provider only; no
global `StyleContext::add_provider_for_display` is used. Styles for other
adapter instances are untouched. The six-operation
`RendererAdapterOps` trait remains unchanged.

ThemeResolver does **not** call either host API directly; the composition
callback above is the explicit bridge. A failed Theme resolution can be
reported to the user and withdrawn by that callback without inventing
a second appearance source.

## Guarantees and limits

A `stop()` during an in-flight uncancellable Images read ends the follow
without initiating another render; a late read cannot publish a stale
Theme. A render already started by a host callback must be bounded or
cancellable by that host: the resolver cannot undo an arbitrary async
renderer side effect. The provided browser and GTK style controls are
synchronous after validation.

The observation lane filters events by the read authority. **A grant
revocation itself need not emit an invalidation**; a revoked object may
become invisible to that feed. Denial is detected on a subsequent visible
invalidated read, an explicit refresh or a new follow. Therefore this
is not an instantaneous revocation-notification mechanism. No polling
outside the existing authorized observation lane is added to fake that
guarantee. Likewise, the multi-object traversal is sequential, not
an atomic snapshot across unrelated writes; later invalidations converge
it to the current authorized graph.

Tests: `test/theme-follow.test.js` supplies deterministic adversarial
events, start-window races, shadowed-token dependencies, current-catalog
retargeting, denial and cancellation. `test/theme-resolver.integration.test.js`
executes a real Images observation binding to prove edits reach authorized
Theme values. The production browser and GTK tests exercise live host
style changes, style removal, malformed input atomicity, stable identity
and unchanged action payloads.

Per-principal EnvironmentProfile selection, richer editing, automatic
lifecycle composition for every production host, and measured distributed
Lagrange cluster use remain separate acceptance milestones.


## Session-scoped lifetime (T6 browser candidate)

The browser/JavaScript host may opt in to the reviewed
[Session Theme lifecycle composition](architecture/session-theme-composition.md):

```js
const lifecycle = createSessionThemeLifecycle({
  session, compositor, themeResolver,
  setResolvedTokens: tokens => browserRenderer.setResolvedTokens(tokens),
  onThemeError: error => showThemeError(error), // synchronous, non-awaiting
});
await lifecycle.start({
  selection: {kind: 'catalog-default', imageId},
  authority, blockId: readBlockId, observationBlockId,
});
// On Session teardown: stop the authorized follow before Compositor.destroy.
await lifecycle.close();
```

This is explicit host composition, **not** automatic login-time registration.
Errors withdraw styling and surface through the required synchronous host
callback. Closing during startup rejects with a specific cancellation error
instead of claiming a Theme was installed. Neither asynchronous callbacks nor
an unowned JS→GTK style dispatch are admitted. The native Session port still
exposes only the six lifecycle operations; a separate GTK-thread bridge is
required for native live-Session wiring. There is no per-principal profile
selection until a reviewed ProfileResolver/uniqueness contract exists.
