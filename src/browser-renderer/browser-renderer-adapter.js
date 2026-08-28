import {RendererResourceLostError} from '../renderer-errors.js';
import {createComponentRealizer} from './component-realizer.js';
import {createDomRealizer, isToolKind} from './dom-realizer.js';

/**
 * BrowserRendererAdapter: a realization of the RendererAdapter contract
 * (src/compositor.js, RENDERER_ADAPTER_METHODS) against a real browser
 * WebGPU + canvas, running a renderer WebAssembly Component.
 *
 * It implements the SAME six lifecycle operations as the fake adapter, owning
 * all concrete host resources (canvases, WebGPU contexts, the instantiated
 * Component, the shim's navigator.gpu resources) and returning only opaque
 * string handles upward. The Compositor never sees a DOM node, GPU object, or
 * Component reference.
 *
 * SURFACE MODEL: the renderer Component creates its own Surface through the
 * wasi-gfx:surface/surface import (`new Surface({width, height})`). That import
 * is mapped to the Lagrange-owned Surface (surface.js), so the canvas is
 * Lagrange-owned even though the Component instantiates it. The adapter:
 *  - createSurface: registers the logical surface slot (the actual Surface/
 *    canvas appears when the Component constructs it at attach time);
 *  - attachPresentation: starts the Component, which constructs the Surface;
 *    the adapter mounts its canvas and binds it to this handle;
 *  - resize: a Lagrange host extension (the WIT omits request-set-size) that
 *    resizes the canvas the Component is rendering to, per-view.
 *  - destroySurface/destroyAll: tear down the canvas + Surface + Component.
 *
 * Multi-view: nothing is a singleton. Each Surface has its own canvas; the
 * adapter tracks them per handle. (This is exactly the assumption the upstream
 * single-surface demo host violates.)
 */

