/**
 * The Component/WebGPU realizer — a sibling Presentation realizer for the
 * BrowserRendererAdapter's kind-dispatch seam (docs/ownership.md). This is the
 * EXISTING Component path (triangle/glb), extracted unchanged so it sits beside
 * the DOM realizers behind the same `Realization` contract. The adapter stays
 * the lifecycle owner; this realizer owns the Component/WIT/Surface specifics.
 *
 * Realization contract (opaque to the adapter):
 *   start()      -> begin the Component render loop
 *   stop()       -> end the frame loop + drop the Component
 *   resize(size) -> resize the Surface's canvas (Lagrange-owned dimensions)
 *   readPixels() -> frame {data,width,height,bytesPerRow} | null
 *   dispose()    -> final teardown (stop + unmount the canvas)
 */

import {createAssetProvider} from './assets.js';
import {pushPendingRenderTarget} from './surface.js';

function createComponentRealizer({loadComponent, createRenderTarget = null, resolveAssets = null, mountPoint = null, emitInput = null}) {
  if (typeof loadComponent !== 'function') {
    throw new TypeError('the Component realizer requires a loadComponent() factory');
  }
  const makeRenderTarget = typeof createRenderTarget === 'function' ? createRenderTarget : null;
  const getAssets = typeof resolveAssets === 'function' ? resolveAssets : null;

  // attach: run the current Component attach dance and return the opaque
  // Realization. `emitInput(surfaceHandle, event)` is the adapter's raw-input
  // fan-out (the intent-observation seam), wired to the Surface's raw input.
  async function attach({surfaceHandle, presentationDescriptor, width, height}) {
    // Resolve THIS attach's asset bytes under authority (ASYNC), then build an
    // attach-scoped provider closing over exactly that allowlist (bound into
    // THIS Component instance's imports — no process-global).
    const assetBytes = getAssets ? await getAssets(presentationDescriptor) : null;
    const assetProvider = createAssetProvider(assetBytes);
    // Push the RenderTarget for the Surface the Component is about to construct.
    if (makeRenderTarget) {
      pushPendingRenderTarget(makeRenderTarget({width, height}));
    }
    const component = await loadComponent({presentationDescriptor, width, height, assetProvider});
    const surface = component?.surface ?? null;
    // Observe the surface's raw input to resolve a semantic intent — separate
    // from the WIT stream, so intent observation never steals renderer events.
    let unobserveInput = null;
    if (surface && typeof surface.observeRawInput === 'function' && typeof emitInput === 'function') {
      unobserveInput = surface.observeRawInput((event) => emitInput(surfaceHandle, event));
    }
    // The adapter owns the logical dimensions (not the Component).
    if (surface && (width || height)) {
      surface.setSize(width, height);
    }
    // Mount the canvas ONLY for the on-screen realization (a texture render
    // target is headless — its canvas is never attached).
    if (surface && !surface.renderTarget && mountPoint && !surface.canvas.parentNode) {
      mountPoint.appendChild(surface.canvas);
      surface.attachDomInput();
    }

    let running = false;
    return {
      kind: 'component',
      surface, // exposed for readPixels (renderTarget access)
      start() {
        if (component && typeof component.start === 'function') {
          running = true;
          component.start().catch(() => { running = false; });
        }
      },
      stop() {
        running = false;
        if (typeof unobserveInput === 'function') unobserveInput();
        if (surface) surface.destroy();
      },
      resize({width: w, height: h}) {
        if (surface) surface.setSize(w, h);
      },
      async readPixels() {
        const target = surface?.context?.renderTarget;
        if (!target || typeof target.readPixels !== 'function') return null;
        return target.readPixels();
      },
      dispose() {
        this.stop();
        if (surface && surface.canvas.parentNode) {
          surface.canvas.parentNode.removeChild(surface.canvas);
        }
      },
      isRunning: () => running,
    };
  }

  return {attach};
}

export {createComponentRealizer};
export default {createComponentRealizer};
