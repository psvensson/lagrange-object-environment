import test from 'node:test';
import assert from 'node:assert/strict';
import {available, withProofPage} from './support/proof-lane.js';

// The PR D BROWSER half (Bead lagrange-object-environment-nlg): a synthetic-
// injected pointer event on a Component-backed view drives the SAME input
// stream + intent-resolution path a real DOM pointer event would, delivering a
// SEMANTIC INTENT DESCRIPTOR ({kind:'activate'}, no subject) to the host's
// intent consumers. This is the input -> intent half of the semantic-
// interaction route; the intent -> Command -> authorized mutation half is the
// Node integration proof (command-router.integration.test.js). The seam between
// them is one consumeIntent call.
//
// Runs under Xvfb/headless SwiftShader on the TextureRenderTarget path (no
// mounted canvas), proving the synthetic-injection seam is honest — it reaches
// the same intent resolution a DOM event would.

test('CI: synthetic pointer event on a Component view resolves a semantic intent (no subject)', {skip: !available && 'no Chrome available'}, async (t) => {
  await withProofPage(async ({page}) => {

    const gpuInfo = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a?.info ? {vendor: a.info.vendor, architecture: a.info.architecture} : null;
    });
    t.diagnostic(`WebGPU adapter: ${JSON.stringify(gpuInfo)} (software expected; hardware never claimed)`);

    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openGlbSession();
      const handle = await S.open(320, 200);

      // Register an intent consumer on the adapter; inject a pointer-down on
      // the view's surface; the consumer must receive {kind:'activate'} bound
      // to THIS handle (and never a subject).
      const received = [];
      const unsubscribe = S.adapter.onIntent((intent, h) => received.push({intent, handle: h}));
      await S.adapter.injectPointerEvent(handle, {type: 'pointer-down', x: 160, y: 100, button: 0});
      await S.adapter.injectPointerEvent(handle, {type: 'pointer-up', x: 160, y: 100, button: 0});
      unsubscribe();
      await S.destroyAll();
      return {received, handle};
    });

    assert.equal(result.received.length, 1, 'pointer-down resolves exactly one intent (pointer-up does not)');
    assert.deepEqual(result.received[0].intent, {kind: 'activate'}, 'the intent is a semantic descriptor, not a pixel coordinate');
    assert.equal(result.received[0].handle, result.handle, 'the intent is bound to the interacting view handle');
    assert.ok(!('subject' in result.received[0].intent), 'the intent carries NO subject (the CommandRouter resolves it)');
  });
});
