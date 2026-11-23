# Session-scoped live Theme composition (T6)

Status: **proposed interaction contract, independent review required before implementation**.
Owner: `SessionThemeLifecycle` (planned `src/session-theme-lifecycle.js`).
Source baseline: Object Environment `main@1dc8adb342d6fc486813b245cb10c67bfd005e94`.
Decision basis: ADR 0015, ADR 0011 and existing T4/T5 contracts.

## Problem and current executable evidence

`Session` in `src/model.js` holds an external principal, Perspective and transient
state, **not** renderer resources, grants, subscriptions or a teardown routine.
`Compositor.destroy()` owns all logical-view and renderer destruction,
and `ThemeResolver.followCatalogDefault/followTheme` owns one authorized
metadata-only Images observation lane, graph dependencies and stop fencing.
The browser and GTK host adapters already expose concrete in-place
`setResolvedTokens` / `set_resolved_tokens` controls outside the six
RendererAdapter lifecycle methods. Nothing currently guarantees that a real
Session starts exactly one follow, withdraws styling on denial, reports
errors, or stops the follow **before** its Compositor destroys views.

## Single cross-subsystem owner

One opt-in `SessionThemeLifecycle` composition owns **only the arrow**
`Session + ThemeResolver follow -> host renderer styling -> Compositor teardown`.
It never decides Theme inheritance, catalog semantics, authority policy,
profile selection, image provisioning, view identity or native CSS/GTK style.

Inputs are injected, required current objects: a `Session`, its
`Compositor`, the existing `ThemeResolver`, a host style control and an
explicit host error callback. Concrete browser hosts can pass
`BrowserRendererAdapter.setResolvedTokens`; a native host can provide a
corresponding scalar-only style function without implementing a parallel
ThemeResolver. The composition owns the subscription lifetime, not the
Compositor or the renderer's implementation.

Proposed public factory:

```js
const lifecycle = createSessionThemeLifecycle({
  session, compositor, themeResolver, setResolvedTokens, onThemeError,
});
await lifecycle.start({
  selection: {kind: 'catalog-default', imageId},
  authority, blockId: readBlockId, observationBlockId,
});
// Or: selection: {kind: 'explicit', themeRef}
await lifecycle.close(); // idempotent: follow stop -> compositor.destroy()
```

A selection is explicit, tagged and image-local. The Session's authenticated
`principal` is **not** an authority token, never passed as a substitute for
`authority`, and never used to guess an `EnvironmentProfile`. Catalog-default
absence/denial/malformed state fails explicitly; no stock palette is fabricated.

## Sequencing and failure contract

1. The host creates its Session, renderer and Compositor normally, then
   starts this **opt-in** lifecycle. Duplicate starts on one Session are
   rejected; a stopped/destroyed lifecycle cannot be restarted.
2. Before first styled view state is assumed, the selected follow opens
   the existing authorized observation lane and returns an actual resolved
   Theme through its `onUpdate` callback; the host supplies the complete
   validated scalar token set to `setResolvedTokens`, not the Theme ref,
   principal, authority, cursor, or any stored object. The observed cursor is
   anchored inside ThemeResolver before its initial authorized read.
3. Errors while starting reject `start()` and trigger the **one required
   error-reporting callback**; no subscription or old style remains as a
   silent fallback. Later read/validation/render errors withdraw styling
   using `setResolvedTokens(null)`, report the original error, and retire
   the follow. If withdrawal also fails, the host error channel receives
   the original and the withdrawal failure explicitly (never silently hides
   the failed withdrawal). No retry/poll loop is invented.
4. Closing is single-flight and idempotent. It aborts the follow immediately,
   lets the follower settle without waiting for uncancellable underlying reads,
   and then awaits `Compositor.destroy()` exactly once. A concurrent start
   cannot race the close to publish a new style; no failed background worker
   is unobserved. Closing cannot invalidate another Session's renderers.
5. No control-plane identity, grant, observation cursor, CSS, GPU resource,
   selected Theme id or durable preference is put into `Session.state`,
   Perspective, SemanticUi or any image object by this composition.

## Counterexamples / independent falsification

- Two simultaneous Sessions with different authorized Themes: one mutation
  refreshes only the permitted Session and destroying one does not change
  the other's style, view handles, input text or focus.
- A catalog default or inherited DesignToken update reaches the same live
  pane through the canonical ThemeResolver; unrelated metadata is ignored.
- Denial and a malformed Theme update call the one error channel and withdraw
  styling; no static fallback or stale success status is published.
- Closing during a held **startup read** and during a held **refresh read**
  settles promptly; releasing the lower reads later launches no new reads
  or DOM/GTK updates. No callback runs after closure.
- Repeated `close` executes Compositor teardown once; duplicate `start`
  and startup after close reject. A throwing renderer or error callback does
  not strand a subscription or produce an unhandled rejection.
- Existing `RENDERER_ADAPTER_METHODS` remains exactly six. The actual DOM
  style update preserves a typed input/focus; GTK host remains host-local and
  does not acquire a second Session state machine.

## Out of scope / rejected approaches

**Per-principal preferences are not implemented.** ADR 0015 reserves the
authenticated-principal -> profile mapping and safe lazy uniqueness to
`ProfileResolver`, and lower public uniqueness/lookup capability has not
been established here. This slice must not scan all profiles, auto-create
records on login or infer authority from a principal key. A separate Bead
and a verified lower contract are required before profile selection.

A seventh renderer operation, an observer per widget, global GTK/CSS state,
an in-memory persistent Theme default, reimplementing authorized observation,
weakening read authorization or reviving obsolete server releases are
rejected as duplicate owner/fallback behavior. Native and cloud deployment
acceptance remain separately gated.

## Verification and delivery

Before source changes, obtain a **fresh-context independent plan review**
of this interaction and falsification list, record findings, and create/claim
the corresponding Dolt-backed Bead with the pinned CLI in a managed checkout.
This checked-in architecture note is **not a substitute for Beads** or
evidence of independent approval. Implement in one small code PR with direct
lifecycle tests, real Images-authorized follow integration, browser DOM proof,
and full exact-head Node/browser/native CI. Review the actual diff with a
separate agent before merge.
