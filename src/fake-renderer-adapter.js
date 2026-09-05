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
 *
 * OPTIONAL REALIZATION (`projector`). A real host does two things this double
 * historically did not: it PROJECTS an attached descriptor to a SemanticUi
 * document, and it EMITS intents carrying only a descriptor-local key. Inject a
 * projector and this double does both, which lets a headless lane prove the
 * whole renderer -> shell -> consumer path without a browser.
 *
 * The boundary is deliberate:
 *  - the projector is INJECTED, never imported. This module stays semantically
 *    ignorant: it does not know SemanticUi, Smalltalk, or what any descriptor
 *    means. The caller passes the real `semanticUiForPresentation`.
 *  - projection happens AT REALIZATION TIME, inside attachPresentation, and the
 *    document is stored as that handle's realization snapshot. A later
 *    presentOn replaces it through the Compositor's own detach/attach path.
 *  - `activateAction` reads the key out of the STORED document. It never re-runs
 *    the projector, because then the double would be interacting with a freshly
 *    computed document rather than the one it realized — which would quietly
 *    weaken every stale/current-realization proof.
 *  - `activateAction` chooses no meaning: it locates the Nth realized action
 *    node, reads THAT node's key, and emits it. It never reads presentation
 *    parameters, never inspects a subject, and never decides what is being
 *    activated. The test picks which rendered action to press.
 *
 * The intent seam stays OUTSIDE the six-op renderer contract: this does not
 * widen RENDERER_ADAPTER_METHODS. `onIntent`, `activateAction` and document
 * inspection are instrumentation beside the lifecycle contract, exactly like
 * the resource/call helpers already here. With no projector injected, the
 * lifecycle behavior and the six-op contract are unchanged.
 */
function createFakeRendererAdapter({mintHandle, projector = null} = {}) {
  const liveResources = new Map(); // surfaceHandle -> {viewDescriptor, presentationDescriptor|null, size}
  const calls = [];
  // surfaceHandle -> the SemanticUi document this double realized on attach.
  const realized = new Map();
  const intentHandlers = new Set();
  if (projector !== null && typeof projector !== 'function') {
    throw new TypeError('createFakeRendererAdapter projector must be a function when present');
  }

  // Every action node in a realized document, in document order. Structural
  // only: it reads the `kind` and `key` the document already carries and
  // interprets nothing.
  function actionsOf(doc) {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'action') found.push(node);
      for (const child of node.children ?? []) walk(child);
      for (const item of node.items ?? []) walk(item);
    };
    walk(doc?.root);
    return found;
  }
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
      // REALIZATION: project here, once, and keep what was realized.
      if (projector) realized.set(surfaceHandle, projector(presentationDescriptor));
      record('attachPresentation', {surfaceHandle, presentationDescriptor});
    },
    async detachPresentation(surfaceHandle) {
      maybeFail('detachPresentation');
      requireLive(liveResources, surfaceHandle, 'detachPresentation');
      liveResources.get(surfaceHandle).presentationDescriptor = null;
      realized.delete(surfaceHandle);
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
      realized.delete(surfaceHandle);
      record('destroySurface', {surfaceHandle});
    },
    async destroyAll() {
      record('destroyAll', {count: liveResources.size});
      liveResources.clear();
      realized.clear();
    },

    // --- Realization instrumentation (NOT part of the six-op adapter contract) ---
    // The document this double realized for a handle, or null.
    realizedDocument: (surfaceHandle) => realized.get(surfaceHandle) ?? null,
    // The action nodes of that realized document, in document order.
    realizedActions: (surfaceHandle) => Object.freeze([...actionsOf(realized.get(surfaceHandle))]),
    // The intent seam a real host offers. Returns an unsubscribe.
    onIntent(handler) {
      intentHandlers.add(handler);
      return () => intentHandlers.delete(handler);
    },
    /**
     * Press the Nth action of what this handle REALIZED, emitting the ordinary
     * intent with the key that document carries. The ordinal selects a rendered
     * row; the KEY comes from the realization, never from the caller — so a test
     * cannot invent a key, and this double cannot choose a semantic meaning.
     */
    activateAction(surfaceHandle, ordinal) {
      const actions = actionsOf(realized.get(surfaceHandle));
      const action = actions[ordinal];
      if (!action) {
        throw new RangeError(`fake renderer: no realized action ${ordinal} on ${surfaceHandle} (has ${actions.length})`);
      }
      const intent = Object.freeze({kind: 'activate-item', key: action.key});
      for (const handler of intentHandlers) handler(intent, surfaceHandle);
      return intent;
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
