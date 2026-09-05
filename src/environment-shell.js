/**
 * EnvironmentShell — the selection -> inspector-presentation orchestration
 * owner (docs/ownership.md). This is the first USEFUL composed environment: an
 * authorized root/reference NAVIGATOR pane beside a generic INSPECTOR pane,
 * arranged in a split composition.
 *
 * OWNERSHIP (narrow, fenced): the shell owns THREE descriptor-local couplings:
 *  (1) "when the semantic selection changes, choose/update the inspector view's
 *      Presentation" (nothing else owns it: SelectionModel owns selection state;
 *      the Compositor owns views; neither couples them);
 *  (2) "route a renderer {kind:'edit-field', key, text} through ONE table of
 *      EDIT BINDINGS (keyed by logical viewId: a PURE consumer-owned field
 *      resolver + a consumer-owned transient-token supplier; the Compositor
 *      resolves the emitted handle to the live view) to CommandRouter" (the
 *      edit-field row in docs/ownership.md; Bead 6lm). The inspector is one
 *      binding, built internally (key -> writable slot; the shell's own paired
 *      token; the olm barrier). It does NOT dispatch, build Commands, or own
 *      value semantics — CommandRouter retains semantic-intent -> Command/
 *      authority/dispatch ownership.
 *  (3) "resolve a renderer activate-item key against the CURRENT LIVE descriptor
 *      of its bound source view, then select the resulting ref". The descriptor-
 *      local resolver is injected by that view's semantic owner; the shell owns
 *      only renderer action -> selection orchestration. Bindings (rows 64/65)
 *      name LOGICAL VIEWS; the Compositor alone maps a renderer's transient
 *      surface handle to the live view at interaction time (Bead 4o8).
 * The shell does NOT:
 *  - read the image directly (every read goes through ObjectNavigator.navigate,
 *    which owns the unauthorized-ref/unavailable-ref materialization);
 *  - own authority (threaded per-call, never stored);
 *  - own presentation/command discovery (the registries, via ObjectNavigator);
 *  - own the composition tree, focus, or rendering.
 * It is a HEADLESS, renderer-independent core: it consumes ObjectNavigator /
 * SelectionModel / Compositor through their public APIs and never imports DOM.
 * The displayed inspector's versionToken is held as TRANSIENT concurrency state
 * (paired with each successful read->presentOn; never in any descriptor).
 *
 * THE SEMANTIC LOOP:
 *   known root ref
 *     -> openWorkspace: navigate(root) -> navigator-view presents the refs
 *   user activates ref B (a SELECTION gesture, NOT a command dispatch)
 *     -> selectObject(B): SelectionModel.select(B) + focusView(navigator-view)
 *        -> inspector-view presentOn(navigate(B)'s descriptor)
 *   B mutates externally
 *     -> authorized observation (metadata-only) filtered to the selected ref
 *        -> re-navigate(B) under per-call authority -> presentOn again
 * The durable refs ARE the identities; there is NO shadow browser object model.
 */

import {assertDataRepresentable} from './compositor.js';

const NAVIGATOR_VIEW_ID = 'navigator-view';
const INSPECTOR_VIEW_ID = 'inspector-view';

function resolveNavigatorItem(presentationDescriptor, key) {
  const references = presentationDescriptor?.parameters?.references;
  if (!Array.isArray(references)
      || !Number.isSafeInteger(key) || key < 0 || key >= references.length) {
    return null;
  }
  const ref = references[key];
  if (!ref || typeof ref.objectId !== 'string') return null;
  return ref;
}

// Project an ObjectNavigator navigate result's Presentation to the
// presentationDescriptor the Compositor consumes: {kind, subject, parameters}.
// `parameters` carries the presentation's context (fields + references) as
// data. For the navigator pane we re-kind the inspector Presentation to
// 'navigator' (same data, different realization kind).
function toDescriptor(presentation, {kind = null} = {}) {
  return {
    kind: kind ?? presentation.kind,
    subject: presentation.subject,
    parameters: presentation.context ?? {},
  };
}

