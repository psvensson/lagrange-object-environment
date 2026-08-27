import test from 'node:test';
import assert from 'node:assert/strict';
import {presentation, split, stack, validate, leafViewIds} from '../src/composition-tree.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';

// The composition-kernel proof (Bead 9s2). The tree is renderer-independent
// arrangement intent; the central falsification is destroy/recreate with
// ENTIRELY NEW renderer handles producing the identical semantic composition.

function viewDescriptor(kind = 'canvas') {
  return {kind, width: 64, height: 64};
}
function presentationDescriptor(objectId) {
  return {kind: 'object-view', subject: {kind: 'ref', imageId: 'img', objectId}};
}
function setup() {
  const adapter = createFakeRendererAdapter();
  return {adapter, compositor: createCompositor({rendererAdapter: adapter})};
}

test('the tree is immutable, data-representable, and holds only durable viewIds', () => {
  const tree = split('row', 0.3,
    presentation('view-0'),
    stack([presentation('view-1'), presentation('view-2')], 'view-2'));
  // JSON round-trips (data-representable; remote-friendly).
  const round = JSON.parse(JSON.stringify(tree));
  assert.deepEqual(round, tree);
  // Immutable.
  assert.ok(Object.isFrozen(tree) && Object.isFrozen(tree.second) && Object.isFrozen(tree.second.children));
  assert.throws(() => { tree.ratio = 0.9; }, TypeError);
  // Leaves carry only viewIds; the kernel exposes exactly the referenced set.
  assert.deepEqual([...leafViewIds(tree)].sort(), ['view-0', 'view-1', 'view-2']);
  // No focus/selection/authority/handle fields anywhere.
  const s = JSON.stringify(tree);
  for (const banned of ['focus', 'selection', 'authority', 'surfaceHandle', 'surface', 'canvas', 'gpu']) {
    assert.ok(!s.includes(banned), `tree must not carry "${banned}"`);
  }
});

test('malformed nodes fail loudly', () => {
  assert.throws(() => presentation(''), /viewId must be a non-empty string/);
  assert.throws(() => presentation({kind: 'live-object'}), /viewId must be a non-empty string/);
  assert.throws(() => split('diagonal', 0.5, presentation('a'), presentation('b')), /axis/);
  assert.throws(() => split('row', 0, presentation('a'), presentation('b')), /ratio/);
  assert.throws(() => split('row', 1.5, presentation('a'), presentation('b')), /ratio/);
  assert.throws(() => stack([], 'a'), /non-empty array/);
  assert.throws(() => stack([presentation('a')], 'not-a-child'), /exposed leaf of exactly one direct child/);
  assert.throws(() => validate({kind: 'window', x: 0, y: 0, w: 1, h: 1}), /unknown composition node kind/);
  // Duplicate leaf viewIds are malformed (one durable view = one slot).
  assert.throws(() => split('row', 0.5, presentation('a'), presentation('a')), /more than one composition position/);
  assert.throws(() => stack([presentation('a'), presentation('b')], 'a') && validate(split('row', 0.5, stack([presentation('a')], 'a'), presentation('a'))), /more than one composition position/);
  // stack.active must name the exposed leaf of a DIRECT child — not a leaf
  // deep inside a split child (which exposes no single slot).
  assert.throws(
    () => stack([split('row', 0.5, presentation('a'), presentation('b')), presentation('c')], 'a'),
    /exposed leaf of exactly one direct child/,
  );
});

test('a VALID nested stack is NOT false-rejected (active names a nested stack child\'s exposed leaf)', () => {
  // A stack whose child is itself a stack: active names the inner stack's
  // exposed leaf (a direct child's exposedLeafId), which is well-defined.
  const inner = stack([presentation('a')], 'a');
  const outer = stack([inner, presentation('b')], 'a');
  assert.equal(outer.active, 'a', 'nested stack active is honored (a direct child that is a stack exposes its own active)');
  // A two-leaf inner stack: active names the inner stack's exposed leaf.
  const inner2 = stack([presentation('a'), presentation('c')], 'c');
  const outer2 = stack([inner2, presentation('b')], 'c');
  assert.equal(outer2.active, 'c');
});

test('stack.active is a durable viewId, NOT an index (reorder-safe)', () => {
  // active names a child by viewId; reordering children does not change which
  // view is exposed (an index would silently point at the wrong one).
  const tree = stack([presentation('view-b'), presentation('view-a')], 'view-a');
  assert.equal(tree.active, 'view-a');
  assert.equal(tree.children[0].viewId, 'view-b', 'children order is preserved; active is independent of position');
});

// --- The central destroy/recreate falsification -----------------------------

test('destroy/recreate with ENTIRELY NEW renderer handles yields the identical composition', async () => {
  // The intended composition: split(presentation A, stack([B, C], active B)).
  const A = 'view-A', B = 'view-B', C = 'view-C';
  const tree = split('row', 0.3, presentation(A), stack([presentation(B), presentation(C)], B));

  // Session 1: realize the leaves. The fake adapter mints surface-0/1/2...
  const s1 = setup();
  const descriptors = new Map([
    [A, presentationDescriptor('obj-a')],
    [B, presentationDescriptor('obj-b')],
    [C, presentationDescriptor('obj-c')],
  ]);
  for (const viewId of [A, B, C]) {
    await s1.compositor.openView({viewId, viewDescriptor: viewDescriptor(), presentationDescriptor: descriptors.get(viewId)});
  }
  await s1.compositor.destroy();
  assert.equal(s1.adapter.liveResourceCount(), 0, 'Session 1 fully torn down');

  // Session 2: a fresh compositor + adapter. The renderer mints UNRELATED
  // handles (a fresh FakeRendererAdapter restarts at surface-0, and we open in
  // a DIFFERENT order so handle<->view correspondence differs from Session 1).
  const s2 = setup();
  for (const viewId of [C, A, B]) { // different order -> handles bind differently
    await s2.compositor.openView({viewId, viewDescriptor: viewDescriptor(), presentationDescriptor: descriptors.get(viewId)});
  }

  // The composition TREE is unchanged (it never carried handles).
  const restoredTree = validate(JSON.parse(JSON.stringify(tree)));
  assert.deepEqual(restoredTree, tree, 'the composition tree is identical after recreate');
  assert.deepEqual([...leafViewIds(restoredTree)].sort(), [A, B, C].sort(), 'same durable leaf viewIds');

  // The presentations are restored by durable viewId.
  const intent2 = s2.compositor.durableIntent();
  const subjectById = new Map(intent2.map((v) => [v.viewId, v.presentationDescriptor.subject.objectId]));
  assert.equal(subjectById.get(A), 'obj-a');
  assert.equal(subjectById.get(B), 'obj-b');
  assert.equal(subjectById.get(C), 'obj-c');

  // NO old surface handle occurs anywhere in the durable intent.
  for (const v of intent2) {
    assert.ok(!('surfaceHandle' in v), 'no surface handle in durable intent');
  }
  // Focus is transient: a fresh Session starts unfocused; nothing restored it.
  assert.equal(s2.compositor.focusedView(), null, 'focus is transient, never restored from composition');
  await s2.compositor.destroy();
});
