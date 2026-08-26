/**
 * The Lagrange-owned wasi-gfx:surface/surface@0.2.0 host provider.
 *
 * This is the part Lagrange OWNS (per the PR B dependency boundary): canvas
 * creation, explicit dimensions, attachment, resize, multi-view lifecycle. The
 * upstream wasi-gfx-shim surface is single-surface/full-viewport/body-append
 * with no programmatic resize — wrong for the multi-view Compositor contract —
 * so this module implements Surface itself instead of consuming the shim's.
 *
 * A Surface wraps a real <canvas> created and owned here, one per Surface.
 * Nothing is a singleton: multiple simultaneous render views are independent.
 * The canvas never crosses the Compositor -> RendererAdapter boundary (that
 * boundary stays data-only); it lives only here, below it.
 *
 * Implemented for PR B: constructor(desc), onFrame (requestAnimationFrame),
 * onResize, and empty pointer/key streams (the triangle subscribes to them but
 * only renders on frame). width/height come from the owning adapter, not the
 * unimplemented upstream request-set-size.
 */

// A construction-order registry so the BrowserRendererAdapter can find the
// Surface a Component just constructed (the Component instantiates `new
// Surface(...)` via the mapped import; the adapter reads it back here). This
// is host-side bookkeeping, NOT a canvas singleton: each Surface still owns
// its own canvas, and the adapter binds one Surface per view handle.
const constructed = [];

// A stack of host-supplied RenderTargets waiting to be claimed by the NEXT
// Surface the Component constructs. The owning adapter pushes a target right
// before it starts the Component; the Surface constructor pops it, so the
// renderTarget is in place BEFORE the Component builds its Context (which
// happens inside start(), before the adapter could otherwise set the field).
// This is how the host chooses headless (texture) vs on-screen (canvas)
// realization without the Component knowing.
const pendingRenderTargets = [];

function pushPendingRenderTarget(target) {
  pendingRenderTargets.push(target);
}

// An empty async iterable that never yields (for the input streams the
// triangle subscribes to but PR B does not drive).
function emptyStream() {
  return {
    [Symbol.asyncIterator]() {
      return {next: () => new Promise(() => {})}; // never resolves; no events
    },
  };
}

class Surface {
  #canvas;
  #live = true;
  #resizeListeners = new Set();
  #destroyListeners = new Set();

  // The wasi-gfx:surface/surface-webgpu Context bound to this Surface, set by
  // the Context constructor (surface-webgpu.js). Host-side only; lets the
  // owning adapter reach the render target (and its read-back, when present)
  // for exactly this view.
  context = null;

  // Whether DOM pointer listeners have been attached to the canvas.
  #domInputAttached = false;
  #domListeners = [];

  // Optional host-supplied RenderTarget (render-target.js). When null, the
  // Context defaults to a CanvasRenderTarget over this Surface's own canvas.
  // The owning adapter sets a TextureRenderTarget for headless/test rendering.
  // The renderer Component never sees this choice.
  renderTarget = null;

  // desc: {width?, height?}. The canvas is created and owned here, one per
  // Surface (multi-view; no singleton, no implicit body-append).
  constructor(desc = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = desc.width ?? 0;
    canvas.height = desc.height ?? 0;
    this.#canvas = canvas;
    // Claim a host-supplied RenderTarget if the adapter pushed one for the
    // Surface being constructed right now (null -> canvas realization).
    this.renderTarget = pendingRenderTargets.length > 0 ? pendingRenderTargets.shift() : null;
    constructed.push(this);
  }

  // The real canvas this Surface wraps (host-side only; never crosses the
  // RendererAdapter boundary).
  get canvas() {
    return this.#canvas;
  }

  width() {
    return this.#canvas.width;
  }

  height() {
    return this.#canvas.height;
  }

