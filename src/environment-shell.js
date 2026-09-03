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
 *      EDIT BINDINGS (surface -> live view + a PURE consumer-owned field resolver
 *      + a consumer-owned transient-token supplier) to CommandRouter" (the
 *      edit-field row in docs/ownership.md; Bead 6lm). The inspector is one
 *      binding, built internally (key -> writable slot; the shell's own paired
 *      token; the olm barrier). It does NOT dispatch, build Commands, or own
 *      value semantics — CommandRouter retains semantic-intent -> Command/
 *      authority/dispatch ownership.
 *  (3) "resolve a renderer activate-item key against the CURRENT descriptor of
 *      its bound source view, then select the resulting ref". The descriptor-
 *      local resolver is injected by that view's semantic owner; the shell owns
 *      only renderer action -> selection orchestration.
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

  // The 'activate-item' intent handler (the shell-boundary interaction owner for
  // renderer item activation -> selection; NOT CommandRouter). A host emits
  // {kind:'activate-item', key} where `key` is meaningful only to one view's
  // CURRENT presentationDescriptor. The shell asks that view's injected pure
  // resolver for a ref, then owns the ref -> selection interaction. Navigator
  // reference indexing remains the default; ProjectBrowser injects its own
  // member resolver without moving Project semantics into this module.
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
    const view = compositor.durableIntent().find((candidate) => candidate.viewId === viewId);
    const ref = resolveItem(view?.presentationDescriptor ?? null, key);
    if (!ref || typeof ref.objectId !== 'string') return null;
    await selectObject(ref, {authority, readBlockId, sourceViewId: viewId});
    return ref;
  }

  // ---------------------------------------------------------------------------
  // 'edit-field' routing — the shell's SECOND ownership row (docs/ownership.md
  // "Renderer edit-field intent -> edit binding -> CommandRouter", Bead 6lm).
  //
  // An EDIT BINDING names exactly one renderer surface, the logical view that
  // surface realizes, a PURE consumer-owned field resolver and an optional
  // consumer-owned transient-token supplier:
  //   {surfaceHandle, viewId, resolveField(descriptor, key) -> plain object | null,
  //    tokenFor(descriptor) -> token | null, commandId, onEdited, onEditError}
  // On {kind:'edit-field', key, text} from that surface the shell:
  //   1. resolves the LIVE view for the surface (compositor.viewForSurfaceHandle —
  //      the same source CommandRouter.consumeIntent uses for the subject, so the
  //      descriptor and the dispatched subject can never belong to different
  //      views); `viewId` is an assertion — a mismatch is an explicit no-op;
  //   2. asks the binding's resolver for the descriptor-local field context:
  //      null = stale/unknown key = explicit no-op (never a wrong field); a plain
  //      data-only object (possibly {}) = dispatch; anything else = loud error;
  //   3. asks the binding's tokenFor(descriptor) for the transient version token
  //      (the shell stores/interprets NO token for foreign views — concurrency
  //      semantics stay with the view's owner);
  //   4. routes through commandRouter.consumeIntent({kind:'edit-field', key},
  //      {surfaceHandle, context: {commandId, text, versionToken, field}}) — the
  //      resolver result is NESTED under `field` so it can never collide with the
  //      shell's own keys (a resolver could otherwise re-target the Command via
  //      context.commandId). The shell builds NO Command and dispatches nothing
  //      itself; the RAW text passes through unparsed.
  // The inspector is ONE such binding, constructed internally: its resolver is
  // the key -> writable-slot walk over the inspector descriptor, its tokenFor is
  // the shell's own paired inspector token, and it carries two INTERNAL hooks no
  // public binding can set — the olm edit barrier (which guards the shell's OWN
  // followSelected reread ordering) and the inspector reread offered on error.
  // Nothing here is view-specific beyond that: no field semantics, no storage
  // representation, no assumption about what a Command does with `field`.
  // Consumers hold a binding only as long as its surface handle is live: a
  // re-opened view mints a fresh handle and must be re-bound (Bead 4o8).
  // ---------------------------------------------------------------------------

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

  function inspectorEditBinding({inspectorSurfaceHandle, commandId, onEdited, onEditError, authority, readBlockId}) {
    return Object.freeze({
      surfaceHandle: inspectorSurfaceHandle,
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

  function normalizeEditBinding(binding) {
    if (!binding || typeof binding !== 'object'
        || binding.surfaceHandle === null || binding.surfaceHandle === undefined
        || typeof binding.viewId !== 'string' || binding.viewId.length === 0
        || typeof binding.resolveField !== 'function') {
      throw new TypeError('each edit binding requires surfaceHandle, viewId and resolveField');
    }
    if (binding.tokenFor !== undefined && binding.tokenFor !== null && typeof binding.tokenFor !== 'function') {
      throw new TypeError('an edit binding tokenFor must be a function when present');
    }
    for (const hook of ['onEdited', 'onEditError']) {
      if (binding[hook] !== undefined && binding[hook] !== null && typeof binding[hook] !== 'function') {
        throw new TypeError(`an edit binding ${hook} must be a function when present`);
      }
    }
    if (binding.viewId === INSPECTOR_VIEW_ID) {
      // The inspector is bound ONLY through inspectorSurfaceHandle: its binding
      // carries the shell-internal barrier/reread hooks and the shell's own paired
      // token. A public binding on the inspector view would drive the shell's own
      // inspector with a foreign token and no barrier.
      throw new TypeError('the inspector view is bound through inspectorSurfaceHandle, not editBindings');
    }
    if (typeof binding.commandId !== 'string' || binding.commandId.length === 0) {
      // Required: a binding that inherited the inspector default would silently
      // dispatch whatever Command the router falls back to for its subject.
      throw new TypeError('each edit binding must declare its commandId (a non-empty string)');
    }
    return Object.freeze({
      surfaceHandle: binding.surfaceHandle,
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

  // The ONE edit-field handler for every edit binding (inspector included).
  async function handleEditIntent({binding, key, text, commandRouter}) {
    if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
      throw new TypeError('edit-field routing requires a CommandRouter (consumeIntent)');
    }
    // 1. The LIVE view for this surface; the binding's viewId is an assertion.
    const view = compositor.viewForSurfaceHandle(binding.surfaceHandle);
    if (!view || view.viewId !== binding.viewId) return null;
    const descriptor = view.presentationDescriptor ?? null;
    // 2. Field resolution (pure, consumer-owned). A stale key is a silent no-op
    //    BEFORE the barrier (a no-op edit never dispatches, so it must not leak
    //    the in-flight count); a malformed result is a loud, non-dispatching error.
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
      // 3. The consumer's transient token (opaque to the shell).
      let versionToken;
      try {
        versionToken = binding.tokenFor ? binding.tokenFor(descriptor) : null;
      } catch (error) {
        return await reportEditError(binding, error);
      }
      // 4. Route through the CommandRouter (Command discovery/authority/dispatch
      //    ownership stays there).
      try {
        const result = await commandRouter.consumeIntent(
          {kind: 'edit-field', key},
          {surfaceHandle: binding.surfaceHandle, context: {commandId: binding.commandId, text, versionToken, field: fieldContext}},
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

  // The INSPECTOR edit path (public, source-compatible): resolves an
  // inspector-local {key, text} against the CURRENT inspector descriptor
  // (key -> writable slot, nested as context.field.slot) and attaches the
  // shell's paired transient token, through the one shared handler above.
  async function handleEditField({key, text, commandId = 'set-title', commandRouter, inspectorSurfaceHandle, authority = null, readBlockId, onEdited = null, onEditError = null}) {
    if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
      throw new TypeError('handleEditField requires a CommandRouter (consumeIntent)');
    }
    const binding = inspectorEditBinding({inspectorSurfaceHandle, commandId, onEdited, onEditError, authority, readBlockId});
    return handleEditIntent({binding, key, text, commandRouter});
  }

  // Wire the shell to a host's intent seam (HOST-NEUTRAL: the plain-data
  // intents {kind:'activate-item'|'edit-field', key, ...} are not DOM-specific;
  // a browser DOM adapter, the Linux GTK bridge, or any host supplies an
  // `onIntent` seam and the surface handles). Routes by (kind, surface):
  //   {kind:'activate-item'} from a bound activation surface ->
  //     handleActivateItem (selection; the shell's action row),
  //   {kind:'edit-field'} from a bound EDIT surface -> handleEditIntent with
  //     that surface's edit binding (the inspector, when inspectorSurfaceHandle
  //     is given, is one such binding; `editBindings` adds others).
  // An activation binding and an edit binding MAY share a surface (a view can
  // have rows AND editable fields); surfaces are unique WITHIN each kind.
  // Other intents (e.g. a Component pointer 'activate') are ignored here
  // (CommandRouter owns those). A CommandRouter is required whenever any edit
  // binding exists. Returns an unsubscribe.
  function bindIntents({
    adapter,
    navigatorSurfaceHandle = null,
    activationBindings = [],
    inspectorSurfaceHandle = null,
    editBindings = [],
    commandRouter = null,
    commandId = 'set-title',
    authority = null,
    readBlockId,
    onEdited = null,
    onEditError = null,
  } = {}) {
    if (!adapter || typeof adapter.onIntent !== 'function') {
      throw new TypeError('bindIntents requires an adapter with onIntent');
    }
    if (!Array.isArray(activationBindings)) {
      throw new TypeError('activationBindings must be an array');
    }
    if (!Array.isArray(editBindings)) {
      throw new TypeError('editBindings must be an array');
    }
    const bindings = [];
    if (navigatorSurfaceHandle !== null) {
      bindings.push({
        surfaceHandle: navigatorSurfaceHandle,
        viewId: NAVIGATOR_VIEW_ID,
        resolveItem: resolveNavigatorItem,
      });
    }
    for (const binding of activationBindings) {
      if (!binding || binding.surfaceHandle === null || binding.surfaceHandle === undefined
          || typeof binding.viewId !== 'string' || binding.viewId.length === 0
          || typeof binding.resolveItem !== 'function') {
        throw new TypeError('each activation binding requires surfaceHandle, viewId and resolveItem');
      }
      if (bindings.some(({surfaceHandle}) => surfaceHandle === binding.surfaceHandle)) {
        throw new TypeError('activation surfaceHandle bindings must be unique');
      }
      bindings.push({
        surfaceHandle: binding.surfaceHandle,
        viewId: binding.viewId,
        resolveItem: binding.resolveItem,
      });
    }
    const edits = [];
    if (inspectorSurfaceHandle !== null || editBindings.length > 0) {
      if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
        throw new TypeError('bindIntents: edit-field routing (inspectorSurfaceHandle or editBindings) requires a CommandRouter (consumeIntent)');
      }
    }
    if (inspectorSurfaceHandle !== null) {
      edits.push(inspectorEditBinding({inspectorSurfaceHandle, commandId, onEdited, onEditError, authority, readBlockId}));
    }
    for (const binding of editBindings) {
      const normalized = normalizeEditBinding(binding);
      if (edits.some(({surfaceHandle}) => surfaceHandle === normalized.surfaceHandle)) {
        throw new TypeError('edit surfaceHandle bindings must be unique (the inspector surface is taken by inspectorSurfaceHandle)');
      }
      edits.push(normalized);
    }
    return adapter.onIntent((intent, surfaceHandle) => {
      if (intent?.kind === 'activate-item') {
        const activation = bindings.find((binding) => binding.surfaceHandle === surfaceHandle);
        if (!activation) return;
        // Fire-and-forget; errors route nowhere (the handler is best-effort UI).
        handleActivateItem({
          key: intent.key,
          viewId: activation.viewId,
          resolveItem: activation.resolveItem,
          authority,
          readBlockId,
        }).catch(() => {});
        return;
      }
      if (intent?.kind === 'edit-field') {
        const edit = edits.find((binding) => binding.surfaceHandle === surfaceHandle);
        if (!edit) return;
        // Errors are reported ONCE, inside the handler, via the binding's own
        // onEditError; without one they are swallowed here (best-effort UI).
        handleEditIntent({binding: edit, key: intent.key, text: intent.text, commandRouter}).catch(() => {});
      }
    });
  }

  // Back-compat alias for the browser DOM host (navigator selection only). The
  // intents were always host-neutral; this name predates the generalization.
  function bindDomIntents({adapter, navigatorSurfaceHandle, authority = null, readBlockId} = {}) {
    return bindIntents({adapter, navigatorSurfaceHandle, authority, readBlockId});
  }

  return Object.freeze({
    openWorkspace,
    selectObject,
    inspectSelected,
    followSelected,
    handleActivateItem,
    handleEditField,
    bindIntents,
    bindDomIntents,
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
