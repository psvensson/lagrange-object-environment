/**
 * THROWAWAY 64j-A S0 loopback worker. NOT the acceptance flow. It acts as a
 * STAND-IN for the real JS core: it drives a fixed script of six-op calls
 * through the bridge adapter (validating op-correlation, FIFO ordering, and the
 * GLB-attach path) and prints one JSON status line to STDOUT when done, so the
 * Rust spike test can assert the whole round-trip succeeded. (The bridge reader
 * thread only forwards {id,op,args} messages to the GTK thread; this worker's
 * status line is a plain {status} message the reader ignores, so the test reads
 * the child's stdout directly would be wrong — instead the worker signals done
 * via a 'ping' the host can observe. Simplest: the worker just runs the script
 * and exits 0 on success; the Rust test asserts a clean exit + no bridge error.)
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
    // A resize + a final presentOn, then destroyAll.
    await adapter.resize(insp, 200, 200);
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