function createEnvironmentShell({navigator, selectionModel, compositor, writableSlots = []}) {
  if (!navigator || typeof navigator.navigate !== 'function') {
    throw new TypeError('createEnvironmentShell requires an ObjectNavigator (navigate)');
  }
  if (!selectionModel || typeof selectionModel.select !== 'function') {
    throw new TypeError('createEnvironmentShell requires a SelectionModel');
  }
  if (!compositor || typeof compositor.openView !== 'function') {
    throw new TypeError('createEnvironmentShell requires a Compositor');
  }
  // The host-neutral writable-slot set, threaded from the ImageClientAdapter's
  // mutation field map (adapter.writableSlots — the SINGLE owner). The shell
  // injects it into each inspector descriptor so the SemanticUi projector marks
  // exactly those fields editable. The shell never duplicates the mutation map.
  const writable = Object.freeze([...writableSlots]);

  // --- TRANSIENT concurrency state (NEVER Presentation/SemanticUi/durableIntent/
  // Perspective data): the versionToken of the CURRENTLY-DISPLAYED inspector
  // object, paired with the successful read -> presentOn transition. Replaced
  // only after a successful reread/presentation; cleared when the inspected
  // subject changes or becomes unreadable. Held here (the edit-binding owner),
  // never stored on the navigator/compositor, and attached only to the transient
  // dispatch context at edit time — never to a descriptor.
  let inspectorVersionToken = null;
  let inspectorTokenSubjectId = null;
  // Pair (or clear) the transient token with a successful read -> present
  // transition for the given object. A null token clears (unreadable/failure).
  function pairInspectorToken(token, objectId) {
    inspectorVersionToken = token;
    inspectorTokenSubjectId = objectId;
  }

  // --- EDIT/OBSERVATION ORDERING BARRIER (the olm fix; single-owner) ---------
  // The shell owns BOTH the transient token pairing AND the observation->reread
  // coupling, so it alone owns their ordering. Without a barrier, followSelected's
  // busy-poll observes an edit's OWN committed write and its reread re-pairs the
  // token to N+1 over the in-flight edit's captured token (N) -> a FRESH token
  // conflicts (Bead olm). The barrier DEFERS (never drops) the follow's reread
  // until the edit settles, then runs it as the follow's reread — preserving
  // mutation -> observation -> reread.
  //
  // editInFlight: a COUNT (not a boolean) so two overlapping edits can't have the
  //   first completion clear the guard while the second is still active. NOTE:
  //   overlapping edits on the SAME object are EXPECTED to conflict on the
  //   second's CAS (correct optimistic concurrency) — the count protects the
  //   TOKEN PAIRING, it does NOT serialize edits.
  // rereadLane: a serialized promise chain. BOTH the follow's reread and the
  //   deferred drain enqueue onto it, so a follow reread can never interleave its
  //   token pairing with a drain (or another reread) already in flight.
  // deferredObservation: a ONE-SLOT marker {objectId} (the follow generator is
  //   self-serializing, so at most one event is ever being processed). Set when an
  //   invalidation arrives while an edit is in flight; drained on success-settle,
  //   cleared on error-settle (the error arm's reread() is the recovery owner).
  let editInFlight = 0;
  let rereadLane = Promise.resolve();
  let deferredObservation = null;
  // Enqueue a reread onto the serialized lane; returns the lane's promise.
  function enqueueReread(fn) {
    const run = rereadLane.then(fn, fn); // run even if a prior reread rejected
    rereadLane = run.catch(() => {}); // the lane itself never stays rejected
    return run;
  }

  // Open the two-pane workspace: navigate the authorized root, present the
  // navigator pane (the root's references) and the inspector pane (the root
  // itself). Both views are opened through the Compositor (which owns the
  // viewIds via re-admission), so the composition/focus/restore architecture
  // applies unchanged. Returns {navigatorViewId, inspectorViewId}.
  async function openWorkspace(rootRef, {authority = null, readBlockId, viewDescriptorFor} = {}) {
    const descriptorFor = typeof viewDescriptorFor === 'function'
      ? viewDescriptorFor
      : () => ({kind: 'canvas', width: 64, height: 64});
    const result = await navigator.navigate(rootRef, {authority, readBlockId});
    const rootPresentation = result.presentations[0];
    // Navigator pane: the SAME navigate result, re-kinded to 'navigator' (the
    // refs are the data; no separate browser model).
    await compositor.openView({
      viewId: NAVIGATOR_VIEW_ID,
      viewDescriptor: descriptorFor(NAVIGATOR_VIEW_ID),
      presentationDescriptor: toDescriptor(rootPresentation, {kind: 'navigator'}),
    });
    // Inspector pane: the root's inspector Presentation, with the writable-slot
    // set threaded so its editable fields are marked (same as inspectSelected).
    const inspectorContext = {...(rootPresentation.context ?? {}), writable};
    await compositor.openView({
      viewId: INSPECTOR_VIEW_ID,
      viewDescriptor: descriptorFor(INSPECTOR_VIEW_ID),
      presentationDescriptor: toDescriptor({...rootPresentation, context: inspectorContext}),
    });
    // Pair the transient token with the root's successful read -> present
    // transition (the root is the initially-inspected object). Replaced on the
    // next reread/subject change; cleared when the subject becomes unreadable.
    pairInspectorToken(result.versionToken ?? null, rootRef.objectId ?? null);
    return Object.freeze({navigatorViewId: NAVIGATOR_VIEW_ID, inspectorViewId: INSPECTOR_VIEW_ID});
  }

  // The user activates a ref (a SELECTION gesture): select it, focus its source
  // view (navigator by default; the inspector passively follows), and update
  // the inspector to the newly-selected object. Ref activation is NOT a
  // CommandRouter dispatch (no Command runs on selection).
  // Returns the inspector's new presentationDescriptor.
  async function selectObject(ref, {
    authority = null, readBlockId, sourceViewId = NAVIGATOR_VIEW_ID,
  } = {}) {
    // The inspected subject is changing: drop the prior object's transient
    // token immediately (it is meaningless for the new subject).
    pairInspectorToken(null, null);
    selectionModel.select(ref);
    compositor.focusView(sourceViewId);
    const descriptor = await inspectSelected({authority, readBlockId});
    return descriptor;
  }

  // Re-navigate the currently-selected object and presentOn the inspector.
  // Used by selectObject and by the observation -> reread path. Returns the
  // inspector's new presentationDescriptor (or null when nothing is selected).
  async function inspectSelected({authority = null, readBlockId} = {}) {
    const selected = selectionModel.selectedSubject();
    if (!selected) return null;
    const result = await navigator.navigate(selected, {authority, readBlockId});
    const presentation = result.presentations[0];
    // Thread the writable-slot set so the projector marks exactly those fields
    // editable. `writable` is host-neutral slot ids (not authority, not a token).
    const context = {...(presentation.context ?? {}), writable};
    const descriptor = toDescriptor({...presentation, context});
    await compositor.presentOn(INSPECTOR_VIEW_ID, descriptor);
    // Pair the transient token with the SUCCESSFUL read -> presentOn transition,
    // keyed to the object it belongs to. A failure presentation (unavailable/
    // unauthorized) carries NO token (navigate omits it), so this clears to null.
    pairInspectorToken(result.versionToken ?? null, selected.objectId ?? null);
    return descriptor;
  }

  // The observation -> reread path. `observe(imageId, ...)` surfaces
  // METADATA-ONLY invalidations {objectId, kind, cursor} for objects the caller
  // may object/read (the authorized lane never surfaces an unreadable object).
  // The shell owns the subscription LIFECYCLE: one observe iterator, FILTERED
  // to the currently-selected identity; on a match, re-navigate the selected
  // ref under per-call authority and presentOn the inspector. There is NO
  // shadow UI-side copy of the object's state — an invalidation triggers a
  // fresh authorized reread. Returns a stop() that aborts the subscription.
  function followSelected({observe, imageId, authority, observationBlockId, readBlockId, onUpdate = null, onError = null, onDeferred = null, signal = null}) {
    if (typeof observe !== 'function') {
      throw new TypeError('followSelected requires an observe(imageId, options) function');
    }
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), {once: true});
    }
    (async () => {
      try {
        for await (const change of observe(imageId, {
          authority, blockId: observationBlockId, signal: controller.signal, intervalMs: 0,
        })) {
          const selected = selectionModel.selectedSubject();
          if (!selected) continue;
          // Filter the image-wide feed to the selected identity (objectId +
          // imageId, defense-in-depth against a broadened lane contract).
          if (change?.objectId !== selected.objectId) continue;
          if (selected.imageId && change?.imageId && change.imageId !== selected.imageId) continue;
          // EDIT/OBSERVATION BARRIER (olm): if an edit is in flight, DEFER the
          // reread (never drop it) until the edit settles. The deferred marker is
          // one slot (the generator is self-serializing). The drain runs after the
          // edit's success path as the follow's reread, preserving
          // mutation -> observation -> reread.
          if (editInFlight > 0) {
            deferredObservation = {objectId: change.objectId};
            // Per-follow observability seam (NOT shell-level shared state): lets a
            // test synchronize on the deferral deterministically. Fires only when
            // an invalidation is actually deferred, never when it is merely absent.
            if (onDeferred) onDeferred(change);
            continue; // defer; the follow generator proceeds to the next event
          }
          // Re-navigate under per-call authority (a fresh authorized reread),
          // serialized on the lane so it can't interleave with a deferred drain.
          const descriptor = await enqueueReread(() => inspectSelected({authority, readBlockId}));
          if (onUpdate) onUpdate(descriptor, change);
        }
      } catch (error) {
        // An abort is a clean stop; anything else is a real follow failure —
        // route it to the caller's onError rather than an unhandled rejection.
        if (!controller.signal.aborted) {
          if (onError) onError(error);
        }
      }
    })();
    return Object.freeze({
      stop: () => controller.abort(),
      signal: controller.signal,
    });
  }

  // ---------------------------------------------------------------------------
  // RENDERER INTENT ROUTING (rows 64/65; Beads 6lm, 4o8+8ik).
  //
  // INVARIANT: renderer intents arrive carrying a TRANSIENT surface handle;
  // bindings name STABLE logical views; the Compositor is the SOLE authority
  // that maps the transient handle to the currently-live view
  // (`compositor.viewForSurfaceHandle`). The shell never captures, stores,
  // refreshes or compares surface handles, keeps no view<->surface state, and
  // never consults the Compositor's durable intent for interaction (durable
  // intent is persistence/restoration information; it lists lost views by design
  // and is never evidence of a live realization). Consequently a binding survives
  // a close/loss + re-open of its logical view unchanged, and an intent labelled
  // with a stale/dead handle is ignored before any binding is consulted.
  //
  // Two binding kinds, both keyed by viewId (unique WITHIN each kind; one
  // activation + one edit binding on the same view is legal):
  //   activation: {viewId, resolveItem(descriptor, key) -> ref | null}
  //   edit:       {viewId, resolveField(descriptor, key) -> plain object | null,
  //                tokenFor(descriptor) -> token | null, commandId (required),
  //                onEdited, onEditError}
  // Public ACTIVATION bindings may name any view, the navigator and inspector
  // included: activation carries no shell-internal state (a pure resolver, then
  // the public selectObject). Public EDIT bindings may NEVER name the inspector,
  // live, lost or absent: the inspector's edit binding is built internally and is
  // the only one carrying the shell's paired inspector token, the olm barrier and
  // the inspector reread. Bindings that carry a `surfaceHandle`, and the retired
  // `navigatorSurfaceHandle`/`inspectorSurfaceHandle` parameters, are rejected
  // loudly (a silently ignored key would silently swallow interactions).
  // ---------------------------------------------------------------------------

  // The 'activate-item' interaction on an already-resolved LIVE view: ask the
  // view's injected pure resolver for a ref, then own ref -> selection.
  async function activateOnView({view, resolveItem, key, authority = null, readBlockId}) {
    const ref = resolveItem(view.presentationDescriptor, key);
    if (!ref || typeof ref.objectId !== 'string') return null;
    await selectObject(ref, {authority, readBlockId, sourceViewId: view.viewId});
    return ref;
  }

  // The public 'activate-item' handler for a caller that names a logical view
  // (row 63; ProjectBrowser's integration calls it directly). The descriptor is
  // the view's CURRENT LIVE presentation from the Compositor's own lookup; an
  // absent or lost view is an explicit no-op and the resolver is NOT consulted.
  // Navigator reference indexing remains the default resolver; a view's semantic
  // owner injects its own without moving its semantics into this module.
  async function handleActivateItem({
    key,
    viewId = NAVIGATOR_VIEW_ID,
    resolveItem = resolveNavigatorItem,
    authority = null,
    readBlockId,
  } = {}) {
    if (typeof resolveItem !== 'function') {
      throw new TypeError('handleActivateItem requires a descriptor-local resolveItem function');
    }
    const view = compositor.liveView(viewId);
    if (!view) return null;
    return activateOnView({view, resolveItem, key, authority, readBlockId});
  }

  // ----- edit bindings (row 65) -----

  function inspectorResolveField(descriptor, key) {
    const fields = descriptor?.parameters?.fields ?? {};
    const writableNow = descriptor?.parameters?.writable ?? [];
    let fieldKey = 0;
    for (const name of Object.keys(fields)) {
      if (writableNow.includes(name)) {
        if (fieldKey === key) return {slot: name};
        fieldKey += 1;
      }
    }
    return null; // stale / out-of-range / non-writable key
  }

  function inspectorTokenFor() {
    // The transient token is valid ONLY if the currently-displayed inspector is
    // still the object it was captured for (it is cleared on subject change).
    const selected = selectionModel.selectedSubject();
    return (selected && selected.objectId === inspectorTokenSubjectId) ? inspectorVersionToken : null;
  }

  function inspectorEditBinding({commandId, onEdited, onEditError, authority, readBlockId}) {
    return Object.freeze({
      viewId: INSPECTOR_VIEW_ID,
      resolveField: inspectorResolveField,
      tokenFor: inspectorTokenFor,
      commandId,
      onEdited,
      onEditError,
      // INTERNAL hooks (not part of the public editBindings schema):
      barrier: true,
      reread: () => inspectSelected({authority, readBlockId}),
    });
  }

  function rejectHandleKey(binding, label) {
    if (binding && typeof binding === 'object' && Object.hasOwn(binding, 'surfaceHandle')) {
      throw new TypeError(`${label} bindings name a logical viewId, never a surfaceHandle (the Compositor resolves the live realization at interaction time)`);
    }
  }

  function normalizeActivationBinding(binding) {
    rejectHandleKey(binding, 'activation');
    if (!binding || typeof binding !== 'object'
        || typeof binding.viewId !== 'string' || binding.viewId.length === 0
        || typeof binding.resolveItem !== 'function') {
      throw new TypeError('each activation binding requires viewId and resolveItem');
    }
    return Object.freeze({viewId: binding.viewId, resolveItem: binding.resolveItem});
  }

  function normalizeEditBinding(binding) {
    rejectHandleKey(binding, 'edit');
    if (!binding || typeof binding !== 'object'
        || typeof binding.viewId !== 'string' || binding.viewId.length === 0
        || typeof binding.resolveField !== 'function') {
      throw new TypeError('each edit binding requires viewId and resolveField');
    }
    if (binding.viewId === INSPECTOR_VIEW_ID) {
      // STRUCTURAL fence, independent of whether the inspector is currently
      // live, lost or absent: only the internally-built inspector binding may
      // carry the shell's paired token, the olm barrier and the inspector reread.
      throw new TypeError('the inspector view is bound through `inspector: true`, never through editBindings');
    }
    if (binding.tokenFor !== undefined && binding.tokenFor !== null && typeof binding.tokenFor !== 'function') {
      throw new TypeError('an edit binding tokenFor must be a function when present');
    }
    for (const hook of ['onEdited', 'onEditError']) {
      if (binding[hook] !== undefined && binding[hook] !== null && typeof binding[hook] !== 'function') {
        throw new TypeError(`an edit binding ${hook} must be a function when present`);
      }
    }
    if (typeof binding.commandId !== 'string' || binding.commandId.length === 0) {
      // Required: a binding that inherited the inspector default would silently
      // dispatch whatever Command the router falls back to for its subject.
      throw new TypeError('each edit binding must declare its commandId (a non-empty string)');
    }
    return Object.freeze({
      viewId: binding.viewId,
      resolveField: binding.resolveField,
      tokenFor: binding.tokenFor ?? null,
      commandId: binding.commandId,
      onEdited: binding.onEdited ?? null,
      onEditError: binding.onEditError ?? null,
      barrier: false,
      reread: null,
    });
  }

  // The resolver's result is plain data or nothing: null is the explicit no-op;
  // a non-null, non-array PLAIN object (prototype Object.prototype or null — the
  // shell's own plainness check; same-realm objects only) that ALSO survives the
  // compositor's data-only JSON round-trip rule ({} included) is the field
  // context; anything else — undefined, a string/number/array, a class instance,
  // a function-bearing object — is a loud error (reported once via the binding's
  // onEditError when present; otherwise it propagates to a direct caller and is
  // swallowed by bindIntents' fire-and-forget path).
  function validateFieldContext(fieldContext) {
    if (fieldContext === null) return null;
    const proto = fieldContext === undefined ? undefined : Object.getPrototypeOf(fieldContext);
    if (typeof fieldContext !== 'object' || Array.isArray(fieldContext)
        || (proto !== Object.prototype && proto !== null)) {
      throw new TypeError('an edit binding resolveField must return null or a plain object (the field context)');
    }
    return assertDataRepresentable(fieldContext, 'edit binding field context');
  }

  async function reportEditError(binding, error) {
    if (!binding.onEditError) throw error;
    // The inspector binding offers its OWN reread; a foreign binding gets no
    // shell-side recovery (reread ownership stays with the view's owner).
    await binding.onEditError(error, binding.reread ? {reread: binding.reread} : {});
    return null;
  }

  // The ONE edit-field handler for every edit binding (inspector included), on
  // an already-resolved LIVE view. `surfaceHandle` is the EMITTED handle: it is
  // passed to CommandRouter.consumeIntent unchanged, which resolves the semantic
  // subject through its own live lookup (no shell-side subject lookup).
  async function handleEditIntent({binding, view, surfaceHandle, key, text, commandRouter}) {
    if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
      throw new TypeError('edit-field routing requires a CommandRouter (consumeIntent)');
    }
    const descriptor = view.presentationDescriptor ?? null;
    // Field resolution (pure, consumer-owned) over the SAME live snapshot the
    // binding was selected by. A stale key is a silent no-op BEFORE the barrier
    // (a no-op edit never dispatches, so it must not leak the in-flight count);
    // a malformed result is a loud, non-dispatching error.
    let fieldContext;
    try {
      fieldContext = validateFieldContext(binding.resolveField(descriptor, key));
    } catch (error) {
      return reportEditError(binding, error);
    }
    if (fieldContext === null) return null;
    // EDIT BARRIER (olm; inspector binding only): taken AFTER the stale-key
    // early-return and BEFORE capturing the transient token (the ordering point
    // is "edit begins"), held across the ENTIRE await consumeIntent + callbacks:
    // the commit window (the CAS commits inside consumeIntent) is exactly where
    // this function is suspended and the follow loop would otherwise re-pair the
    // token. Foreign bindings take NO barrier: it guards the shell's OWN
    // followSelected reread, and other views' follow/edit races belong to their
    // owners.
    if (binding.barrier) editInFlight += 1;
    let succeeded = false;
    try {
      // The consumer's transient token (opaque to the shell).
      let versionToken;
      try {
        versionToken = binding.tokenFor ? binding.tokenFor(descriptor) : null;
      } catch (error) {
        return await reportEditError(binding, error);
      }
      // Route through the CommandRouter (Command discovery/authority/dispatch
      // ownership stays there). The resolver result is NESTED under `field` so it
      // can never collide with or re-target the shell's own keys.
      try {
        const result = await commandRouter.consumeIntent(
          {kind: 'edit-field', key},
          {surfaceHandle, context: {commandId: binding.commandId, text, versionToken, field: fieldContext}},
        );
        // `result` is the router's result VERBATIM; null means "not routed" (the
        // view is gone / has no subject / no applicable Command), not success.
        if (binding.onEdited) await binding.onEdited(result);
        succeeded = true;
        return result;
      } catch (error) {
        // The inspector's error arm NEVER leaves a dead-end: it offers a fresh
        // authorized reread so the inspector reflects the image's current value.
        return await reportEditError(binding, error);
      }
    } finally {
      if (binding.barrier) {
        editInFlight -= 1;
        if (editInFlight === 0 && deferredObservation !== null) {
          if (succeeded) {
            // DRAIN-ON-SUCCESS: the deferred invalidation was self-observation of
            // the edit's own committed write. Run the follow's reread NOW, on the
            // serialized lane (so it can't interleave with a subsequent follow
            // reread). This pairs the token to the current version and is the
            // mutation -> observation -> reread acceptance property.
            const deferredObjectId = deferredObservation.objectId;
            deferredObservation = null;
            // Fire-and-forget onto the lane; the follow loop's next event will
            // observe nothing new (the cursor advanced) and idle. Errors here are
            // the follow path's concern (onError), not the edit's.
            enqueueReread(() => {
              // Re-check the subject INSIDE the enqueued reread (not just at
              // enqueue time): a selectObject during the defer window runs its OWN
              // inspectSelected for the NEW subject (bypassing the lane) and pairs
              // its token. If the subject has moved on by the time this drain runs,
              // the deferred observation for the OLD subject is moot — skip it
              // rather than re-present/re-pair the new subject with stale context.
              const now = selectionModel.selectedSubject();
              if (!now || now.objectId !== deferredObjectId) return null;
              return binding.reread();
            }).catch(() => {});
          } else {
            // CLEAR-ON-ERROR: the edit did not commit (denied) or conflicted on an
            // external write. The error arm's reread() (if the caller takes it) is
            // the recovery owner; a declined reread is re-observed by the follow
            // loop's next poll. Draining here would double-reread against the error
            // arm's recovery.
            deferredObservation = null;
          }
        }
      }
    }
  }

  // The INSPECTOR edit path (public): an edit-field intent {key, text} that
  // arrived on `surfaceHandle`. The handle is resolved through the Compositor to
  // its live view, which must be the inspector; a present handle that resolves
  // to no live view (or another view) is an explicit no-op, an absent/non-string
  // handle is a loud error (never a silently swallowed edit).
  async function handleEditField({key, text, surfaceHandle, commandId = 'set-title', commandRouter, authority = null, readBlockId, onEdited = null, onEditError = null, ...rest} = {}) {
    if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
      throw new TypeError('handleEditField requires a CommandRouter (consumeIntent)');
    }
    if (Object.hasOwn(rest, 'inspectorSurfaceHandle')) {
      throw new TypeError('handleEditField: `inspectorSurfaceHandle` was retired; pass the emitted `surfaceHandle` (the Compositor resolves the live inspector from it)');
    }
    if (typeof surfaceHandle !== 'string' || surfaceHandle.length === 0) {
      throw new TypeError('handleEditField requires the emitted surfaceHandle (a non-empty string)');
    }
    const view = compositor.viewForSurfaceHandle(surfaceHandle);
    if (!view || view.viewId !== INSPECTOR_VIEW_ID) return null;
    const binding = inspectorEditBinding({commandId, onEdited, onEditError, authority, readBlockId});
    return handleEditIntent({binding, view, surfaceHandle, key, text, commandRouter});
  }

  // Wire the shell to a host's intent seam (HOST-NEUTRAL: the plain-data
  // intents {kind:'activate-item'|'edit-field', key, ...} are not DOM-specific;
  // a browser DOM adapter, the Linux GTK bridge, or any host supplies an
  // `onIntent(handler)` seam that calls handler(intent, surfaceHandle)).
  //   navigator: true  -> the shell's activation binding for the navigator view
  //                       (reference-row indexing);
  //   inspector: true  -> the shell's internal edit binding for the inspector view
  //                       (requires commandRouter; the top-level commandId/
  //                       onEdited/onEditError apply to THIS binding only);
  //   activationBindings / editBindings -> view-keyed tables (see the block
  //                       comment above).
  // Routing: kind first; then the Compositor resolves the emitted handle to the
  // live view (a stale/dead handle is ignored before any binding is consulted);
  // then the binding of that kind for view.viewId, resolved over that SAME live
  // snapshot. Other intents (e.g. a Component pointer 'activate') are ignored
  // here (CommandRouter owns those). Returns an unsubscribe.
  function bindIntents({
    adapter,
    // The public flags are `navigator` / `inspector`; they are aliased locally so
    // the flag never shadows the injected ObjectNavigator (`navigator`) in scope.
    navigator: bindNavigator = false,
    inspector: bindInspector = false,
    activationBindings = [],
    editBindings = [],
    commandRouter = null,
    commandId = 'set-title',
    authority = null,
    readBlockId,
    onEdited = null,
    onEditError = null,
    ...rest
  } = {}) {
    if (!adapter || typeof adapter.onIntent !== 'function') {
      throw new TypeError('bindIntents requires an adapter with onIntent');
    }
    for (const retired of ['navigatorSurfaceHandle', 'inspectorSurfaceHandle']) {
      if (Object.hasOwn(rest, retired)) {
        throw new TypeError(`bindIntents: \`${retired}\` was retired; bindings name logical views — use \`${retired === 'navigatorSurfaceHandle' ? 'navigator' : 'inspector'}: true\``);
      }
    }
    if (!Array.isArray(activationBindings)) throw new TypeError('activationBindings must be an array');
    if (!Array.isArray(editBindings)) throw new TypeError('editBindings must be an array');
    const activations = new Map();
    const addActivation = (binding) => {
      if (activations.has(binding.viewId)) {
        throw new TypeError(`activation bindings must be unique per viewId (${binding.viewId})`);
      }
      activations.set(binding.viewId, binding);
    };
    if (bindNavigator) addActivation(Object.freeze({viewId: NAVIGATOR_VIEW_ID, resolveItem: resolveNavigatorItem}));
    for (const binding of activationBindings) addActivation(normalizeActivationBinding(binding));
    const edits = new Map();
    if (bindInspector || editBindings.length > 0) {
      if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
        throw new TypeError('bindIntents: edit-field routing (inspector: true or editBindings) requires a CommandRouter (consumeIntent)');
      }
    }
    if (bindInspector) {
      edits.set(INSPECTOR_VIEW_ID, inspectorEditBinding({commandId, onEdited, onEditError, authority, readBlockId}));
    }
    for (const binding of editBindings) {
      const normalized = normalizeEditBinding(binding);
      if (edits.has(normalized.viewId)) {
        throw new TypeError(`edit bindings must be unique per viewId (${normalized.viewId})`);
      }
      edits.set(normalized.viewId, normalized);
    }
    return adapter.onIntent((intent, surfaceHandle) => {
      const kind = intent?.kind;
      if (kind !== 'activate-item' && kind !== 'edit-field') return;
      // The Compositor is the sole authority for the emitted handle -> live view.
      const view = compositor.viewForSurfaceHandle(surfaceHandle);
      if (!view) return; // stale/dead handle: ignored before any binding is consulted
      if (kind === 'activate-item') {
        const binding = activations.get(view.viewId);
        if (!binding) return;
        // Fire-and-forget; errors route nowhere (the handler is best-effort UI).
        activateOnView({view, resolveItem: binding.resolveItem, key: intent.key, authority, readBlockId}).catch(() => {});
        return;
      }
      const binding = edits.get(view.viewId);
      if (!binding) return;
      // Errors are reported ONCE, inside the handler, via the binding's own
      // onEditError; without one they are swallowed here (best-effort UI).
      handleEditIntent({binding, view, surfaceHandle, key: intent.key, text: intent.text, commandRouter}).catch(() => {});
    });
  }

  return Object.freeze({
    openWorkspace,
    selectObject,
    inspectSelected,
    followSelected,
    handleActivateItem,
    handleEditField,
    bindIntents,
    navigatorViewId: NAVIGATOR_VIEW_ID,
    inspectorViewId: INSPECTOR_VIEW_ID,
    // Read-only inspection seam for tests: the transient token paired with the
    // currently-displayed inspector (NEVER exposed on a descriptor). Lets a test
    // prove the token's lifecycle (set on presentOn, cleared on subject change)
    // without it ever leaking into Presentation/SemanticUi/durableIntent data.
    _inspectorToken: () => ({token: inspectorVersionToken, objectId: inspectorTokenSubjectId}),
  });
}

export {createEnvironmentShell};
export default {createEnvironmentShell};
