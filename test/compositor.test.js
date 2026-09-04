import test from 'node:test';
import assert from 'node:assert/strict';

import {Perspective} from '../src/model.js';
import {encodePerspectiveRecord, encodePresentations} from '../src/perspective-projection.js';
import {RendererResourceLostError} from '../src/renderer-errors.js';
import {RENDERER_ADAPTER_METHODS, createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';

const viewDescriptor = (kind = 'surface') => ({kind, width: 800, height: 600});
const presentationDescriptor = (id) => ({
  kind: 'inspector',
  subject: {kind: 'ref', imageId: 'img', objectId: id},
  parameters: {},
});

function setup() {
  const adapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter: adapter});
  return {adapter, compositor};
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// --- the lifecycle: create, resize, attach, teardown -------------------------

test('open/resize/presentOn/close drive the adapter lifecycle with opaque handles', async () => {
  const {adapter, compositor} = setup();
  const viewId = await compositor.openView({
    viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-1'),
  });
  assert.equal(adapter.liveResourceCount(), 1);

  await compositor.resizeView(viewId, {width: 1024, height: 768});
  await compositor.presentOn(viewId, presentationDescriptor('obj-2'));
  await compositor.closeView(viewId);
  assert.equal(adapter.liveResourceCount(), 0, 'closing the view frees exactly its resource');

  const methods = adapter.calls().map((c) => c.method);
  assert.deepEqual(methods, ['createSurface', 'attachPresentation', 'resize', 'detachPresentation', 'attachPresentation', 'destroySurface']);
});

test('destroying one of two views frees exactly its resource, not the other', async () => {
  const {adapter, compositor} = setup();
  const a = await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('a')});
  const b = await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('b')});
  assert.equal(adapter.liveResourceCount(), 2);
  await compositor.closeView(a);
  assert.equal(adapter.liveResourceCount(), 1);
  await compositor.closeView(b);
  assert.equal(adapter.liveResourceCount(), 0);
});

// --- invariant 2: Session teardown eliminates ALL renderer resources ---------

test('Session teardown (destroy) eliminates all renderer resources while durable intent survives', async () => {
  const {adapter, compositor} = setup();
  await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-1')});
  await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-2')});
  const intent = compositor.durableIntent();
  assert.equal(intent.length, 2);

  await compositor.destroy();
  assert.equal(adapter.liveResourceCount(), 0, 'no renderer resource survives Session teardown');
  // The durable intent (descriptors) is unaffected by teardown.
  assert.deepEqual(intent.map((v) => v.presentationDescriptor.subject.objectId), ['obj-1', 'obj-2']);

  // Teardown is idempotent.
  await compositor.destroy();
  assert.equal(adapter.liveResourceCount(), 0);
});

// --- invariant 1: no handle enters a Perspective (via the real encode path) --

test('durable intent contains no surface handle and encodes through the ADR 0012 path handle-free', async () => {
  const {adapter, compositor} = setup();
  await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-1')});
  const handleStrings = new Set(adapter.liveHandles());
  assert.ok(handleStrings.size > 0, 'the adapter minted handles');

  // Build a Perspective from the durable intent and run it through the REAL
  // ADR 0012 encode path. Subject refs go in the proper ref slots (perspective
  // subject + each presentation subject); layout stays ref-free. No
  // adapter-minted handle may appear anywhere in the encoded graph.
  const intent = compositor.durableIntent();
  const perspective = new Perspective({
    id: 'p', subject: {kind: 'ref', imageId: 'img', objectId: 'root'},
    title: null, layout: {viewIds: intent.map((v) => v.viewId)},
    presentations: intent.map((v) => ({
      id: v.viewId, kind: v.presentationDescriptor.kind,
      subject: v.presentationDescriptor.subject,
      context: v.presentationDescriptor.parameters, state: {},
    })),
  });
  const presentationRecords = encodePresentations(perspective);
  const perspectiveRecord = encodePerspectiveRecord(
    perspective,
    intent.map((v, i) => ({kind: 'ref', imageId: 'img', objectId: `child-${i}`})),
  );
  const encoded = JSON.stringify({presentationRecords, perspectiveRecord});
  for (const handle of handleStrings) {
    assert.ok(!encoded.includes(handle), `surface handle ${handle} must not appear in the durable Perspective encoding`);
  }
});

// --- invariant 3: contained adapter failure (Session + other views survive) --

