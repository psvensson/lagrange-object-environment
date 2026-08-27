import {RendererResourceLostError} from './renderer-errors.js';

/**
 * Compositor: the single owner of the LOGICAL composition/view lifecycle
 * (docs/ownership.md; ADR 0011 §2). It decides which presentation is shown,
 * its arrangement intent, and when a logical view enters/leaves the Session.
 *
 * It NEVER touches DOM/WebGPU/native GPU objects, and never implements
 * GPU/WIT. Realization is delegated to an injected RendererAdapter across a
 * coarse-grained, lifecycle-oriented, DATA-representable boundary:
 *
 *   createSurface(viewDescriptor)            -> surfaceHandle (opaque string)
 *   attachPresentation(handle, presentationDescriptor)
 *   detachPresentation(handle)
 *   resize(handle, {width, height})
 *   destroySurface(handle)
 *   destroyAll()                              (idempotent; Session teardown)
 *
 * REMOTE-FRIENDLINESS (constraint, ADR 0011 §2/§3): this boundary is one level
 * ABOVE wasi:webgpu. Everything crossing it is data — opaque string handles and
 * plain JSON descriptors — so a future RemoteRendererAdapter could move the
 * renderer to another machine and stream surfaces/frames back, WITHOUT changing
 * Compositor/Presentation/Perspective semantics and WITHOUT proxying raw GPU
 * calls. No callbacks, no live objects, no Component/module references cross.
 *
 * presentationDescriptor is a PLAIN JSON object:
 *   {kind: string, subject: <image-ref-Value-as-data>, parameters: <plain JSON>}
 * It is NOT a model.js Presentation instance, NOT a Component, and carries no
 * callbacks (semantic interaction returns via the Command path, ADR 0011 §6).
 *
 * LIFETIME: surface handles are TRANSIENT and Session-scoped. They live only in
 * this Compositor's private view map — never in Session.state, never in a
 * Perspective or the image. A Perspective is rebuilt from durable intent
 * ({viewId, presentationDescriptor}) only; the surfaceHandle is structurally
 * excluded from anything reaching perspective-projection.
 */

// The boundary's method set. Adding a raw-GPU-sounding op (writeBuffer, submit,
// ...) is caught by the contract test — the boundary is lifecycle, not GPU.
const RENDERER_ADAPTER_METHODS = Object.freeze([
  'createSurface',
  'attachPresentation',
  'detachPresentation',
  'resize',
  'destroySurface',
  'destroyAll',
]);

