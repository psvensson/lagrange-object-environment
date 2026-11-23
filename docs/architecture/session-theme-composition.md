# Session-scoped live Theme composition (T6)

Status: **browser/JavaScript implementation; native Session binding remains separate**.
Owner: `SessionThemeLifecycle` (`src/session-theme-lifecycle.js`).
Bead: `lagrange-object-environment-0k7.4`.
Source baseline: Object Environment `main@1dc8adb342d6fc486813b245cb10c67bfd005e94`.
Decision basis: ADR 0015, ADR 0011 and existing T4/T5 contracts.

## Problem and current executable evidence

`Session` in `src/model.js` holds an external principal, Perspective and transient
state. It has no renderer resources, grants, subscriptions or close routine.
`Compositor` owns logical views and renderer destruction. `ThemeResolver`
owns authorized reads, inheritance, dependency tracking, observation and stop
fencing. The browser and GTK adapters already expose in-place style controls.
Before T6, no owner coupled one Session's follow to its Compositor's teardown.

The native JS renderer port exposes only six lifecycle operations, while
`LinuxRendererAdapter.set_resolved_tokens` must run on the GTK-owning thread.
There is no reviewed native live-style dispatch bridge. This slice provides
**browser/JavaScript composition only**, without claiming native Session wiring
or changing the renderer-neutral meaning of Theme tokens.

## Single owner and construction boundary

`SessionThemeLifecycle` owns the interaction
`Session + ThemeResolver follow -> host style control -> Compositor teardown`.
It delegates Theme semantics to ThemeResolver, view state and resource-error
mapping to the existing Compositor, and CSS realization to the host adapter.
It neither selects a profile nor provisions an image.

The factory receives a canonical `Session`, its fresh browser `rendererAdapter`,
the existing `themeResolver`, and a synchronous `onThemeError` reporter. It
creates the canonical Compositor internally with `createCompositor`, keeping
that raw object private. It publishes a frozen forwarding facade with the same
view methods and **`compositor.destroy === lifecycle.close`**. It does not
copy view state or replace any Compositor admission, focus or error policy.
There is no separately exposed raw `destroy` that can bypass follow retirement.

The private Compositor receives a mechanical delegation of the canonical six
renderer operations. The five ordinary operations retain the actual adapter as
their receiver and add no asynchronous boundary. Only `destroyAll` waits for
follow retirement before invoking the actual adapter's teardown. Compositor
still validates every actual operation before either identity is claimed;
the delegate cannot disguise a missing or nonfunction `destroyAll`.

Private module WeakSets claim the Session and actual renderer-adapter identities
once. A second factory using either already-claimed identity rejects before
starting any work, including after closure. A new Session needs a fresh adapter.
Validation happens before either identity is claimed. These weak custody sets
contain no principal mapping, tokens, grants or durable preferences.

Participating hosts give their consumers the published Compositor facade and
route shutdown through that facade or `close`. They do not separately destroy
the underlying renderer, share it with another independently created Compositor,
or prepopulate it with views outside this composition. Existing hosts that do
not opt in retain their existing lifecycle. The new API is reusable composition,
not a claim that every production host has already adopted it.

Public API:

```js
const lifecycle = createSessionThemeLifecycle({
  session,
  rendererAdapter, // fresh BrowserRendererAdapter; synchronous setResolvedTokens
  themeResolver,
  onThemeError,    // synchronous, required
});
const {compositor} = lifecycle;
try {
  await lifecycle.start({
    selection: {kind: 'catalog-default', imageId},
    authority, blockId: readBlockId, observationBlockId,
    // Optional intervalMs is forwarded to the existing observation owner.
  });
  // Or selection: {kind: 'explicit', themeRef}.
  // Open/present views through compositor; observe lifecycle.done for failure.
} finally {
  await compositor.destroy(); // same single-flight operation as lifecycle.close()
}
```

The factory returns `{compositor, start, done, close}`. The Session's principal
is descriptive identity, never an authority token or a profile lookup shortcut.
Each follow receives exactly its caller's authority and read/observation binding
ids. Only resolved scalar tokens reach the adapter; Theme refs, cursors and
grants do not. Absence, denial or invalid catalog state never selects a palette
from code. The tagged selection is explicit and image-local.

## Start and terminal follow result

The first `start` invocation owns the one startup attempt. Duplicate calls and
calls after closure reject without reporting a Theme failure, withdrawing an
active Theme, starting a second follow or destroying an existing composition.
A failed first attempt is terminal; there is no implicit retry or restart.

The lifecycle owns an AbortController before dispatching the follow, including
before the initial observation anchor returns. It delegates anchoring and every
read to ThemeResolver. Successful start requires an accepted initial synchronous
style application and no intervening close or terminal failure. A stopped follow
handle alone is not evidence of readiness.

