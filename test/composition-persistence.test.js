import test from 'node:test';
import assert from 'node:assert/strict';
import {empty, presentation, split, stack, leafViewIds} from '../src/composition-tree.js';
import {
  assertCompositionBijection,
  encodeCompositionLayout,
  decodeCompositionLayout,
  restoreComposition,
  presentationToDescriptor,
  COMPOSITION_LAYOUT_VERSION,
} from '../src/composition-persistence.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';

// The composition-persistence contracts (Bead 8ft): bijection, empty(),
// versioned layout codec. These are renderer-independent; the real authorized
// save/load round trip is proven in image-client-adapter.integration.test.js.

const ref = (objectId) => ({kind: 'ref', imageId: 'img', objectId});
const pres = (id, objectId = id) => ({id, kind: 'object-view', subject: ref(objectId), context: {}, state: {}});

test('bijection: exact set equality, unique both sides; orphan/dangling/duplicate reject', () => {
  const tree = split('row', 0.3, presentation('A'), stack([presentation('B'), presentation('C')], 'B'));
  const ok = [pres('A'), pres('B'), pres('C')];
  assert.ok(assertCompositionBijection(tree, ok), 'exact bijection passes');
  // Order does not matter (membership, not arrangement).
  assert.ok(assertCompositionBijection(tree, [pres('C'), pres('A'), pres('B')]), 'presentation order is membership, not arrangement');

  // Orphan presentation: C in presentations, not in tree.
  assert.throws(
    () => assertCompositionBijection(split('row', 0.5, presentation('A'), presentation('B')), [pres('A'), pres('B'), pres('C')]),
    /orphan presentation/,
  );
  // Dangling leaf: C in tree, not in presentations.
  assert.throws(
    () => assertCompositionBijection(tree, [pres('A'), pres('B')]),
    /dangling leaf/,
  );
  // Duplicate presentation id.
  assert.throws(
    () => assertCompositionBijection(tree, [pres('A'), pres('B'), pres('C'), pres('C')]),
    /duplicate presentation id/,
  );
  // Duplicate tree leaf (already rejected by the kernel at construction).
  assert.throws(
    () => assertCompositionBijection(split('row', 0.5, presentation('A'), presentation('A')), [pres('A')]),
    /more than one composition position/,
  );
});

test('empty(): the zero case round-trips and is distinct from a legacy layout', () => {
  // empty <-> zero presentations (bijection holds trivially but explicitly).
  assertCompositionBijection(empty(), []);
  assert.deepEqual([...leafViewIds(empty())], [], 'empty contributes no leaves');
  // empty JSON round-trips.
  assert.deepEqual(JSON.parse(JSON.stringify(empty())), {kind: 'empty'});
  // The codec encodes empty as a composition payload (NOT a special-cased {}/null).
  const payload = encodeCompositionLayout(empty(), []);
  assert.equal(payload.kind, 'composition');
  assert.deepEqual(payload.root, {kind: 'empty'});
  const decoded = decodeCompositionLayout(payload, []);
  assert.deepEqual(decoded.composition, {kind: 'empty'});
  assert.equal(decoded.legacy, false);
  // A LEGACY layout (no kind:'composition') yields NO tree, preserved opaquely.
  const legacy = decodeCompositionLayout({split: 'horizontal', ratio: 0.5});
  assert.equal(legacy.composition, null);
  assert.equal(legacy.legacy, true);
});

test('versioned layout codec: rejects unknown versions loudly; round-trips a real tree', () => {
  const tree = split('row', 0.3, presentation('A'), stack([presentation('B'), presentation('C')], 'B'));
  const presentations = [pres('C'), pres('A'), pres('B')]; // indexed order != arrangement
  const payload = encodeCompositionLayout(tree, presentations);
  assert.equal(payload.kind, 'composition');
  assert.equal(payload.version, COMPOSITION_LAYOUT_VERSION);
  // The root is plain JSON (no frozen/live refs) and decodes identically.
  const decoded = decodeCompositionLayout(payload, presentations);
  assert.deepEqual(decoded.composition, tree);
  // stack.active survives the round trip.
  assert.equal(decoded.composition.second.active, 'B');
  // Unknown version rejects loudly.
  assert.throws(
    () => decodeCompositionLayout({kind: 'composition', version: 999, root: payload.root}, presentations),
    /unsupported composition layout version/,
  );
  // The bijection is re-checked on decode (a tampered presentation set rejects).
  assert.throws(
    () => decodeCompositionLayout(payload, [pres('A'), pres('B')]),
    /dangling leaf/,
  );
  // A duplicate presentation id is rejected AT DECODE (not only at encode).
  assert.throws(
    () => decodeCompositionLayout(payload, [pres('A'), pres('B'), pres('C'), pres('C')]),
    /duplicate presentation id/,
  );
  // presentations is REQUIRED at decode (the bijection is enforced, not opt-out).
  assert.throws(
    () => decodeCompositionLayout(payload),
    /requires the Perspective presentations array/,
  );
});

