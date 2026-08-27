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

function createEnvironmentShell({navigator, selectionModel, compositor}) {
  if (!navigator || typeof navigator.navigate !== 'function') {
    throw new TypeError('createEnvironmentShell requires an ObjectNavigator (navigate)');
  }
  if (!selectionModel || typeof selectionModel.select !== 'function') {
    throw new TypeError('createEnvironmentShell requires a SelectionModel');
  }
  if (!compositor || typeof compositor.openView !== 'function') {
    throw new TypeError('createEnvironmentShell requires a Compositor');
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
    // Inspector pane: the root's inspector Presentation.
    await compositor.openView({
      viewId: INSPECTOR_VIEW_ID,
      viewDescriptor: descriptorFor(INSPECTOR_VIEW_ID),
      presentationDescriptor: toDescriptor(rootPresentation),
    });
    return Object.freeze({navigatorViewId: NAVIGATOR_VIEW_ID, inspectorViewId: INSPECTOR_VIEW_ID});
  }

  // The user activates a ref (a SELECTION gesture): select it, focus the
  // navigator pane (the user is interacting there; the inspector passively
  // follows), and update the inspector to the newly-selected object. Ref
  // activation is NOT a CommandRouter dispatch (no Command runs on selection).
  // Returns the inspector's new presentationDescriptor.
  async function selectObject(ref, {authority = null, readBlockId} = {}) {
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
    const descriptor = toDescriptor(presentation);
    await compositor.presentOn(INSPECTOR_VIEW_ID, descriptor);
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

  return Object.freeze({
    openWorkspace,
    selectObject,
    inspectSelected,
    followSelected,
    navigatorViewId: NAVIGATOR_VIEW_ID,
    inspectorViewId: INSPECTOR_VIEW_ID,
  });
}

export {createEnvironmentShell};
export default {createEnvironmentShell};
