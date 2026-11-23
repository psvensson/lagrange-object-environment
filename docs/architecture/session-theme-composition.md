# Session-scoped live Theme composition (T6)

Status: **browser/JavaScript T6 implementation candidate on a stacked review branch; not merged and Beads gate outstanding**. Fresh independent Copilot plan review found and resolved three design gaps. Source implementation is separately subject to exact-head tests and independent diff review.
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
RendererAdapter lifecycle methods. **But the native JS-host port exposes
only the six renderer lifecycle operations**, and the GTK setter must run
on the GTK-owning thread. There is no reviewed native live-style dispatch
bridge. Initial T6 is therefore **browser/JavaScript host composition only**;
native Session lifecycle integration is blocked on a separately designed
host-only scalar dispatch bridge. Nothing currently guarantees that a browser
Session starts exactly one follow, withdraws styling on denial, reports
errors, or stops the follow **before** its Compositor destroys views.

## Single cross-subsystem owner

One opt-in `SessionThemeLifecycle` composition owns **only the arrow**
`Session + ThemeResolver follow -> host renderer styling -> Compositor teardown`.
It never decides Theme inheritance, catalog semantics, authority policy,
profile selection, image provisioning, view identity or native CSS/GTK style.

Inputs are injected, required current objects: a `Session`, its
`Compositor`, the existing `ThemeResolver`, the browser host's synchronous
`BrowserRendererAdapter.setResolvedTokens` (bound as a scalar-only function),
and a **synchronous** host error-reporting callback.
The composition owns the subscription lifetime, not the Compositor or the
renderer implementation. Neither callback may return a Promise or other
thenable; otherwise a reporter awaiting `close()` would deadlock the
ThemeResolver's awaited `onError` and styling could complete after teardown.
A thenable return is a **contract error**, never awaited. Its rejection must
be observed/handled so it cannot leak as an unhandled rejection. Already
started synchronous style operations finish in one JS turn, while closing
prevents subsequent operations from beginning.

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

1. The browser host creates its Session, renderer and Compositor normally,
   then starts this **opt-in** lifecycle. Duplicate `start()` invocations
   on **one lifecycle instance** are rejected; another lifecycle must not be
   constructed for the same renderer/Compositor by the host. A closed lifecycle
   cannot be restarted. No shared/global Session registry is created.
2. Before first styled view state is assumed, the selected follow opens
   the existing authorized observation lane and returns an actual resolved
   Theme through its `onUpdate` callback; the host supplies the complete
   validated scalar token set to `setResolvedTokens`, not the Theme ref,
   principal, authority, cursor, or any stored object. The observed cursor is
   anchored inside ThemeResolver before its initial authorized read.
3. Errors while starting reject `start()` and report through the one required
   **synchronous** error callback; no subscription or old style remains as a
   silent fallback. A special case is **caller-requested cancellation**:
   when `close()` wins during bootstrap, ThemeResolver may return a stopped
   follow handle with NO initial `onUpdate`. The lifecycle explicitly detects
   its aborted signal or closing state and **rejects `start()` with a
   distinguishable cancellation error**, without calling `onThemeError` or
   reporting success. This result is not a Theme read/permission failure.
   Later read/validation/render errors withdraw styling using synchronous
   `setResolvedTokens(null)`, report the original error, and retire the
   follow. If withdrawal also fails, the host error callback receives
   both original and withdrawal errors explicitly, never masking the first.
   No retry/poll loop is invented.
4. Closing is single-flight and idempotent. It aborts the follow immediately,
   lets the follower settle without waiting for uncancellable underlying reads,
   and then awaits `Compositor.destroy()` exactly once. A concurrent start
   must reject as cancelled, never report a successful active subscription.
   The host callback contract is synchronous and non-awaiting: a reporter
   may **call `close()` without awaiting its Promise**; it may not await
   `close()` inside the ThemeResolver error callback. Error-handler failures
   are observed and surfaced through the lifecycle result rather than
   causing unhandled Promise rejections or trapping teardown. No async
   renderer callback can outlive close because it is disallowed.
   Closing cannot invalidate another Session's renderers.
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
  or DOM updates. No callback runs after closure. The concurrent `start()`
  rejects with a cancellation-specific error rather than reporting success,
  and the ordinary Theme error callback is not invoked by close.
- Repeated `close` executes Compositor teardown once; duplicate `start`
  and startup after close reject. Explicit startup cancellation is distinct
  from a lower `AbortError`. A synchronous reporter that triggers `close()`
  (without awaiting it) cannot deadlock, and a misbehaving callback returning
  a pending/rejecting Promise is rejected as a contract violation, with that
  Promise's rejection observed. A throwing renderer/error callback never
  strands a subscription or creates an unhandled rejection.
- Existing `RENDERER_ADAPTER_METHODS` remains exactly six. The actual
  browser DOM style update preserves a typed input/focus.
- **Native-specific blocked case:** `hosts/linux/src/js_env/renderer_port.rs`
  currently exposes only six operations. The separate, independent native
  bridge plan must name its GTK-thread dispatch/ack/cancellation owner and
  falsify a held queued style apply and withdrawal after Session close,
  before native Session T6 can be claimed.

## Out of scope / rejected approaches

**Per-principal preferences are not implemented.** ADR 0015 reserves the
authenticated-principal -> profile mapping and safe lazy uniqueness to
`ProfileResolver`, and lower public uniqueness/lookup capability has not
been established here. This slice must not scan all profiles, auto-create
records on login or infer authority from a principal key. A separate Bead
and a verified lower contract are required before profile selection.

A seventh renderer operation, an observer per widget, global GTK/CSS state,
an unowned JS->GTK style message, asynchronous style/error callbacks inside
the current lifecycle, an in-memory persistent Theme default, reimplementing
authorized observation, weakening read authorization or reviving obsolete
server releases are rejected as duplicate owner/fallback behavior.
**Native Session binding is explicitly blocked** until a separately reviewed
GTK-thread, host-only scalar style bridge exists. The existing GTK T4/T5
adapter styling tests stay green but do NOT prove that bridge.
Native and cloud deployment acceptance remain separately gated.

## Verification and delivery

Before source changes, obtain a **fresh-context independent plan review**
of this interaction and falsification list, record findings, and create/claim
the corresponding Dolt-backed Bead with the pinned CLI in a managed checkout.
This checked-in architecture note is **not a substitute for Beads** or
evidence of independent approval. Implement in one small code PR for the browser/JavaScript host with direct
lifecycle tests, real Images-authorized follow integration, browser DOM proof,
and full exact-head Node/browser/native CI. The native bridge is a separate,
blocked follow-up and must not be silently implemented in the browser slice. Review the actual diff with a
separate agent before merge.