test('the layout payload is ref-free and carries no renderer/geometry/handle', () => {
  const tree = split('row', 0.3, presentation('A'), stack([presentation('B'), presentation('C')], 'B'));
  const payload = encodeCompositionLayout(tree, [pres('A'), pres('B'), pres('C')]);
  const s = JSON.stringify(payload);
  // No ref-shaped value, no viewDescriptor/geometry/surface/focus/selection/authority.
  for (const banned of ['"ref"', 'pinned-ref', 'surfaceHandle', 'width', 'height', 'canvas', 'gpu', 'focus', 'selection', 'authority', 'viewDescriptor']) {
    assert.ok(!s.includes(banned), `composition layout must not carry "${banned}"`);
  }
});

// Negative falsification: the codec rejects at the seam if the bijection is
// violated, and empty is not conflated with legacy. These go red if the
// enforcement is dropped or the empty/legacy distinction collapses.
test('falsification: dropping the bijection check or conflating empty with legacy goes red', () => {
  // If assertCompositionBijection were a no-op, these would NOT throw.
  assert.throws(() => encodeCompositionLayout(presentation('A'), []), /dangling leaf/);
  assert.throws(() => encodeCompositionLayout(empty(), [pres('A')]), /orphan presentation/);
  // If empty were decoded as legacy (not a composition), composition would be null.
  const decoded = decodeCompositionLayout(encodeCompositionLayout(empty(), []), []);
  assert.notEqual(decoded.composition, null, 'empty is a composition, not a legacy layout');
});

// --- Session-level restore orchestration ------------------------------------

test('restoreComposition: Session 2 restores the same durable viewIds with NEW handles, viewDescriptor-free, focus=none', async () => {
  const tree = split('row', 0.3, presentation('view-A'), stack([presentation('view-B'), presentation('view-C')], 'view-B'));
  const presentations = [
    {id: 'view-C', kind: 'inspector', subject: ref('subject-c'), context: {}, state: {open: true}},
    {id: 'view-A', kind: 'browser', subject: ref('subject-a'), context: {}, state: {}},
    {id: 'view-B', kind: 'editor', subject: ref('subject-b'), context: {line: 3}, state: {}},
  ];
  const perspective = {
    layout: encodeCompositionLayout(tree, presentations),
    presentations,
  };

  // Session 2: a fresh compositor + adapter (renderer mints fresh handles).
  const adapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter: adapter});
  const {composition, restoredViewIds} = await restoreComposition(perspective, compositor);

  // The composition is identical; the SAME durable viewIds are restored.
  assert.deepEqual(composition, tree);
  assert.deepEqual([...restoredViewIds].sort(), ['view-A', 'view-B', 'view-C']);
  // Presentations restored by durable ID; parameters <- context; state dropped.
  const intent = compositor.durableIntent();
  const byId = new Map(intent.map((v) => [v.viewId, v]));
  assert.equal(byId.get('view-B').presentationDescriptor.kind, 'editor');
  assert.deepEqual(byId.get('view-B').presentationDescriptor.parameters, {line: 3}, 'parameters come from context');
  assert.equal(byId.get('view-C').presentationDescriptor.subject.objectId, 'subject-c');
  // The Perspective never carried a viewDescriptor; the default policy supplied one.
  assert.equal(byId.get('view-A').viewDescriptor.kind, 'canvas', 'the realization POLICY supplied the viewDescriptor, not the Perspective');
  // No surface handle in durable intent; focus is transient (none restored).
  for (const v of intent) assert.ok(!('surfaceHandle' in v));
  assert.equal(compositor.focusedView(), null, 'focus is transient, never restored from composition');
  await compositor.destroy();
});

test('falsification: changing the viewDescriptor policy does NOT change the persisted composition', async () => {
  const tree = split('row', 0.5, presentation('view-A'), presentation('view-B'));
  const presentations = [
    {id: 'view-A', kind: 'browser', subject: ref('subject-a'), context: {}, state: {}},
    {id: 'view-B', kind: 'editor', subject: ref('subject-b'), context: {}, state: {}},
  ];
  const perspective = {layout: encodeCompositionLayout(tree, presentations), presentations};

  // Two restores with DIFFERENT concrete viewDescriptor policies -> the SAME
  // composition (the Perspective does not prescribe the realization).
  const restore = async (viewDescriptorFor) => {
    const adapter = createFakeRendererAdapter();
    const compositor = createCompositor({rendererAdapter: adapter});
    const r = await restoreComposition(perspective, compositor, {viewDescriptorFor});
    const out = {composition: r.composition, intent: compositor.durableIntent()};
    await compositor.destroy();
    return out;
  };
  const small = await restore(() => ({kind: 'canvas', width: 32, height: 32}));
  const large = await restore(() => ({kind: 'canvas', width: 500, height: 400}));
  assert.deepEqual(small.composition, large.composition, 'the composition is independent of the concrete realization');
  assert.notDeepEqual(
    small.intent.find((v) => v.viewId === 'view-A').viewDescriptor,
    large.intent.find((v) => v.viewId === 'view-A').viewDescriptor,
    'the concrete viewDescriptors DO differ (the policy, not the Perspective, owns them)',
  );
});