When caller-requested close wins during bootstrap, `start` rejects with an
exported `SessionThemeCancelledError`, and the Theme reporter is not called.
A lower layer's independently thrown `AbortError` is an ordinary failure. A
reporter-triggered close after a recorded failure preserves that failure; it
does not relabel it as startup cancellation. The
lifecycle distinguishes cancellation by its own close state, not an error name.

A startup or later read, validation or style failure retires the follow,
withdraws styling with `rendererAdapter.setResolvedTokens(null)`, and invokes
`onThemeError` once. It preserves existing view identities and user input;
failure itself does **not** destroy the Compositor. The host must close its
composition in its normal/failure cleanup path, including after rejected start.
This deliberate separation allows an existing pane to display a diagnostic
without a replacement Theme. No fallback, retry or second polling loop appears.

`done` is the **terminal follow result**, not proof of renderer destruction:

- It resolves when following has retired because of normal close/cancellation,
  including close before start.
- It rejects when following has retired because of a startup/refresh failure,
  including failed withdrawal or reporting as defined below.
- It does not wait for or include the concrete renderer's later destruction. `close`
  is the complete resource-teardown result.

The owner attaches rejection observers immediately to every background promise,
including `done` and the shared `close` Promise. A consumer can still await the original rejected promise;
internal observation does not convert failure into success.

## Callback and error contract

The real browser adapter's `setResolvedTokens` and the host reporter must finish
synchronously, without returning Promises/thenables. The adapter already validates
and applies styles synchronously. A reporter may trigger `close()` without
awaiting or returning that Promise. The lifecycle never waits for user reporting
inside ThemeResolver's awaited error callback, so reporter-to-close reentrancy
cannot create a wait cycle.

A thenable return is a contract violation. Its rejection is observed and it is
not awaited. The lifecycle reports that violation and completes its own cleanup.
This check **cannot undo arbitrary side effects already scheduled by an invalid
callback**. No-late-style guarantees apply to the supported synchronous browser
setter, not arbitrary asynchronous injected host code.

Failure has one ordered record: original Theme/start/style error, optional
withdrawal error, then optional reporter error. The reporter receives the
original error or an `AggregateError` containing original plus withdrawal error.
It is never called recursively to report its own failure. `start` (when startup
failed) and `done` reject with the same recorded follow failure: preserve the
original error object if it is the only failure, otherwise use an `AggregateError`
with the original as `cause` and ordered underlying errors. Thrown values are
preserved, not replaced by strings. A later rejection of an unsupported callback's
thenable is handled but cannot rewrite an already-settled result.

## Close and reentrancy contract

`close` is single-flight and idempotent. It publishes its one Promise and closing
state **before** aborting the follow or invoking any external code. Every close
caller, including reentrant calls through the published Compositor, receives that
same Promise and eventually the same fulfillment or rejection.

Close immediately invokes the private Compositor's `destroy`, whose synchronous
admission fence rejects new view operations and clears logical views and focus
before any abort listener or follow-retirement continuation runs. Close then
aborts the already-owned signal immediately, independently of any renderer work
the Compositor is draining. Its delegated `destroyAll` retains an idempotent
abort for the immediate path and waits for the canonical follow start/worker to
retire, without waiting for uncancellable lower reads or invalid callback
thenables. Concrete renderer destruction follows both admitted composition-work
retirement and follow retirement; neither owner duplicates the other's drain.

Actual adapter teardown is attempted exactly once **even if** startup, follow
settlement, withdrawal or reporting failed. Internal retirement records those
failures without throwing them through Compositor's renderer-error mapper;
only actual adapter teardown failures cross that boundary. No subsequent
supported callback can publish styling. A held renderer teardown remains
awaited; prompt follow cancellation does not make renderer destruction
instantaneous. Compositor's liveness queries expose no live views once close
starts. An admitted operation cannot republish live or lost view state after
that fence, even when its renderer response arrives later.

`close` preserves any recorded follow failures and appends the Compositor's
existing typed teardown error if destruction fails. With only one error it
preserves that error object. With multiple errors it rejects with an ordered
`AggregateError` (original, withdrawal, reporter, teardown; original as cause).
If only teardown failed, that error is the cause and sole result. Repeated close
never hides an earlier failure behind a later successful no-op. Compositor owns
the admitted-operation drain and retains its resource error mapping.

The composition stores no principal, grant, cursor, Theme preference, token cache,
CSS or resource handle in Session.state, Perspective, SemanticUi or image objects.

## Counterexamples and primary proofs

Direct lifecycle proof (`test/session-theme-lifecycle.test.js`) distinguishes:

