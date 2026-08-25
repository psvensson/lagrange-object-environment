import {RendererResourceLostError} from './renderer-errors.js';

/**
 * A fake RendererAdapter: a headless test double realizing the
 * Compositor-facing renderer contract with in-memory, transient resources. It
 * owns concrete (fake) renderer resources and returns only opaque string
 * handles upward — exactly the boundary a real Browser/Native/Remote adapter
 * must satisfy.
 *
 * It records lifecycle calls, can be told to FAIL (to simulate a lost GPU /
 * lost surface), and exposes its live-resource set so tests can assert that
 * Session teardown eliminates every renderer resource.
 */
function createFakeRendererAdapter({mintHandle} = {}) {
  const liveResources = new Map(); // surfaceHandle -> {viewDescriptor, presentationDescriptor|null, size}
  const calls = [];
  let nextHandle = 0;
  let failNext = null; // method name to fail on next invocation
  const mint = mintHandle ?? ((n) => `fake-surface-${n}`);

  function record(method, detail) {
    calls.push(Object.freeze({method, detail}));
  }

  function maybeFail(method) {
    if (failNext === method || failNext === '*') {
      failNext = null;
      throw new RendererResourceLostError(`fake renderer: simulated lost resource on ${method}`);
    }
  }

  return Object.freeze({
    async createSurface(viewDescriptor) {
      maybeFail('createSurface');
      const handle = mint(nextHandle++);
      liveResources.set(handle, {viewDescriptor, presentationDescriptor: null, size: null});
      record('createSurface', {handle, viewDescriptor});
      return handle;
    },
    async attachPresentation(surfaceHandle, presentationDescriptor) {
      maybeFail('attachPresentation');
      requireLive(liveResources, surfaceHandle, 'attachPresentation');
      liveResources.get(surfaceHandle).presentationDescriptor = presentationDescriptor;
      record('attachPresentation', {surfaceHandle, presentationDescriptor});
    },
    async detachPresentation(surfaceHandle) {
      maybeFail('detachPresentation');
      requireLive(liveResources, surfaceHandle, 'detachPresentation');
      liveResources.get(surfaceHandle).presentationDescriptor = null;
      record('detachPresentation', {surfaceHandle});
    },
    async resize(surfaceHandle, size) {
      maybeFail('resize');
      requireLive(liveResources, surfaceHandle, 'resize');
      liveResources.get(surfaceHandle).size = size;
      record('resize', {surfaceHandle, size});
    },
    async destroySurface(surfaceHandle) {
      maybeFail('destroySurface');
      requireLive(liveResources, surfaceHandle, 'destroySurface');
      liveResources.delete(surfaceHandle);
      record('destroySurface', {surfaceHandle});
    },
    async destroyAll() {
      record('destroyAll', {count: liveResources.size});
      liveResources.clear();
    },

    // Test instrumentation (not part of the adapter contract).
    liveResourceCount: () => liveResources.size,
    liveHandles: () => Object.freeze([...liveResources.keys()]),
    calls: () => Object.freeze([...calls]),
    failNext: (method) => { failNext = method; },
  });
}

function requireLive(liveResources, surfaceHandle, method) {
  if (!liveResources.has(surfaceHandle)) {
    throw new RendererResourceLostError(`fake renderer: ${method} on unknown/lost surface ${surfaceHandle}`);
  }
}

export {createFakeRendererAdapter};
