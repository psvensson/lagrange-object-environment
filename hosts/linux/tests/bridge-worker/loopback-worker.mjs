/**
 * THROWAWAY 64j-A S0 loopback worker. NOT the acceptance flow. It acts as a
 * STAND-IN for the real JS core: it drives a fixed script of six-op calls
 * through the bridge adapter (validating op-correlation + FIFO ordering + the
 * GLB-attach path, all SEQUENTIALLY awaited — not concurrent) and prints
 * LOOPBACK-OK to stderr + exits 0 on success (LOOPBACK-FAIL + exit 1 on any op
 * error, e.g. an 'already attached' from a broken presentOn ordering). The Rust
 * spike test asserts the clean exit + the op count.
 */

import {runBridgeWorker} from './bridge.mjs';

const inspector = (text) => ({
  kind: 'inspector',
  subject: {kind: 'ref', imageId: 'img', objectId: 'obj-b'},
  parameters: {
    fields: {'slot-title': {kind: 'text', value: text}, 'slot-count': {kind: 'int', value: 17}},
    writable: ['slot-title'],
    references: [],
  },
});

const navigatorDesc = {
  kind: 'navigator',
  subject: {kind: 'ref', imageId: 'img', objectId: 'obj-root'},
  parameters: {
    fields: {'slot-title': {kind: 'text', value: 'Root'}},
    references: [{kind: 'ref', imageId: 'img', objectId: 'obj-b'}, {kind: 'ref', imageId: 'img', objectId: 'obj-c'}],
  },
};

runBridgeWorker(async (adapter) => {
  try {
    const view = {kind: 'surface', width: 200, height: 200};
    // create + attach navigator and inspector.
    const nav = await adapter.createSurface(view);
    await adapter.attachPresentation(nav, navigatorDesc);
    const insp = await adapter.createSurface(view);
    await adapter.attachPresentation(insp, inspector('B'));
    // presentOn ordering: detach -> attach must not hit 'already attached'.
    await adapter.detachPresentation(insp);
    await adapter.attachPresentation(insp, inspector('B-EDITED'));
    // GLB create+attach (block_on on the GTK thread) interleaved with GTK ops.
    // The Rust test supplies the GLB bytes; here we only prove the op path with
    // a minimal glb descriptor (no assets -> the adapter spawns with an empty
    // allowlist, which still exercises the block_on attach path).
    const glb = await adapter.createSurface({kind: 'surface', width: 320, height: 200});
    await adapter.attachPresentation(glb, {kind: 'glb', subject: {kind: 'ref', imageId: 'img', objectId: 'obj-model'}, parameters: {assets: {}}});
    // A resize (the contract's 2-arg shape) + a final presentOn, then destroyAll.
    await adapter.resize(insp, {width: 200, height: 200});
    await adapter.detachPresentation(insp);
    await adapter.attachPresentation(insp, inspector('B-FINAL'));
    await adapter.destroyAll();
    console.error('LOOPBACK-OK: six-op script completed (op-correlation + FIFO + glb attach path)');
    process.exit(0);
  } catch (error) {
    console.error(`LOOPBACK-FAIL: ${error?.message ?? error}`);
    process.exit(1);
  }
});