test('a lost resource marks the view lost, keeps the Session alive, and other views survive', async () => {
  const {adapter, compositor} = setup();
  const good = await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('good')});
  const doomed = await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('doomed')});

  adapter.failNext('resize');
  await assert.rejects(
    compositor.resizeView(doomed, {width: 1, height: 1}),
    (e) => e instanceof RendererResourceLostError,
  );
  assert.equal(compositor.viewStatus(doomed), 'lost');
  assert.equal(compositor.viewStatus(good), 'live', 'the other view is unaffected');

  // A post-loss operation on the lost view throws a typed error.
  await assert.rejects(compositor.resizeView(doomed, {width: 2, height: 2}), RendererResourceLostError);

  // The lost view keeps its durable descriptor (so a later restore can recreate it).
  const intent = compositor.durableIntent();
  const lostEntry = intent.find((v) => v.viewId === doomed);
  assert.equal(lostEntry.presentationDescriptor.subject.objectId, 'doomed');
});

test('openView destroys a newly-created surface exactly once before publishing an attach failure', async () => {
  const base = createFakeRendererAdapter();
  const cleanupStarted = deferred();
  const allowCleanup = deferred();
  const attempts = [];
  let mintedHandle;
  const adapter = Object.freeze({
    ...base,
    async createSurface(descriptor) {
      mintedHandle = await base.createSurface(descriptor);
      attempts.push({method: 'createSurface', surfaceHandle: mintedHandle});
      return mintedHandle;
    },
    async attachPresentation(surfaceHandle, descriptor) {
      attempts.push({method: 'attachPresentation', surfaceHandle});
      base.failNext('attachPresentation');
      return base.attachPresentation(surfaceHandle, descriptor);
    },
    async destroySurface(surfaceHandle) {
      attempts.push({method: 'destroySurface', surfaceHandle});
      cleanupStarted.resolve();
      await allowCleanup.promise;
      return base.destroySurface(surfaceHandle);
    },
  });
  const compositor = createCompositor({rendererAdapter: adapter});

  const opened = compositor.openView({
    viewId: 'failed-open',
    viewDescriptor: viewDescriptor(),
    presentationDescriptor: presentationDescriptor('doomed-at-attach'),
  });
  await cleanupStarted.promise;

  assert.deepEqual(
    attempts,
    [
      {method: 'createSurface', surfaceHandle: mintedHandle},
      {method: 'attachPresentation', surfaceHandle: mintedHandle},
      {method: 'destroySurface', surfaceHandle: mintedHandle},
    ],
    'the same minted handle is compensated once, after the attach attempt',
  );
  assert.equal(compositor.viewStatus('failed-open'), null, 'the lost entry is not published before cleanup settles');
  assert.deepEqual(compositor.durableIntent(), [], 'durable intent cannot observe the half-cleaned failed open');
  assert.equal(base.liveResourceCount(), 1, 'the deferred cleanup still owns the minted resource');

  allowCleanup.resolve();
  await assert.rejects(opened, RendererResourceLostError);
  assert.equal(base.liveResourceCount(), 0, 'the failed open leaves no renderer resource behind');
  assert.equal(compositor.viewStatus('failed-open'), 'lost');
  const [lost] = compositor.durableIntent();
  assert.equal(lost.viewId, 'failed-open');
  assert.ok(!('surfaceHandle' in lost), 'the durable lost entry remains handle-free');

  await compositor.closeView('failed-open');
  await compositor.destroy();
  assert.equal(attempts.filter(({method}) => method === 'destroySurface').length, 1, 'later lifecycle cleanup does not destroy the failed-open surface again');
});

test('attach failure remains primary when its one cleanup attempt also fails', async () => {
  const base = createFakeRendererAdapter();
  const attachFailure = new Error('primary attach failure');
  const cleanupFailure = new Error('secondary cleanup failure');
  let cleanupAttempts = 0;
  const adapter = Object.freeze({
    ...base,
    async attachPresentation() {
      throw attachFailure;
    },
    async destroySurface() {
      cleanupAttempts += 1;
      throw cleanupFailure;
    },
  });
  const compositor = createCompositor({rendererAdapter: adapter});

  await assert.rejects(
    compositor.openView({
      viewId: 'double-failure',
      viewDescriptor: viewDescriptor(),
      presentationDescriptor: presentationDescriptor('double-failure'),
    }),
    (error) => error instanceof RendererResourceLostError && error.cause === attachFailure,
  );
  assert.equal(cleanupAttempts, 1);
  assert.equal(compositor.viewStatus('double-failure'), 'lost');
  assert.ok(!('surfaceHandle' in compositor.durableIntent()[0]));
  assert.equal(base.liveResourceCount(), 1, 'a rejected cleanup leaves realization accounting to broad teardown');

  await compositor.closeView('double-failure');
  assert.equal(cleanupAttempts, 1, 'closeView does not retry a failed-open surface cleanup');
  await compositor.destroy();
  assert.equal(cleanupAttempts, 1, 'Session teardown uses destroyAll, not a second destroySurface call');
  assert.equal(base.liveResourceCount(), 0);
});

