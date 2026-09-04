import test from 'node:test';
import assert from 'node:assert/strict';
import {available, withProofPage} from './support/proof-lane.js';

// The PR B CI browser proof — runs under Xvfb/headless SwiftShader (NO hardware
// GPU, NO display compositor required) and is the GATING automated proof.
//
// It drives the REAL triangle Component through its EXACT pinned WIT imports,
// the jco transpilation, and the real wasi-gfx-shim WebGPU mapping, into a
// host-owned TextureRenderTarget, and positively verifies the rendered triangle
// pixels via copyTextureToBuffer. The Component is unaware it is not rendering
// to a screen — the render-target realization is a host-side detail.
//
// It also exercises the real CanvasRenderTarget lifecycle (two independent
// surfaces, resize independence, teardown/recreate) WITHOUT reading canvas
// pixels, because reading back an on-screen canvas's WebGPU texture crashes
// Chrome+SwiftShader under Xvfb/headless (a recorded environment limitation,
// not an implementation bug). The full canvas PIXEL proof is retained as a
// manual real-display integration test (browser-proof.canvas.manual.test.js).

// The triangle covers roughly the central half of the frame; require a
// comfortably positive fraction of strongly-red pixels (SwiftShader-tolerant,
// never exact). This is a discriminating assertion: it goes red if the
// Component does not actually draw.
function assertTriangle(frame, label) {
  assert.ok(frame, `${label}: read-back returned no frame (not rendering)`);
  assert.ok(
    frame.red > frame.width * frame.height * 0.1,
    `${label} should render a red triangle (red ${frame.red}/${frame.width * frame.height})`,
  );
}

test('CI: real Component renders triangle pixels into a TextureRenderTarget', {skip: !available && 'no Chrome available'}, async (t) => {
  await withProofPage(async ({page}) => {
    const gpuInfo = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a?.info ? {vendor: a.info.vendor, architecture: a.info.architecture} : null;
    });
    t.diagnostic(`WebGPU adapter: ${JSON.stringify(gpuInfo)} (software expected; hardware never claimed)`);

    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openTextureSession();
      const {a, b} = await S.openTwo();
      const frameA = await S.readRendered(a);
      const frameB = await S.readRendered(b);
      // Resize A -> A tracks the new size, B is unchanged.
      await S.resize(a, 480, 300);
      const frameAResized = await S.readRendered(a);
      const frameBAfter = await S.readRendered(b);
      await S.destroyAll();
      return {frameA, frameB, frameAResized, frameBAfter};
    });

    assertTriangle(result.frameA, 'texture view A');
    assertTriangle(result.frameB, 'texture view B');
    assert.equal(result.frameAResized.width, 480, 'resized A width');
    assert.equal(result.frameAResized.height, 300, 'resized A height');
    assertTriangle(result.frameAResized, 'texture view A after resize');
    assert.equal(result.frameBAfter.width, 640, 'B width unchanged by resizing A');
    assertTriangle(result.frameBAfter, 'texture view B after resizing A');
  });
});

test('CI: CanvasRenderTarget lifecycle — two surfaces, resize independence, teardown/recreate', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCanvasSession();
      const {a, b} = await S.openTwo();
      const twoCanvases = window.__lagrangeProof.canvases().length;

      // Resize A -> A's canvas tracks it, B's canvas is unchanged.
      await S.resize(a, 480, 300);
      const dims = window.__lagrangeProof.canvases().map((c) => ({width: c.width, height: c.height}));

      // Destroy A -> only A's canvas is gone; B survives.
      await S.destroyView(a);
      const afterDestroyA = window.__lagrangeProof.canvases().length;

      // Session teardown removes every canvas.
      await S.destroyAll();
      const afterDestroyAll = window.__lagrangeProof.canvases().length;

      // A fresh Session over the same durable intent recreates the view.
      await S.recreateSession(320, 200);
      const afterRecreate = window.__lagrangeProof.canvases().length;

      return {twoCanvases, dims, afterDestroyA, afterDestroyAll, afterRecreate};
    });

    assert.equal(result.twoCanvases, 2, 'two independent surfaces produce two canvases');
    assert.deepEqual(result.dims[0], {width: 480, height: 300}, 'resize A applied per-view');
    assert.deepEqual(result.dims[1], {width: 640, height: 400}, 'resize A must not affect B');
    assert.equal(result.afterDestroyA, 1, 'destroying A removes only A');
    assert.equal(result.afterDestroyAll, 0, 'Session teardown must remove all canvases');
    assert.equal(result.afterRecreate, 1, 'a fresh Session recreates the render view');
  });
});
