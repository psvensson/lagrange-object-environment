import {RendererResourceLostError} from '../renderer-errors.js';
import {pushPendingRenderTarget} from './surface.js';
import {registerAssetSource, clearAssetSource} from './assets.js';

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
  // Host wiring (optional): resolve a presentationDescriptor to the asset byte
  // source (a Map<name, Uint8Array>) for THIS attach. Called per-attach so the
  // durable bytes cross the host -> Component boundary at runtime; the source
  // is injected wiring, NOT an ambient store (cleared on destroyAll).
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
    // Host wiring: inject the asset byte source for THIS attach, before the
    // Component starts (it calls load-glb inside start()). Per-attach, so a
    // cold Component re-receives its durable bytes; cleared on destroyAll.
    registerAssetSource(getAssets ? getAssets(presentationDescriptor) : null);
    // Host wiring: push the RenderTarget for the Surface the Component is
    // about to construct, so it is in place BEFORE the Component builds its
    // Context inside start() (the Context reads surface.renderTarget at
    // construction). The Component is unaware which realization it got.
    if (makeRenderTarget) {
      pushPendingRenderTarget(makeRenderTarget({width: entry.width, height: entry.height}));
    }
    // Start the Component. It constructs its Surface (the Lagrange-owned one)
    // via the mapped surface import; loadComponent returns {start, surface}.
    const component = await loadComponent({
      presentationDescriptor,
      width: entry.width,
      height: entry.height,
    });
    entry.component = component;
    entry.surface = component?.surface ?? null;
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
    // Session teardown: drop the asset byte source so a cold Component provably
    // re-receives its bytes on the next attach (no ambient asset store).
    clearAssetSource();
  }

  return Object.freeze({
    createSurface,
    attachPresentation,
    detachPresentation,
    resize,
    destroySurface,
    destroyAll,
    readRenderedPixels,
  });
}

export {createBrowserRendererAdapter};
