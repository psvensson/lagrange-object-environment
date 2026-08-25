import {createBrowserRendererAdapter} from '../../src/browser-renderer/browser-renderer-adapter.js';
import {takeConstructedSince, constructedSurfaces} from '../../src/browser-renderer/surface.js';
import {TextureRenderTarget} from '../../src/browser-renderer/render-target.js';
import {start} from './components/triangle.component.js';

// The PR B browser proof harness. Drives the BrowserRendererAdapter through
// the full lifecycle against real Chrome WebGPU with the triangle Component.
// Exposes window.__lagrangeProof; each step returns data the driver asserts on.
//
// Two render-target realizations are exercised through the SAME Component and
// the SAME WIT/shim path — the Component is unaware which it got:
//   - texture mode: each Surface renders into a host-owned GPUTexture
//     (TextureRenderTarget). Deterministic CPU read-back; runs under
//     Xvfb/headless SwiftShader. This is the CI pixel proof.
//   - canvas mode (default): each Surface renders to its on-screen <canvas>
//     (CanvasRenderTarget). Real browser presentation; pixel read-back is
//     environment-dependent, so the automated assertions here cover the
//     multi-view/resize/teardown lifecycle, not pixels.
//
// The mode is chosen by the harness (host wiring), NOT by the Component,
// Presentation, or Compositor.

// One loadComponent factory per Session. The Component constructs its Surface
// asynchronously inside start(); we kick start() off, then wait for the
// Surface it constructs so the adapter can size + mount its canvas. The
// construction registry is pruned on Surface.destroy().
function makeLoadComponent() {
  return async () => {
    const before = constructedSurfaces().length;
    const startPromise = start();
    let surface = null;
    for (let i = 0; i < 100 && !surface; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const created = takeConstructedSince(before);
      surface = created[created.length - 1] ?? null;
    }
    return {start: () => startPromise, surface};
  };
}

const mount = document.getElementById('mount');

function makeAdapter({texture = false} = {}) {
  return createBrowserRendererAdapter({
    loadComponent: makeLoadComponent(),
    mount,
    ...(texture
      ? {createRenderTarget: ({width, height}) => new TextureRenderTarget(width, height)}
      : {}),
  });
}

async function openTriangle(adapter, width, height) {
  const handle = await adapter.createSurface({kind: 'webgpu-canvas', width, height});
  await adapter.attachPresentation(handle, {kind: 'triangle'});
  // Let several frames render.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return handle;
}

window.__lagrangeProof = {
  canvases: () => Array.from(document.querySelectorAll('#mount canvas')),

  // --- Texture-target (CI pixel proof) session ---
  async openTextureSession() {
    const adapter = makeAdapter({texture: true});
    const open = (w, h) => openTriangle(adapter, w, h);
    return {
      adapter,
      open,
      openTwo: async () => ({a: await open(320, 200), b: await open(640, 400)}),
      readRendered: (h) => adapter.readRenderedPixels(h),
      resize: async (h, w, ht) => {
        await adapter.resize(h, {width: w, height: ht});
        for (let i = 0; i < 5; i += 1) await new Promise((r) => requestAnimationFrame(r));
      },
      destroyView: (h) => adapter.destroySurface(h),
      destroyAll: () => adapter.destroyAll(),
    };
  },

  // --- Canvas-target (production lifecycle) session ---
  async openCanvasSession() {
    const adapter = makeAdapter({texture: false});
    const open = (w, h) => openTriangle(adapter, w, h);
    return {
      adapter,
      open,
      openTwo: async () => ({a: await open(320, 200), b: await open(640, 400)}),
      readRendered: (h) => adapter.readRenderedPixels(h),
      resize: async (h, w, ht) => {
        await adapter.resize(h, {width: w, height: ht});
        for (let i = 0; i < 5; i += 1) await new Promise((r) => requestAnimationFrame(r));
      },
      destroyView: (h) => adapter.destroySurface(h),
      destroyAll: () => adapter.destroyAll(),
      recreateSession: async (w, h) => {
        await adapter.destroyAll();
        const fresh = makeAdapter({texture: false});
        return openTriangle(fresh, w, h);
      },
    };
  },
};
