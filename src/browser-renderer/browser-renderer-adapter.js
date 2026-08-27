import {RendererResourceLostError} from '../renderer-errors.js';
import {pushPendingRenderTarget} from './surface.js';
import {createAssetProvider} from './assets.js';

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

function createBrowserRendererAdapter({loadComponent, mount = null, createRenderTarget = null, resolveAssets = null} = {}) {
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

  const surfaces = new Map(); // handle -> {surface|null, component, running, width, height}
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

  function mountCanvas(entry) {
    // Only mount the canvas for the on-screen (canvas) realization. A texture
    // render target is headless — its Surface's canvas is never attached, so
    // the browser's on-screen compositor is never engaged (which is what makes
    // the texture path deterministic under Xvfb/headless).
    if (entry.surface && !entry.surface.renderTarget && mountPoint && !entry.surface.canvas.parentNode) {
      mountPoint.appendChild(entry.surface.canvas);
      // Attach DOM pointer listeners (input capture owner) so real pointer
      // events flow into the same stream the synthetic-injection seam uses.
      entry.surface.attachDomInput();
    }
  }

  function unmountCanvas(entry) {
    if (entry.surface && entry.surface.canvas.parentNode) {
      entry.surface.canvas.parentNode.removeChild(entry.surface.canvas);
    }
  }

  async function createSurface(viewDescriptor) {
    requireAlive();
    const handle = `browser-surface-${nextHandle++}`;
    surfaces.set(handle, {
      surface: null, component: null, running: false,
      width: viewDescriptor?.width ?? 0, height: viewDescriptor?.height ?? 0,
    });
    return handle;
  }

  function stopEntry(entry) {
    // End the Surface's frame stream so the Component's render loop wakes and
    // exits (the Component has no explicit stop; ending its frame stream is the
    // host-side stop signal), then drop the Component reference.
    entry.running = false;
    if (entry.surface) entry.surface.destroy();
    entry.component = null;
  }

  async function attachPresentation(surfaceHandle, presentationDescriptor) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'attachPresentation');
    if (entry.running) {
      throw new RendererResourceLostError('browser renderer: a presentation is already attached to this surface');
    }
    // Host wiring: resolve THIS attach's asset bytes under authority (ASYNC),
    // then build an attach-scoped provider closing over exactly that allowlist.
    // The provider is passed to loadComponent and bound into THIS Component
    // instance's imports (jco instantiation mode) — never a process-global.
    const assetBytes = getAssets ? await getAssets(presentationDescriptor) : null;
    const assetProvider = createAssetProvider(assetBytes);
    // Host wiring: push the RenderTarget for the Surface the Component is
    // about to construct, so it is in place BEFORE the Component builds its
    // Context inside start() (the Context reads surface.renderTarget at
    // construction). The Component is unaware which realization it got.
    if (makeRenderTarget) {
      pushPendingRenderTarget(makeRenderTarget({width: entry.width, height: entry.height}));
    }
    // Start the Component. loadComponent instantiates it (jco instantiation
    // mode) with THIS attach's assetProvider in its import closure, then calls
    // start; it returns {start, surface}. The Component constructs its Surface
    // (the Lagrange-owned one) via the mapped surface import.
    const component = await loadComponent({
      presentationDescriptor,
      width: entry.width,
      height: entry.height,
      assetProvider,
    });
    entry.component = component;
    entry.surface = component?.surface ?? null;
    // Observe the surface's raw input (DOM when mounted, or synthetic-injected)
    // to resolve a semantic intent — separate from the WIT stream the Component
    // consumes, so intent observation never steals renderer stream events.
    if (entry.surface && typeof entry.surface.observeRawInput === 'function') {
      entry.unobserveInput = entry.surface.observeRawInput((event) => emitIntent(surfaceHandle, event));
    }
    // The Component constructs its Surface with its own (possibly-empty)
    // CreateDesc; the ADAPTER owns the logical dimensions (the Compositor's
    // createSurface {width,height}), so it applies them. This keeps sizing
    // Lagrange-owned, not Component-decided.
    if (entry.surface && (entry.width || entry.height)) {
      entry.surface.setSize(entry.width, entry.height);
    }
    mountCanvas(entry);
    if (component && typeof component.start === 'function') {
      entry.running = true;
      component.start().catch(() => {
        entry.running = false;
      });
    }
  }

  async function detachPresentation(surfaceHandle) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'detachPresentation');
    // Stop the Component's render loop (not just drop the reference) so a
    // detached presentation does not leak a live rAF/GPU loop per swap.
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
    const target = entry.surface?.context?.renderTarget;
    if (!target || typeof target.readPixels !== 'function') return null;
    const frame = await target.readPixels();
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
    if (entry.surface) {
      // Lagrange host extension: resize the canvas the Component renders to.
      entry.surface.setSize(size.width, size.height);
    }
  }

  async function destroySurface(surfaceHandle) {
    requireAlive();
    const entry = requireLive(surfaceHandle, 'destroySurface');
    stopEntry(entry);
    unmountCanvas(entry);
    surfaces.delete(surfaceHandle);
  }

  async function destroyAll() {
    destroyed = true;
    for (const entry of surfaces.values()) {
      stopEntry(entry);
      unmountCanvas(entry);
    }
    surfaces.clear();
    // Session teardown: each entry's Component instance is dropped (stopEntry),
    // and with it the attach-scoped asset provider closure bound into that
    // instance's imports. There is no process-global asset store to clear — a
    // cold Component provably re-receives its bytes on the next attach because
    // the adapter resolves + builds a fresh provider per attach.
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
    if (entry.surface) entry.surface.injectPointer(event);
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

  // Resolve a surface pointer event into a semantic intent descriptor and fan
  // it out to intent consumers. Pointer-down on a live surface -> activate.
  function emitIntent(surfaceHandle, event) {
    if (event?.type !== 'pointer-down') return;
    const intent = Object.freeze({kind: 'activate'});
    for (const handler of intentHandlers) handler(intent, surfaceHandle);
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
