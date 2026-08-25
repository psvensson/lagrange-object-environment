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

test('a fresh Session recreates views from durable intent (Session recreates the machinery)', async () => {
  // Session 1: open views, capture durable intent, tear down.
  const first = setup();
  await first.compositor.openView({viewDescriptor: viewDescriptor(), presentationDescriptor: presentationDescriptor('obj-1')});
  const intent = first.compositor.durableIntent();
  await first.compositor.destroy();
  assert.equal(first.adapter.liveResourceCount(), 0);

  // Session 2: a NEW compositor + adapter recreate the views from the intent.
  const second = setup();
  for (const view of intent) {
    await second.compositor.openView({
      viewDescriptor: view.viewDescriptor, presentationDescriptor: view.presentationDescriptor,
    });
  }
  assert.equal(second.adapter.liveResourceCount(), intent.length, 'the new Session recreates one resource per intended view');
  const restored = second.compositor.durableIntent();
  assert.deepEqual(
    restored.map((v) => v.presentationDescriptor.subject.objectId),
    ['obj-1'],
    'the recreated Session reflects the same durable intent',
  );
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