// Assert a value is data-representable: JSON round-trip deep-equality. A
// callback, class instance, Symbol or undefined field silently dropped by
// JSON.stringify would FAIL this check (it must, not pass).
function assertDataRepresentable(value, label) {
  let roundTrip;
  try {
    roundTrip = JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError(`${label} must be data-representable (JSON-serializable)`);
  }
  if (!deepEqual(roundTrip, value)) {
    throw new TypeError(
      `${label} must be data-representable: it does not survive a JSON round trip (a callback, class instance or non-JSON value would cross the renderer boundary)`,
    );
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  // NaN: JSON round-trips to null, so deepEqual(NaN, null) is false — correct.
  return false;
}

function requireViewDescriptor(viewDescriptor) {
  assertDataRepresentable(viewDescriptor, 'viewDescriptor');
  if (typeof viewDescriptor.kind !== 'string' || viewDescriptor.kind.length === 0) {
    throw new TypeError('viewDescriptor.kind must be a non-empty string');
  }
  return viewDescriptor;
}

function requirePresentationDescriptor(presentationDescriptor) {
  assertDataRepresentable(presentationDescriptor, 'presentationDescriptor');
  if (typeof presentationDescriptor.kind !== 'string' || presentationDescriptor.kind.length === 0) {
    throw new TypeError('presentationDescriptor.kind must be a non-empty string naming a renderer-resolved presentation kind');
  }
  return presentationDescriptor;
}

function requireHandle(surfaceHandle, label = 'surfaceHandle') {
  if (typeof surfaceHandle !== 'string' || surfaceHandle.length === 0) {
    throw new TypeError(`${label} must be an opaque string surface handle`);
  }
  return surfaceHandle;
}

function createCompositor({rendererAdapter} = {}) {
  if (!rendererAdapter || typeof rendererAdapter !== 'object') {
    throw new TypeError('createCompositor requires a RendererAdapter');
  }
  for (const method of RENDERER_ADAPTER_METHODS) {
    if (typeof rendererAdapter[method] !== 'function') {
      throw new TypeError(`RendererAdapter is missing required method: ${method}`);
    }
  }

  // The ONLY place surface handles exist: a private, Session-scoped map.
  // viewId -> {viewDescriptor, presentationDescriptor, surfaceHandle, status}.
  // This map is never persisted; the Perspective is rebuilt from the durable
  // intent ({viewId, viewDescriptor, presentationDescriptor}) alone.
  const views = new Map();
  let nextViewOrdinal = 0;
  let destroyed = false;

  function requireAlive() {
    if (destroyed) {
      throw new RendererResourceLostError('the compositor (Session composition) has been destroyed');
    }
  }

  function requireLiveView(viewId) {
    const view = views.get(viewId);
    if (!view) {
      throw new RendererResourceLostError(`no such logical view: ${viewId}`);
    }
    return view;
  }

  // Map a raw adapter throw to a typed renderer error, marking the view lost
  // but keeping its durable descriptor so a later restore can recreate it. The
  // Session and other views survive.
  function mapAdapterFailure(viewId, error) {
    const view = views.get(viewId);
    if (view) {
      view.status = 'lost';
      view.surfaceHandle = null;
    }
    if (error instanceof RendererResourceLostError) return error;
    return new RendererResourceLostError(
      `renderer resource for view ${viewId} was lost: ${error?.message ?? error}`,
      {cause: error},
    );
  }

  /**
   * Open a logical view: create its surface and attach its presentation.
   * Returns the logical viewId (durable intent handle, NOT a renderer handle).
   */
  // The Compositor is the SOLE owner of viewId allocation and admission. A
  // caller-supplied viewId is NOT the caller inventing identity — it is the
  // RE-ADMISSION of a previously-issued durable ID on the restore path. Both
  // paths enforce uniqueness against the live set; a collision is a typed error.
  function admitViewId(candidate) {
    if (views.has(candidate)) {
      // An IDENTITY/admission conflict (not a lost renderer resource): a
      // supplied durable ID collides with an already-live view.
      throw new TypeError(`a live view already holds viewId "${candidate}" (viewId allocation is Compositor-owned; a restore must not collide with a live view)`);
    }
    return candidate;
  }

  // Mint a fresh auto viewId, skipping any candidate already live (a restored
  // caller-supplied ID may occupy an early ordinal).
  function mintViewId() {
    let candidate = `view-${nextViewOrdinal++}`;
    while (views.has(candidate)) {
      candidate = `view-${nextViewOrdinal++}`;
    }
    return candidate;
  }

  /**
   * Open a logical view: create its surface and attach its presentation.
   * Returns the logical viewId (durable intent handle, NOT a renderer handle).
   *
   * viewId is OPTIONAL. Omit it to mint a fresh durable ID (a genuinely new
   * view). Supply it to RE-ADMIT a previously-persisted durable ID (restore):
   * the Session uses the SAME ID, so a composition tree's leaf identity is
   * stable across destroy/recreate with entirely new renderer handles. The
   * Compositor owns allocation in both modes; a supplied ID that collides with
   * a live view throws.
   */
  async function openView({viewId: suppliedViewId, viewDescriptor, presentationDescriptor}) {
    requireAlive();
    requireViewDescriptor(viewDescriptor);
    requirePresentationDescriptor(presentationDescriptor);
    let viewId;
    if (suppliedViewId !== undefined) {
      if (typeof suppliedViewId !== 'string' || suppliedViewId.length === 0) {
        throw new TypeError('a supplied viewId must be a non-empty string (re-admission of a durable ID, not new identity)');
      }
      viewId = admitViewId(suppliedViewId);
    } else {
      viewId = mintViewId();
    }
    let surfaceHandle = null;
    try {
      surfaceHandle = await rendererAdapter.createSurface(viewDescriptor);
      requireHandle(surfaceHandle, 'createSurface must return an opaque string surface handle');
      await rendererAdapter.attachPresentation(surfaceHandle, presentationDescriptor);
    } catch (error) {
      views.set(viewId, {viewDescriptor, presentationDescriptor, surfaceHandle: null, status: 'lost'});
      throw mapAdapterFailure(viewId, error);
    }
    views.set(viewId, {viewDescriptor, presentationDescriptor, surfaceHandle, status: 'live'});
    return viewId;
  }

  async function resizeView(viewId, size) {
    requireAlive();
    const view = requireLiveView(viewId);
    assertDataRepresentable(size, 'size');
    if (typeof size.width !== 'number' || typeof size.height !== 'number') {
      throw new TypeError('size must carry numeric width and height');
    }
    if (view.status === 'lost') {
      throw new RendererResourceLostError(`view ${viewId} is lost; its surface cannot be resized`);
    }
    try {
      await rendererAdapter.resize(view.surfaceHandle, {width: size.width, height: size.height});
    } catch (error) {
      throw mapAdapterFailure(viewId, error);
    }
  }

  /** Replace a view's presentation (re-attach), keeping its surface. */
  async function presentOn(viewId, presentationDescriptor) {
    requireAlive();
    const view = requireLiveView(viewId);
    requirePresentationDescriptor(presentationDescriptor);
    if (view.status === 'lost') {
      throw new RendererResourceLostError(`view ${viewId} is lost; its surface is gone`);
    }
    try {
      await rendererAdapter.detachPresentation(view.surfaceHandle);
      await rendererAdapter.attachPresentation(view.surfaceHandle, presentationDescriptor);
      view.presentationDescriptor = presentationDescriptor;
    } catch (error) {
      throw mapAdapterFailure(viewId, error);
    }
  }

  /** Close one logical view, freeing exactly its renderer resource. */
  async function closeView(viewId) {
    requireAlive();
    const view = requireLiveView(viewId);
    if (view.status === 'live' && view.surfaceHandle) {
      try {
        await rendererAdapter.destroySurface(view.surfaceHandle);
      } catch (error) {
        views.delete(viewId);
        if (focusedViewId === viewId) focusedViewId = null;
        throw mapAdapterFailure(viewId, error);
      }
    }
    views.delete(viewId);
    // Destroying a focused view clears focus cleanly (no stale handle).
    if (focusedViewId === viewId) focusedViewId = null;
  }

  /**
   * Tear down the Session's composition: destroy ALL renderer resources. The
   * map is cleared even if destroyAll throws (the Session is ending regardless,
   * and the adapter is authoritative for resources). Idempotent.
   */
  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      await rendererAdapter.destroyAll();
    } catch (error) {
      // Consistent taxonomy: a raw adapter throw during teardown is still a
      // renderer error, never an untyped exception crossing into the Session.
      if (error instanceof RendererResourceLostError) throw error;
      throw new RendererResourceLostError(
        `renderer teardown failed: ${error?.message ?? error}`, {cause: error},
      );
    } finally {
      views.clear();
      focusedViewId = null; // Session teardown clears focus
    }
  }

  /**
   * The durable composition intent: {viewId, viewDescriptor,
   * presentationDescriptor} for every view, with NO surface handle. This is the
   * only thing allowed to reach a Perspective; it is handle-free by
   * construction.
   */
  function durableIntent() {
    return Object.freeze([...views.entries()].map(([viewId, view]) => Object.freeze({
      viewId,
      viewDescriptor: view.viewDescriptor,
      presentationDescriptor: view.presentationDescriptor,
    })));
  }

  function viewStatus(viewId) {
    return views.get(viewId)?.status ?? null;
  }

  // --- Focus (which LOGICAL VIEW receives interaction) ----------------------
  // Focus is TRANSIENT Session state, about a VIEW — never serialized to a
  // Perspective (durableIntent stays handle-free AND focus-free) and never a
  // semantic selection. The Compositor owns it because it owns logical view
  // lifetime/arrangement; ownership.md names focus/layout/stacking as a
  // Compositor Phase 2 concern. Selection (which semantic subject the user
  // means) is a SEPARATE owner (SelectionModel).
  let focusedViewId = null;

  // Focus a live view. Focusing A unfocuses B by construction (single focus).
  // Returns the focused viewId. Throws on an unknown/lost view.
  function focusView(viewId) {
    requireAlive();
    const view = requireLiveView(viewId);
    if (view.status !== 'live') {
      throw new RendererResourceLostError(`cannot focus lost view ${viewId}`);
    }
    focusedViewId = viewId;
    return focusedViewId;
  }

  // The currently focused viewId, or null. Read-only.
  function focusedView() {
    return focusedViewId;
  }

  // Clear focus (e.g. explicit unfocus). Idempotent.
  function clearFocus() {
    focusedViewId = null;
  }

  // Resolve a renderer interaction to focus + selection. Given a surface handle
  // (the renderer said 'an interaction happened on this view'), focus the bound
  // logical view AND update the SelectionModel with the view's semantic subject
  // (from its presentationDescriptor — never from the renderer). The Compositor
  // owns focus; the SelectionModel owns selection; this seam keeps them in step
  // without conflating them. Returns {viewId, subject} or null when the handle
  // resolves to no live view.
  function interactWithSurface(surfaceHandle, selectionModel) {
    requireAlive();
    const view = viewForSurfaceHandle(surfaceHandle);
    if (!view) return null;
    focusView(view.viewId);
    const subject = view.presentationDescriptor?.subject ?? null;
    if (selectionModel && typeof selectionModel.select === 'function') {
      selectionModel.select(subject);
    }
    return Object.freeze({viewId: view.viewId, subject});
  }

  // Resolve a renderer surface handle to the durable intent the Compositor
  // holds for that view — {viewId, presentationDescriptor} — or null when the
  // handle is unknown/torn down. This is the CommandRouter's subject source
  // (ADR 0011 §6): the renderer emits 'an interaction happened on this view';
  // the semantic subject comes from the presentationDescriptor, never from the
  // renderer. Read-only; returns a frozen snapshot.
  function viewForSurfaceHandle(surfaceHandle) {
    for (const [viewId, view] of views.entries()) {
      if (view.surfaceHandle === surfaceHandle && view.status === 'live') {
        return Object.freeze({viewId, presentationDescriptor: view.presentationDescriptor});
      }
    }
    return null;
  }

  return Object.freeze({
    openView, resizeView, presentOn, closeView, destroy, durableIntent, viewStatus, viewForSurfaceHandle,
    focusView, focusedView, clearFocus, interactWithSurface,
  });
}

export {RENDERER_ADAPTER_METHODS, createCompositor};