function createBrowserRendererAdapter({loadComponent, mount = null, createRenderTarget = null, resolveAssets = null, realizerFor = null} = {}) {
  if (typeof loadComponent !== 'function') {
    throw new TypeError('createBrowserRendererAdapter requires a loadComponent() factory that imports the transpiled renderer Component module');
  }
  const mountPoint = mount ?? (typeof document !== 'undefined' ? document.createElement('div') : null);
  // Host wiring (optional): a factory that returns the RenderTarget for a new
  // surface (e.g. a TextureRenderTarget for headless/test rendering). When
  // null, each Surface defaults to a CanvasRenderTarget over its own canvas.
  // The Compositor and Presentation never know which realization is used.
  const makeRenderTarget = typeof createRenderTarget === 'function' ? createRenderTarget : null;
  // Host wiring (optional): resolve a presentationDescriptor to the attach-
  // scoped, AUTHORIZED asset bytes (a Map<presentationLocalName, Uint8Array>)
  // for THIS attach. ASYNC (an authorized read). The environment side resolves
  // each asset ref under object/read (ImageClientAdapter lane); the adapter
  // receives only the opaque bytes, never refs/ids/authority. Per-attach, so a
  // cold Component re-receives its durable bytes; the provider closure is bound
  // into that one Component instance (no process-global store) and dropped with it.
  const getAssets = typeof resolveAssets === 'function' ? resolveAssets : null;

  // The Presentation-realization DISPATCH seam (host wiring; the adapter stays
  // the LIFECYCLE owner, NOT a hard-coded kind switch). realizerFor:
  // (presentationDescriptor) -> Realizer {attach({surfaceHandle,
  //   presentationDescriptor, width, height, emitInput, emitIntent}) ->
  //   Realization {start, stop, resize, readPixels, dispose, isRunning}}.
  // The caller/host decides the kind->realizer mapping; the adapter is a
  // conduit that invokes it per attach. DEFAULT: the Component realizer for
  // Component kinds and the DOM realizer for the tool kinds (navigator/
  // inspector/unavailable/unauthorized); a host may inject a different mapping
  // (e.g. the sentinel-realizer coexistence proof).
  const componentRealizer = createComponentRealizer({
    loadComponent, createRenderTarget: makeRenderTarget, resolveAssets: getAssets,
    mountPoint, emitInput: (handle, event) => emitIntent(handle, event),
  });
  const domRealizer = mountPoint ? createDomRealizer({
    mountPoint, emitIntent: (handle, intent) => fanOutIntent(handle, intent),
  }) : null;
  // The default mapping: tool kinds -> the DOM realizer, everything else ->
  // the Component realizer. An injected realizerFor may return a realizer for a
  // kind it claims and `undefined` for kinds it doesn't; those fall through to
  // the default. This keeps the adapter a CONDUIT (host wiring decides), never
  // a hard-coded kind switch.
  const defaultRealizerFor = (descriptor) => (isToolKind(descriptor?.kind) && domRealizer ? domRealizer : componentRealizer);
  const resolveRealizer = typeof realizerFor === 'function'
    ? (descriptor) => realizerFor(descriptor) ?? defaultRealizerFor(descriptor)
    : defaultRealizerFor;

  const surfaces = new Map(); // handle -> {realization|null, running, width, height, kind}
  let nextHandle = 0;
  let destroyed = false;

  function requireAlive() {
    if (destroyed) {
      throw new RendererResourceLostError('the browser renderer adapter has been destroyed');
    }
  }

  function requireLive(handle, method) {
    const entry = surfaces.get(handle);
    if (!entry) {
      throw new RendererResourceLostError(`browser renderer: ${method} on unknown/lost surface ${handle}`);
    }
    return entry;
  }

  async function createSurface(viewDescriptor) {
    requireAlive();
    const handle = `browser-surface-${nextHandle++}`;
    surfaces.set(handle, {
      realization: null, running: false,
      width: viewDescriptor?.width ?? 0, height: viewDescriptor?.height ?? 0,
    });
    return handle;
  }

  function stopEntry(entry) {
    // Stop the realization (end the frame loop / stop DOM updates) and drop it.
    // A DOM realization's stop() is a no-op (it has no frame loop), so a detach
    // must DISPOSE it (remove the node + listeners) or the old DOM lingers
    // beside the re-attached one. A Component's dispose() is stop + unmount,
    // equivalent to the old stopEntry.
    entry.running = false;
    if (entry.realization) entry.realization.dispose();
    entry.realization = null;
  }

  async function attachPresentation(surfaceHandle, presentationDescriptor) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'attachPresentation');
    if (entry.running) {
      throw new RendererResourceLostError('browser renderer: a presentation is already attached to this surface');
    }
    // The realization DISPATCH seam: the adapter is a conduit — it resolves the
    // realizer for this presentationDescriptor (host wiring decides the mapping)
    // and delegates the attach. The adapter stays the lifecycle owner; it never
    // hard-codes a kind switch. The Realization is opaque (Component or DOM).
    const realizer = resolveRealizer(presentationDescriptor);
    if (!realizer || typeof realizer.attach !== 'function') {
      throw new RendererResourceLostError(`browser renderer: no realizer for presentation kind "${presentationDescriptor?.kind}"`);
    }
    const realization = await realizer.attach({
      surfaceHandle,
      presentationDescriptor,
      width: entry.width,
      height: entry.height,
      emitInput: (handle, event) => emitIntent(handle, event),
      emitIntent: (handle, intent) => fanOutIntent(handle, intent),
    });
    entry.realization = realization;
    entry.running = true;
    await realization.start();
  }

  async function detachPresentation(surfaceHandle) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'detachPresentation');
    // Stop the realization (not just drop the reference) so a detached
    // presentation does not leak a live rAF/GPU loop or DOM listeners per swap.
    stopEntry(entry);
  }

  // Host-side inspection (data-only upward): when the surface renders into a
  // TextureRenderTarget, read its current frame back via copyTextureToBuffer.
  // Returns the raw frame {data, width, height, bytesPerRow} so the caller can
  // apply its own pixel predicate (red-triangle, shaded-mesh, ...), plus a
  // convenience `red` count for the triangle proof. Deterministic under
  // software/headless WebGPU. Returns null when the surface is not a readable
  // texture target (e.g. a plain on-screen canvas).
  async function readRenderedPixels(surfaceHandle) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'readRenderedPixels');
    const frame = entry.realization ? await entry.realization.readPixels() : null;
    if (!frame) return null;
    const {data, width, height, bytesPerRow} = frame;
    let red = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * bytesPerRow + x * 4;
        if (data[i] > 120 && data[i + 1] < 100 && data[i + 2] < 100) red += 1;
      }
    }
    return {red, width, height, data, bytesPerRow};
  }

  async function resize(surfaceHandle, size) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'resize');
    entry.width = size.width;
    entry.height = size.height;
    if (entry.realization) entry.realization.resize(size);
  }

  async function destroySurface(surfaceHandle) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'destroySurface');
    if (entry.realization) entry.realization.dispose();
    surfaces.delete(surfaceHandle);
  }

  async function destroyAll() {
    destroyed = true;
    for (const entry of surfaces.values()) {
      if (entry.realization) entry.realization.dispose();
    }
    surfaces.clear();
    // Session teardown: each entry's realization is disposed — a Component's
    // instance (and its attach-scoped asset provider closure) or a DOM pane's
    // node + listeners. There is no process-global store to clear.
  }

  // Host-side SYNTHETIC-INJECTION seam (input capture owner): deliver a
  // semantic pointer event {type, x, y, button} to the surface's input stream —
  // the SAME stream a DOM pointer event uses when the canvas is mounted. This
  // is how the unmounted/headless (TextureRenderTarget) path receives input in
  // CI. The event is plain data.
  async function injectPointerEvent(surfaceHandle, event) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'injectPointerEvent');
    // The surface emits the event to its stream AND its raw-input observers
    // (which resolve the intent), so DOM and synthetic input share one path.
    // Only the Component realization has a Surface with a pointer stream.
    if (entry.realization?.surface) entry.realization.surface.injectPointer(event);
  }

  // Host-side intent-consumption seam: register a handler that receives a
  // SEMANTIC INTENT DESCRIPTOR (plain data, e.g. {kind:'activate'}) each time a
  // pointer interaction resolves on a surface. The adapter maps a pointer-down
  // on the surface to {kind:'activate'} — it emits ONLY 'an interaction
  // happened on this view', NEVER a subject (the subject is resolved by the
  // CommandRouter from the Compositor's view map). The handler receives
  // (intentDescriptor, surfaceHandle). This is a host-inspection seam, not part
  // of RENDERER_ADAPTER_METHODS (which stays lifecycle-only).
  function onIntent(handler) {
    intentHandlers.add(handler);
    return () => intentHandlers.delete(handler);
  }

  const intentHandlers = new Set();

  // Fan a semantic intent descriptor out to intent consumers. The intent is
  // plain data: a Component pointer interaction -> {kind:'activate'} ('an
  // interaction happened on this view'); a DOM ref-row activation ->
  // {kind:'activate-item', key} (a descriptor-local item key). NEVER a
  // ref/subject — the environment resolves the subject (CommandRouter) or the
  // item key (EnvironmentShell) against its own Presentation data.
  function fanOutIntent(surfaceHandle, intent) {
    for (const handler of intentHandlers) handler(intent, surfaceHandle);
  }

  // Resolve a Component surface pointer event into a semantic intent descriptor.
  // Pointer-down on a live surface -> activate ('an interaction happened').
  function emitIntent(surfaceHandle, event) {
    if (event?.type !== 'pointer-down') return;
    fanOutIntent(surfaceHandle, Object.freeze({kind: 'activate'}));
  }

  return Object.freeze({
    createSurface,
    attachPresentation,
    detachPresentation,
    resize,
    destroySurface,
    destroyAll,
    readRenderedPixels,
    injectPointerEvent,
    onIntent,
  });
}

export {createBrowserRendererAdapter};
