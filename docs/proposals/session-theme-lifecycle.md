# Session-scoped live Theme composition — T6 plan candidate

Status: **candidate for independent plan review; no T6 production code implemented**.
Prior evidence: merged T4/T5 PRs #104/#105/#106; current main
`1dc8adb342d6fc486813b245cb10c67bfd005e94`.
This proposal does not claim a Dolt Bead was created or synced; the pinned
`bd` CLI / Dolt-backed work graph is not accessible via this connected GitHub
surface. A managed checkout must create/claim the Bead and attach the verified
plan before code implementation.

## Problem / current evidence

- `src/model.js` `Session` holds transient principal/perspective/state but does
  not own subscriptions or renderer resources.
- `src/compositor.js` alone owns logical views and six-operation renderer
  teardown. Session shutdown calls `Compositor.destroy()`, not any Theme API.
- `src/theme-resolver.js` owns explicit and catalog-default authorized Theme
  resolution, opaque-cursor observation, complete dependency tracking and
  abortable `followTheme` / `followCatalogDefault`. ImageClientAdapter owns
  the existing *pull-based*, per-object-authorized observation interface.
- Browser and GTK concrete adapters own validated scalar-only,
  per-pane `setResolvedTokens` / `set_resolved_tokens` host styling. A
  client presently must wire `onUpdate`, `onError`, stop and teardown
  manually. A forgotten stop, wrong ownership or stale callback creates
  real user-facing hazards despite the individual components' green tests.

## Owner / interaction

Add exactly one interaction owner: `SessionThemeLifecycle` (proposed
`src/session-theme-lifecycle.js`). It owns the *crossing* from one Session's
authorized Theme-follow lifetime into that same Session's renderer, including
start/stop sequencing, error reporting and teardown. It does **not** own
principal authentication, grant issuance, Theme identity/default precedence,
Theme parsing/inheritance, observation polling, renderer styling grammar,
view lifetime semantics, or durable environment data.

Inputs: an existing `Session`, `Compositor`, `ThemeResolver`, a
host-provided `applyTokens(tokens|null)` calling its concrete renderer,
`imageId`, explicit caller `authority`, the exact read/observation block
IDs, and a **required** `reportError(error)` channel. All supplied ports
are validated before a subscription is admitted. The owner never inspects
`session.principal` to mint authority or constructs CSS/GTK state. The
`Session` is retained for identity/lifetime association only.

## Proposed bounded API and transitions

```js
const controller = createSessionThemeLifecycle({
  session, compositor, themeResolver,
  applyTokens: values => browserAdapter.setResolvedTokens(values),
  imageId, authority, readBlockId, observationBlockId,
  reportError: error => showSessionThemeFailure(error),
});
await controller.start();  // the image's actual catalog.defaultTheme
// OR await controller.start({themeRef}); // explicitly authorized selection
await controller.close();  // stop follow BEFORE destroying Compositor views
```

One lifetime per controller: `NEW -> STARTING -> ACTIVE -> CLOSING -> CLOSED`,
plus terminal `FAILED` for a non-cancellation follow/error-reporting failure.
Concurrent/duplicate start is rejected; closing is idempotent and terminal.
The controller owns the transition rules and the abort signal; the
`ThemeResolver` remains sole owner of follow cursor/dependency semantics.

**Startup settlement is NOT inferred from the follower Promise fulfilling.**
`ThemeResolver.followCatalogDefault` may fulfill with an *already-stopped*
handle after a user cancellation, and its worker can call `onError` before
the handle is delivered. A closing-state / aborted-signal check is required
immediately AFTER awaiting the follow and BEFORE transitioning to `ACTIVE`.
The controller records any early follow error independently of the returned
handle; an early error wins over successful fulfillment and rejects `start`
with the original primary error (or the explicitly reported aggregate when
secondary errors exist), never an `ACTIVE` controller. A concurrent
`close()` instead causes `start()` to reject a stable, documented
`SessionThemeClosedError` (or `AbortError` whose cancellation origin is
explicit), never to resolve success. No Session can implicitly create a
missing default object, invoke trusted provisioning, scan profiles or select
a fallback palette. A failed start retires any acquired subscription and
withdraws a partially applied Theme; no resource remains active.

The first `onUpdate` applies the already-authorized tokens **synchronously**
to the browser host before a successful `start()` resolves. A candidate
`applyTokens` port returning a Promise/thenable is refused at this T6a
boundary rather than silently treating a queued style request as complete.

An authorized update only invokes `applyTokens` while this controller
is still `STARTING` or `ACTIVE` and its abort signal remains live. A
subsequent follow error moves it to terminal `FAILED` and must withdraw
styling for **that Session only** through `applyTokens(null)`; no fallback
or durable rollback is permitted.

**Error reporting is independently failure-safe.** Withdrawal is attempted
even when the follow fails; a throwing/rejected withdrawal must not skip
`reportError(original)`. Reporting is attempted exactly once for the primary
failure whether withdrawal succeeds or fails. Both operations are settled
independently; an `AggregateError` carries the primary error PLUS all
secondary withdrawal/reporting errors if any. The controller exposes a
public, awaitable `done` (or equivalent terminal-failure channel) so the
host can observe all errors, including a reporter rejection, with a
terminally handled internal Promise to prevent unhandled rejections.
The original error remains separately identifiable; secondary failures
are never dropped merely to preserve a pleasing status.