- Two factories cannot claim the same Session or adapter, even with different
  counterparts. Duplicate start cannot disturb a live first start. Invalid
  construction does not consume a valid identity.
- Destruction through the published Compositor is exactly `close`, stops the
  follow before the one adapter teardown, and concurrent/reentrant closes share
  one Promise. Hold teardown to prove a second close does not return early.
- After close begins, same-turn open/present requests reject through Compositor
  before any renderer create, detach or attach. Focus rejects synchronously.
  Exercise both active and already-failed follows with the fake adapter's
  unwrapped teardown; after all results settle, resources and durable intent
  are empty. Missing actual `destroyAll` must reject construction without
  consuming the Session or adapter identity. Reentrant view operations from a
  synchronous abort listener must also be rejected before renderer dispatch.
- Hold the initial observation anchor, initial Theme read and refresh read in
  separate cases. Close retires the follow before releasing each lower operation.
  Late release/rejection launches no additional reads or supported style callback.
  Interrupted startup rejects cancellation without a Theme error report.
- A lower independent AbortError reports normally. A throwing setter, failed
  withdrawal, throwing reporter and failed renderer teardown preserve all errors
  in order and still attempt destruction once. Repeated failed close replays it.
- A synchronous reporter triggers close without deadlocking. An invalid callback
  returning a pending/rejecting thenable does not strand shutdown or cause an
  unhandled rejection; the test does not pretend to cancel its arbitrary effects.

Real Images integration (`test/theme-resolver.integration.test.js`) uses the
canonical resolver and adapter. Two Sessions share the **same image, Theme graph
and resolver instance** with different authorities: one is permitted; the other
is denied a reached, preferably shadowed, token. Reads/observation use their own
supplied bindings; the denied Session cannot receive the permitted Session's
values. An authorized catalog or inherited-token edit refreshes the live Session;
unrelated metadata is ignored. Closing either leaves the other independent.

Browser proof (`test/browser/dom-coexistence.test.js` and its existing proof page)
instantiates the public lifecycle with the actual BrowserRendererAdapter,
opens a real semantic pane through its published Compositor, and drives the
canonical follow. A style change preserves the same pane, typed field and focus.
Failure withdraws the Theme without replacing those controls. Destroy via the
published Compositor proves lifecycle wiring, not a separate handwritten stop.
Both active and failed-follow close paths also reject same-turn view operations
before renderer dispatch and leave no DOM or durable intent after teardown.
The six `RENDERER_ADAPTER_METHODS` remain unchanged.

## Deferred boundaries and rejected alternatives

Native Session binding is tracked by `lagrange-object-environment-0k7.5` and
remains blocked until a reviewed host-only
scalar bridge names GTK-thread dispatch, acknowledgement and cancellation. Its
proof must hold queued GTK apply/withdrawal across close; fixture styling alone
does not prove the bridge. Native regression CI still runs for this browser slice.

Per-principal ProfileResolver lookup/unique lazy creation remains separate.
There is no shell scan, profile auto-creation, principal-as-grant or speculative
lower API. DTCG interchange and cloud/deployment acceptance are also separate.

Rejected: independent wrappers around an exposed raw Compositor (teardown can
bypass follow retirement); a new Theme-aware Compositor state machine (duplicates
interaction policy); host-only uniqueness by convention (two owners can claim a
Session); a seventh renderer op; per-widget observers; global CSS/GTK state;
async style dispatch disguised as synchronous; a second poller or token cache.
Also rejected: waiting for follow retirement before invoking Compositor destroy,
because that delays its canonical admission fence. The barrier belongs only
around actual renderer teardown. Compositor Bead
`lagrange-object-environment-3zx` supplies the canonical drain for operations
already admitted before close. Theme observation stops immediately after that
admission fence; concrete teardown waits for both operation and follow retirement.

## Verification and delivery

Use a fresh-context adversarial subagent from the implementing assistant for the
plan and a separate fresh-context subagent for the actual implementation diff,
as the user requested. GitHub/Copilot review is not this task's approval gate.
Record reviewed source identity, findings, dispositions and verdict in the Bead;
resolve blockers and re-review revisions before implementation.

Create/claim the corresponding Bead through the pinned Dolt-backed CLI and keep
native follow-up/dependencies in that work graph. This document is the interaction
contract, not an alternative task tracker. Implement one small browser/JavaScript
slice, run its direct/integration/browser proofs and full exact-head Node/browser/
native CI, reconcile current docs/ownership, and obtain independent diff approval
before merge. Follow AGENTS.md thermal rules for any local test/build; remote CI
retains its configured concurrency. No native Session wiring is implied by green
native regression tests.