test('openView never destroys without a validated surface handle', async (t) => {
  await t.test('createSurface failure', async () => {
    const base = createFakeRendererAdapter();
    base.failNext('createSurface');
    let cleanupAttempts = 0;
    const adapter = Object.freeze({
      ...base,
      async destroySurface(surfaceHandle) {
        cleanupAttempts += 1;
        return base.destroySurface(surfaceHandle);
      },
    });
    const compositor = createCompositor({rendererAdapter: adapter});
    await assert.rejects(
      compositor.openView({viewId: 'create-failed', viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('create-failed')}),
      RendererResourceLostError,
    );
    assert.equal(cleanupAttempts, 0);
    assert.equal(base.liveResourceCount(), 0);
    await compositor.destroy();
  });

  await t.test('invalid handle returned by createSurface', async () => {
    const invalidHandle = {not: 'opaque string'};
    const base = createFakeRendererAdapter({mintHandle: () => invalidHandle});
    let cleanupAttempts = 0;
    const adapter = Object.freeze({
      ...base,
      async destroySurface(surfaceHandle) {
        cleanupAttempts += 1;
        return base.destroySurface(surfaceHandle);
      },
    });
    const compositor = createCompositor({rendererAdapter: adapter});
    await assert.rejects(
      compositor.openView({viewId: 'invalid-handle', viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('invalid-handle')}),
      /opaque string surface handle/,
    );
    assert.equal(cleanupAttempts, 0, 'an invalid value is not sent back across the renderer boundary as a handle');
    assert.equal(base.liveResourceCount(), 1, 'the fake retained its contract-violating value until broad teardown');
    await compositor.destroy();
    assert.equal(base.liveResourceCount(), 0);
  });
});

// --- invariant 4: the boundary carries only data-representable values --------

test('a callback in a presentation descriptor is REJECTED (would not survive a remote boundary)', async () => {
  const {compositor} = setup();
  await assert.rejects(
    compositor.openView({
      viewDescriptor: viewDescriptor(),
      presentationDescriptor: {kind: 'inspector', subject: {kind: 'ref', imageId: 'i', objectId: 'o'}, parameters: {onPick: () => {}}},
    }),
    /data-representable/,
  );
});

test('every handle and descriptor crossing the boundary survives a JSON round trip', async () => {
  const {adapter, compositor} = setup();
  await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-1')});
  const roundTrip = (x) => JSON.parse(JSON.stringify(x));
  for (const handle of adapter.liveHandles()) {
    assert.equal(typeof handle, 'string');
    assert.deepEqual(roundTrip(handle), handle);
  }
  for (const call of adapter.calls()) {
    assert.deepEqual(roundTrip(call), call, `boundary call ${call.method} must be data-representable`);
  }
});

// --- invariant 5: the boundary is lifecycle-only, no raw GPU op --------------

test('the adapter contract is exactly the agreed lifecycle method set (no raw GPU op)', () => {
  assert.deepEqual(
    [...RENDERER_ADAPTER_METHODS].sort(),
    ['attachPresentation', 'createSurface', 'destroyAll', 'destroySurface', 'detachPresentation', 'resize'],
  );
  for (const forbidden of ['writeBuffer', 'submit', 'createBuffer', 'createTexture', 'requestDevice', 'getPreferredCanvasFormat']) {
    assert.ok(!RENDERER_ADAPTER_METHODS.includes(forbidden), `${forbidden} is a raw GPU op and must not cross the boundary`);
  }
});

// --- invariant 6: recreate-from-Perspective (the raison d'etre) --------------