`close()` synchronously marks the controller `CLOSING`, aborts the
controller signal and calls `follow.stop()` (when present) BEFORE invoking
`compositor.destroy()`. The shutdown Promise is shared by all close callers,
and the controller cannot start again. A close while the initial follow is
still pending cancels start with the explicit outcome above and retires any
late-arriving handle before destruction completes. Late lower reads are
terminally handled and cannot apply styling after close.

**Two independent falsifiers are required:** a recorder asserts the precise
`abort/stop -> compositor.destroy` ordering (a mutant reversing the order
must fail), and a separate held-read/queued-onUpdate test proves late
callbacks cannot style a closed view. A test relying *only* on a late
callback cannot prove ordering because the close-state fence could mask a
reversed teardown. Destroy errors remain observable through the terminal
channel, even after a follow error; repeated close is idempotent. One
Session's failure/close cannot touch another Session's views or Theme.

**T6a host boundary:** `applyTokens` is a small injected **synchronous
browser/JS host-only** control, not a seventh RendererAdapter lifecycle op.
The current native JS↔GTK `hosts/linux/src/js_env/renderer_port.rs` carries
only six **asynchronous** lifecycle operations with separate JS-owner and
GTK-owner threads. It cannot truthfully provide synchronous completion for
`LinuxRendererAdapter::set_resolved_tokens` today. T6a therefore proves
the browser/JS Session path and retains native build/regression CI but
**does not claim native Session live Theme integration**.

A separately reviewed T6b must add a host-only native appearance control
under the EXISTING `js_env` port/actor owner, returning an awaited
completion/error acknowledgment. It must preserve GTK-thread ownership,
operation ordering and cancellation (including a queued update vs close),
and prove JS follow→native host→real GTK style change. Never implement
fire-and-forget style calls, add a seventh RendererAdapter lifecycle op,
or claim an absent bridge via a stub. No appearance data enters
`SemanticUi`, a Presentation, `Session.state`, a Perspective, or an
image record.

## Independent plan-review falsification

1. Two real `Session` objects, two `Compositor` instances and
   independently themed **browser** adapters: changed authorized tokens
   update both; closing or denying one cannot alter the other or its text.
2. Held initial read with concurrent `close()`, same-turn close before
   bootstrap microtask, and a follow that returns an already-stopped handle:
   start must reject the documented cancellation outcome, not claim `ACTIVE`.
3. Observation `onError` arriving BEFORE the follow handle resolves: start
   rejects the original failure and never records an active subscription.
4. Independently injected lower `AbortError` at anchor/read/render while
   *not* closing must reject or terminally report; only deliberate close is
   treated as cancellation.
5. Denied/malformed Theme plus throwing/rejecting withdrawal and reporter:
   always attempt reporting the original failure; `done` exposes every
   secondary failure with original identity recoverable, no hidden fallback.
6. Duplicate start, close-before-start, repeated close, and close while an
   update notification is queued have unique, bounded, terminal outcomes.
7. **Separate teardown ordering test:** event log asserts follow abort/stop
   BEFORE `compositor.destroy`; a reversed-order mutant fails even with the
   late-callback fence intact.
8. **Separate late-callback test:** a held/uncancellable Images read released
   after close cannot apply Theme, and the Compositor destroys exactly once.
9. Real Images read/observation + actual production browser adapter, current
   DOM computed-style/typed-text checks, full Node/browser/native regression CI.
   No native Session bridge claimed until T6b completion/error acknowledgment.
10. Independent plan review **before** code and a separate diff/test review
    after code, with all material findings addressed.

## Dependencies and boundaries deliberately deferred

- ADR 0015's `ProfileResolver`: a principal-specific default needs one
  authorized lookup and an atomic uniqueness-safe first-personalization
  path. **Do not** build a local principal-to-profile registry or a
  read-then-create implementation. Until the public Images contract is
  established, T6 only follows the *authorized catalog default* or an
  explicitly selected Theme under supplied authority.
- Revocation may not produce an invalidation in the per-object authorized
  feed. Explicit Session close/error withdrawal is provable; instantaneous
  revocation notification is **not** a claim. Do not create a second poller
  to hide the lower contract.
- Production cluster acceptance for native PRs #95/#100 and published
  `lagrange-server` is separate; no obsolete package assumption here.
- The `SessionThemeLifecycle` host API is an interface candidate, not
  another durable settings/configuration system. T6a is JS/browser-only;
  native JS-to-GTK completion/error/cancellation ordering is the explicit
  subsequent T6b port-owned dependency.

## Alternatives explicitly rejected

Theme observation on every widget, a seventh renderer lifecycle op, changing
the immutable `ThemeResolver` return shape to include host resources,
global browser/GTK style, Session.state theme caches, automatic provisioning
or profile creation during open, separate Theme polling and treating a
ThemeRef or principalKey as authority.

## Gates and handoff

A fresh-context independent reviewer should examine the current main source,
ADR 0015, ownership rows for Session/Compositor/ThemeResolver/renderer,
T4/T5 tests and the exact plan, and report contradictions/races and missing
falsifiers. The reviewed final plan belongs in a real Bead (not an ad-hoc
second tracker) when the pinned CLI/Dolt backend is available. Until then this
document and its PR are review evidence, not authorization to skip Beads or
the code-review gate.
