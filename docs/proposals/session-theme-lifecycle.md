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

One lifetime per controller: `NEW -> STARTING -> ACTIVE -> CLOSING -> CLOSED`.
Concurrent/duplicate start is rejected; closing is idempotent and terminal.
The controller owns the transition rules and the abort signal; the
`ThemeResolver` remains sole owner of follow cursor/dependency semantics.
Initial start performs exactly one authorized follow, whose first
`onUpdate` sets all host tokens synchronously. No Session can implicitly
create a missing default object, invoke trusted provisioning, scan profiles or
select a fallback palette. A failed initial follow refuses start and
returns its original error. It must not leave a live subscription or
partially styled session; the host's existing unthemed state is preserved.

An authorized update only invokes `applyTokens` for this controller's
active lifetime. A subsequent follow error must **withdraw styling for
that Session only** via `applyTokens(null)`, then report the original error
exactly once; it must not silently keep presenting the old Theme as current.
Report failure is visible and does not invent another authorization path.

`close()` marks the controller closing and aborts the follow BEFORE calling
`compositor.destroy()`. Late read results and callbacks cannot restyle a
closed Session. Destroy errors are propagated; repeated close is idempotent,
and the subscription is never re-admitted. A close during an uncancellable
initial read completes promptly using the resolver's stop fencing. One
Session's failure or close must not touch another Session's views or Theme.

**Host boundaries:** `applyTokens` is deliberately a small injected
host-only control. It is **not** a seventh RendererAdapter lifecycle op.
GTK code may invoke `LinuxRendererAdapter::set_resolved_tokens` through
its existing host composition; this JS lifecycle owner does not control GTK
widgets directly. No appearance data enters `SemanticUi`, a Presentation,
`Session.state`, a Perspective, or an image record.

## Independent plan-review falsification

1. Two real `Session` objects, two `Compositor` instances and independently
   themed browser adapters: a changed authorized token updates each
   correctly, and closing or denying one cannot alter the other's
   computed styles or command-input state.
2. Deterministic held initial read and concurrent `close()`: no late
   `applyTokens`, follow cleanly canceled, `compositor.destroy` called
   once, no leaked callbacks or unhandled rejection.
3. An independent lower `AbortError` is an actual startup/follow failure,
   not interpreted as voluntary Session stop.
4. Invalid/malformed token or denied Theme: the renderer's validator refuses
   unsafe input; the original error is preserved and the session is explicitly
   unstyled; no fallback, no silent rollback of durable Theme state.
5. Duplicate start, close-before-start, repeated close, and close while update
   notification is queued have unique outcomes and bounded completion.
6. A test deliberately **removes the stop-before-destroy edge**, showing a
   stale styling callback can reach a torn-down renderer, then verifies the
   correct owner prevents it.
7. Real Images read/observation composition test and both host/UI gates,
   exact-source green Node/browser/native CI, current docs/ownership reconciliation.
8. Adversarial plan review **before** code and a *separate* diff/test review
   after code, with findings resolved rather than overridden.

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
  another durable settings/configuration system.

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