  // The owning adapter resizes the surface. The canvas is resized (for the
  // canvas realization) and the render target is told (the texture realization
  // recreates its GPUTexture); subscribers to onResize are notified.
  setSize(width, height) {
    this.#canvas.width = width;
    this.#canvas.height = height;
    if (this.renderTarget && typeof this.renderTarget.setSize === 'function') {
      this.renderTarget.setSize(width, height);
    }
    for (const listener of this.#resizeListeners) listener({width, height});
  }

  // A requestAnimationFrame-driven frame stream. Each next() resolves on the
  // next animation frame while live; destroy() wakes any pending consumer with
  // done:true so the renderer's frame loop ends cleanly.
  onFrame() {
    const isLive = () => this.#live;
    const destroyListeners = this.#destroyListeners;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise((resolve) => {
            if (!isLive()) {
              resolve({value: undefined, done: true});
              return;
            }
            const onDestroy = () => {
              resolve({value: undefined, done: true});
            };
            destroyListeners.add(onDestroy);
            requestAnimationFrame(() => {
              destroyListeners.delete(onDestroy);
              resolve(isLive()
                ? {value: {nothing: false}, done: false}
                : {value: undefined, done: true});
            });
          }),
        };
      },
    };
  }

  onResize() {
    const listeners = this.#resizeListeners;
    const isLive = () => this.#live;
    return {
      [Symbol.asyncIterator]() {
        const queue = [];
        let wake = null;
        const listener = (event) => {
          queue.push(event);
          if (wake) { wake(); wake = null; }
        };
        listeners.add(listener);
        return {
          next: () => new Promise((resolve) => {
            if (queue.length > 0) {
              resolve({value: queue.shift(), done: false});
            } else if (!isLive()) {
              resolve({value: undefined, done: true});
            } else {
              wake = () => resolve(queue.length > 0
                ? {value: queue.shift(), done: false}
                : {value: undefined, done: true});
            }
          }),
          return: () => {
            listeners.delete(listener);
            return Promise.resolve({done: true});
          },
        };
      },
    };
  }

  // PR D: real pointer streams. A per-Surface event queue feeds each stream;
  // DOM listeners push into it WHEN the canvas is mounted (canvas realization),
  // and the host synthetic-injection seam (injectPointer) pushes into the SAME
  // queue — so the downstream path (stream consumption + intent resolution) is
  // identical for a real pointer event and a synthetic one. The renderer
  // Component consumes these via on_pointer_*; the host also reads them to
  // resolve a semantic intent.
  #inputListeners = new Set();
  #rawInputObservers = new Set();

  #emitInput(event) {
    for (const listener of this.#inputListeners) listener(event);
    for (const observer of this.#rawInputObservers) observer(event);
  }

  // Host-side raw input observation (the adapter uses this to resolve a
  // semantic intent) — SEPARATE from the WIT stream the Component consumes, so
  // observing intent never steals stream events from the renderer.
  observeRawInput(observer) {
    this.#rawInputObservers.add(observer);
    return () => this.#rawInputObservers.delete(observer);
  }

  // Attach DOM pointer listeners to the canvas (idempotent). Called by the
  // adapter when the canvas is mounted (canvas realization only — a
  // TextureRenderTarget Surface's canvas is never mounted, so DOM events can
  // only come from the synthetic-injection seam there).
  attachDomInput() {
    if (this.#domInputAttached || !this.#canvas) return;
    this.#domInputAttached = true;
    const emit = (type) => (e) => this.#emitInput({type, x: e.offsetX ?? 0, y: e.offsetY ?? 0, button: e.button ?? 0});
    this.#domListeners = [
      ['pointerdown', emit('pointer-down')],
      ['pointerup', emit('pointer-up')],
      ['pointermove', emit('pointer-move')],
    ];
    for (const [name, fn] of this.#domListeners) this.#canvas.addEventListener(name, fn);
  }

  // Host-side SYNTHETIC-INJECTION seam (input capture owner): push a semantic
  // pointer event into the SAME stream queue a DOM event would use. This is how
  // the unmounted/headless (TextureRenderTarget) path receives deterministic
  // input in CI. The event is plain data {type, x, y, button}.
  injectPointer(event) {
    if (!this.#live) return;
    this.#emitInput(event);
  }

  // A single async-iterable stream of pointer events for this Surface. Both
  // DOM events (when mounted) and synthetic-injected events flow through it.
  #pointerStream() {
    const listeners = this.#inputListeners;
    const isLive = () => this.#live;
    return {
      [Symbol.asyncIterator]() {
        const queue = [];
        let wake = null;
        const listener = (event) => {
          queue.push(event);
          if (wake) { wake(); wake = null; }
        };
        listeners.add(listener);
        return {
          next: () => new Promise((resolve) => {
            if (queue.length > 0) {
              resolve({value: queue.shift(), done: false});
            } else if (!isLive()) {
              resolve({value: undefined, done: true});
            } else {
              wake = () => resolve(queue.length > 0
                ? {value: queue.shift(), done: false}
                : {value: undefined, done: true});
            }
          }),
          return: () => {
            listeners.delete(listener);
            return Promise.resolve({done: true});
          },
        };
      },
    };
  }

  // The WIT surface interface exposes per-gesture streams. Each is an
  // independent iterator over the shared emit path (#inputListeners), filtered
  // by event type, so a pointer-down consumer never starves a pointer-up one.
  #filteredStream(type) {
    const source = this.#pointerStream();
    return {
      [Symbol.asyncIterator]() {
        const it = source[Symbol.asyncIterator]();
        return {
          async next() {
            for (;;) {
              const r = await it.next();
              if (r.done) return r;
              if (r.value.type === type) return r;
            }
          },
          return: () => (it.return ? it.return() : Promise.resolve({done: true})),
        };
      },
    };
  }

  onPointerUp() { return this.#filteredStream('pointer-up'); }
  onPointerDown() { return this.#filteredStream('pointer-down'); }
  onPointerMove() { return this.#filteredStream('pointer-move'); }
  onKeyUp() { return emptyStream(); }
  onKeyDown() { return emptyStream(); }

  // Tear down: end the frame stream (waking pending consumers), and remove
  // this Surface from the construction registry so it does not grow unbounded.
  // The owning adapter removes the canvas.
  destroy() {
    if (!this.#live) return;
    this.#live = false;
    for (const listener of this.#destroyListeners) listener();
    this.#destroyListeners.clear();
    this.#resizeListeners.clear();
    // Detach DOM input listeners (input-capture teardown).
    if (this.#domInputAttached && this.#canvas) {
      for (const [name, fn] of this.#domListeners) this.#canvas.removeEventListener(name, fn);
      this.#domListeners = [];
      this.#domInputAttached = false;
    }
    const index = constructed.indexOf(this);
    if (index !== -1) constructed.splice(index, 1);
  }
}

// Host-side registry accessors for the BrowserRendererAdapter.
function constructedSurfaces() {
  return constructed;
}

function takeConstructedSince(index) {
  return constructed.slice(index);
}

export {Surface, constructedSurfaces, takeConstructedSince, pushPendingRenderTarget};
export default {Surface};
