/**
 * EnvironmentShell — the selection -> inspector-presentation orchestration
 * owner (docs/ownership.md). This is the first USEFUL composed environment: an
 * authorized root/reference NAVIGATOR pane beside a generic INSPECTOR pane,
 * arranged in a split composition.
 *
 * OWNERSHIP (narrow, fenced): the shell owns EXACTLY ONE coupling — "when the
 * semantic selection changes, choose/update the inspector view's Presentation."
 * Nothing else owns that today (SelectionModel owns selection state; the
 * Compositor owns views; neither couples them). The shell does NOT:
 *  - read the image directly (every read goes through ObjectNavigator.navigate,
 *    which owns the unauthorized-ref/unavailable-ref materialization);
 *  - own authority (threaded per-call, never stored);
 *  - own presentation/command discovery (the registries, via ObjectNavigator);
 *  - own the composition tree, focus, or rendering.
 * It is a HEADLESS, renderer-independent core: it consumes ObjectNavigator /
 * SelectionModel / Compositor through their public APIs and never imports DOM.
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

const NAVIGATOR_VIEW_ID = 'navigator-view';
const INSPECTOR_VIEW_ID = 'inspector-view';

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

  // The user activates a ref (a SELECTION gesture): select it, focus the
  // navigator pane (the user is interacting there; the inspector passively
  // follows), and update the inspector to the newly-selected object. Ref
  // activation is NOT a CommandRouter dispatch (no Command runs on selection).
  // Returns the inspector's new presentationDescriptor.
  async function selectObject(ref, {authority = null, readBlockId} = {}) {
    // The inspected subject is changing: drop the prior object's transient
    // token immediately (it is meaningless for the new subject).
    pairInspectorToken(null, null);
    selectionModel.select(ref);
    compositor.focusView(NAVIGATOR_VIEW_ID);
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
  function followSelected({observe, imageId, authority, observationBlockId, readBlockId, onUpdate = null, onError = null, signal = null}) {
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
          // Re-navigate under per-call authority (a fresh authorized reread).
          const descriptor = await inspectSelected({authority, readBlockId});
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
  // DOM ref-row activation -> selection; NOT CommandRouter). A DOM realizer emits
  // {kind:'activate-item', key} where `key` is a DESCRIPTOR-LOCAL index into the
  // navigator view's CURRENT presentationDescriptor.parameters.references. The
  // shell resolves key -> ref against the Compositor's OWN Presentation data,
  // then selects it. A STALE/out-of-range key resolves to null and does NOT
  // select (never throws, never resolves a wrong ref). Returns the selected ref
  // (or null). This is the ONLY place a renderer-supplied key becomes a semantic
  // ref — the key itself is meaningless without the current descriptor.
  async function handleActivateItem({key, authority = null, readBlockId} = {}) {
    const view = compositor.durableIntent().find((v) => v.viewId === NAVIGATOR_VIEW_ID);
    const references = view?.presentationDescriptor?.parameters?.references;
    if (!Array.isArray(references) || typeof key !== 'number' || key < 0 || key >= references.length) {
      return null; // stale / out-of-range key: no selection, no throw.
    }
    const ref = references[key];
    if (!ref || typeof ref.objectId !== 'string') return null;
    await selectObject(ref, {authority, readBlockId});
    return ref;
  }

  // The 'edit-field' intent handler — the shell's SECOND ownership row (see
  // docs/ownership.md): it resolves an INSPECTOR-local {kind:'edit-field', key,
  // text} against the CURRENT inspector descriptor (key -> slot) and attaches the
  // current transient versionToken, then routes the resulting semantic operation
  // through the EXISTING CommandRouter.consumeIntent() path (CommandRegistry ->
  // fresh authorityProvider -> CommandDispatcher/ImageClientAdapter). The shell
  // does NOT build a Command, does NOT dispatch directly, and does NOT decide
  // value semantics — CommandRouter retains semantic-intent -> Command/authority/
  // dispatch ownership. The RAW text passes through unparsed (text is the only
  // editable scalar; the registered Command owns the canonical text mutation).
  async function handleEditField({key, text, commandId = 'set-title', commandRouter, inspectorSurfaceHandle, authority = null, readBlockId, onEdited = null, onEditError = null}) {
    if (!commandRouter || typeof commandRouter.consumeIntent !== 'function') {
      throw new TypeError('handleEditField requires a CommandRouter (consumeIntent)');
    }
    // Resolve key -> slot against the CURRENT inspector descriptor. A stale /
    // out-of-range key, or a key naming a non-writable slot, is an explicit
    // no-op (never throws, never resolves a wrong slot).
    const view = compositor.durableIntent().find((v) => v.viewId === INSPECTOR_VIEW_ID);
    const fields = view?.presentationDescriptor?.parameters?.fields ?? {};
    const writableNow = view?.presentationDescriptor?.parameters?.writable ?? [];
    let fieldKey = 0;
    let slot = null;
    for (const name of Object.keys(fields)) {
      if (writableNow.includes(name)) {
        if (fieldKey === key) { slot = name; break; }
        fieldKey += 1;
      }
    }
    if (slot === null) return null; // stale/non-writable key
    // The transient token is valid ONLY if the currently-displayed inspector is
    // still the object it was captured for (it is cleared on subject change).
    const selected = selectionModel.selectedSubject();
    const versionToken = (selected && selected.objectId === inspectorTokenSubjectId)
      ? inspectorVersionToken
      : null;
    try {
      const result = await commandRouter.consumeIntent(
        {kind: 'edit-field', key},
        {surfaceHandle: inspectorSurfaceHandle, context: {commandId, slot, text, versionToken}},
      );
      if (onEdited) await onEdited(result);
      return result;
    } catch (error) {
      // The error arm NEVER leaves a dead-end: offer a fresh authorized reread so
      // the inspector reflects the image's current value (the user can retry).
      if (onEditError) await onEditError(error, {reread: () => inspectSelected({authority, readBlockId})});
      else throw error;
      return null;
    }
  }

  // Wire the shell to the renderer's intent seam: on a DOM {kind:'activate-item',
  // key} from the NAVIGATOR view's surface, resolve the key and select. Other
  // intents (e.g. a Component pointer 'activate') are ignored here (CommandRouter
  // owns those). `navigatorSurfaceHandle` is the navigator view's surface handle;
  // the shell resolves it via the Compositor's view map. Returns an unsubscribe.
  function bindDomIntents({adapter, navigatorSurfaceHandle, authority = null, readBlockId} = {}) {
    if (!adapter || typeof adapter.onIntent !== 'function') {
      throw new TypeError('bindDomIntents requires an adapter with onIntent');
    }
    return adapter.onIntent((intent, surfaceHandle) => {
      if (intent?.kind !== 'activate-item') return;
      if (surfaceHandle !== navigatorSurfaceHandle) return;
      // Fire-and-forget; errors route nowhere (the handler is best-effort UI).
      handleActivateItem({key: intent.key, authority, readBlockId}).catch(() => {});
    });
  }

  return Object.freeze({
    openWorkspace,
    selectObject,
    inspectSelected,
    followSelected,
    handleActivateItem,
    handleEditField,
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