test('a fresh Session recreates views from durable intent, RESTORING the same durable viewIds (not counter-coincidence)', async () => {
  // Session 1: open THREE views, close the MIDDLE one, so the persisted intent
  // has a GAP (view-0 + view-2, no view-1). Under the OLD design (restore via a
  // fresh counter) Session 2 would mint view-0 + view-1 — this test goes RED.
  const first = setup();
  const idA = await first.compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-a')});
  const idMiddle = await first.compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-middle')});
  const idB = await first.compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-b')});
  await first.compositor.closeView(idMiddle); // gap: view-0 and view-2 remain
  const intent = first.compositor.durableIntent();
  assert.deepEqual(intent.map((v) => v.viewId), [idA, idB], 'persisted intent has a gap (view-0, view-2)');
  await first.compositor.destroy();
  assert.equal(first.adapter.liveResourceCount(), 0);

  // Session 2: restore by RE-ADMITTING the persisted durable IDs, OUT OF ORDER
  // (idB first). The Session must use the SAME IDs bound to the SAME subjects —
  // proving identity is durable, not a coincidental fresh mint.
  const second = setup();
  const byId = new Map(intent.map((v) => [v.viewId, v]));
  for (const restoreId of [idB, idA]) { // out of order
    const view = byId.get(restoreId);
    const used = await second.compositor.openView({
      viewId: restoreId,
      viewDescriptor: view.viewDescriptor, presentationDescriptor: view.presentationDescriptor,
    });
    assert.equal(used, restoreId, 'the Session re-admits the SAME durable viewId');
  }
  assert.equal(second.adapter.liveResourceCount(), 2, 'one resource per restored view');

  const restored = second.compositor.durableIntent();
  // Identity is durable: the SAME IDs come back, bound to the SAME subjects.
  assert.deepEqual(
    restored.map((v) => v.viewId).sort(),
    [idA, idB].sort(),
    'restored viewIds are the persisted durable IDs (with the gap), NOT a fresh 0/1 mint',
  );
  const subjectById = new Map(restored.map((v) => [v.viewId, v.presentationDescriptor.subject.objectId]));
  assert.equal(subjectById.get(idA), 'obj-a', 'viewId -> subject binding is by durable ID, not counter position');
  assert.equal(subjectById.get(idB), 'obj-b');
  // No renderer handle leaked into the durable intent.
  for (const v of restored) {
    assert.ok(!('surfaceHandle' in v), 'durable intent stays handle-free');
  }
});

test('a fresh openView after a restore does not collide with restored IDs; a duplicate re-admission is rejected', async () => {
  const compositor = setup().compositor;
  // Restore a durable ID that occupies an early ordinal.
  const restored = await compositor.openView({
    viewId: 'view-0', viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-a'),
  });
  assert.equal(restored, 'view-0');
  // A fresh openView must SKIP the live 'view-0' (no collision).
  const fresh = await compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-b')});
  assert.notEqual(fresh, 'view-0', 'auto-mint skips a live restored ID');
  // Re-admitting an ALREADY-LIVE ID is rejected (allocation is Compositor-owned).
  await assert.rejects(
    compositor.openView({viewId: 'view-0', viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-c')}),
    /already holds viewId|collide/i,
  );
  await compositor.destroy();
});

// --- contract validation ------------------------------------------------------

test('createCompositor requires the full adapter method set', () => {
  assert.throws(() => createCompositor({}), /requires a RendererAdapter/);
  // Build a partial adapter missing destroyAll (spread, since the fake is frozen).
  const {destroyAll, ...partial} = createFakeRendererAdapter();
  assert.throws(() => createCompositor({rendererAdapter: partial}), /missing required method: destroyAll/);
});

test('a non-string surface handle from the adapter is rejected', async () => {
  const bad = createFakeRendererAdapter({mintHandle: () => ({not: 'a string handle'})});
  const compositor = createCompositor({rendererAdapter: bad});
  await assert.rejects(
    compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('x')}),
    /opaque string surface handle/,
  );
});

test('liveView(viewId): the current live snapshot for a logical view; null when absent or lost (the caller-names-a-view lane; same predicate as viewForSurfaceHandle)', async () => {
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  assert.equal(compositor.liveView('v'), null, 'absent');
  const pd = {kind: 'inspector', subject: {kind: 'ref', imageId: 'img', objectId: 'o'}, parameters: {}};
  await compositor.openView({viewId: 'v', viewDescriptor: {kind: 'canvas', width: 8, height: 8}, presentationDescriptor: pd});
  assert.deepEqual(compositor.liveView('v'), {viewId: 'v', presentationDescriptor: pd});
  assert.deepEqual(compositor.liveView('v'), compositor.viewForSurfaceHandle(compositor.surfaceHandleForView('v')), 'same snapshot as the handle lane');
  const pd2 = {...pd, parameters: {x: 1}};
  await compositor.presentOn('v', pd2);
  assert.equal(compositor.liveView('v').presentationDescriptor, pd2, 'current descriptor');
  rendererAdapter.failNext('detachPresentation');
  await assert.rejects(compositor.presentOn('v', pd));
  assert.equal(compositor.viewStatus('v'), 'lost');
  assert.equal(compositor.liveView('v'), null, 'lost');
  assert.ok(compositor.durableIntent().some((x) => x.viewId === 'v'), 'durable intent still lists the lost view (by design)');
  await compositor.destroy();
});
