import assert from 'node:assert/strict';
import test from 'node:test';

import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createSelectionModel} from '../src/selection-model.js';

// The selection/focus kernel proof (Bead lagrange-object-environment-7k0).
// Focus (which logical VIEW) and selection (which semantic SUBJECT) are
// DISTINCT owners, strictly not conflated. The renderer never names a subject;
// the semantic subject comes from the environment's own view/presentation
// structure. Headless; the renderer is the FakeRendererAdapter.

const ref = (objectId, imageId = 'img') => Object.freeze({kind: 'ref', imageId, objectId});

function open(compositor, subject, width = 320) {
  return compositor.openView({
    viewDescriptor: {kind: 'webgpu-canvas', width, height: 200},
    presentationDescriptor: {kind: 'glb', subject, parameters: {}},
  });
}

test('focus and selection are distinct owners, subject never from renderer', async () => {
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const selection = createSelectionModel();

  const viewA = await open(compositor, ref('obj-a'));
  const viewB = await open(compositor, ref('obj-b'));

  // (1) focusing A does not focus B (single focus by construction).
  compositor.focusView(viewA);
  assert.equal(compositor.focusedView(), viewA, 'A focused');
  compositor.focusView(viewB);
  assert.equal(compositor.focusedView(), viewB, 'focusing B unfocuses A');
  assert.notEqual(compositor.focusedView(), viewA, 'A no longer focused');

  // (2) selecting via an interaction gets the subject from the view's
  // presentationDescriptor, never from renderer input. The renderer only
  // supplies a surface handle ('interaction happened on this view').
  compositor.focusView(viewA);
  const handleA = 'fake-surface-0'; // minted in openView order
  const r = compositor.interactWithSurface(handleA, selection);
  assert.equal(r.viewId, viewA, 'the interaction focuses the bound view');
  assert.equal(compositor.focusedView(), viewA, 'interaction focused A');
  assert.deepEqual(selection.selectedSubject(), ref('obj-a'), 'selection is A\'s semantic subject');
  assert.ok(selection.isSelected(ref('obj-a')), 'selection by semantic identity, not the handle');

  // (3) selection is keyed by SEMANTIC identity, so selecting B after A means
  // A is no longer selected (a global/handle key would conflate them).
  selection.select(ref('obj-b'));
  assert.ok(selection.isSelected(ref('obj-b')), 'B now selected');
  assert.ok(!selection.isSelected(ref('obj-a')), 'A no longer selected (per-subject identity)');
  selection.select(ref('obj-a')); // restore for the next steps

  // (4) selection confers ZERO authority: it is identity data, no capability.
  const sel = selection.selection();
  assert.ok(!('authority' in sel) && !('grant' in sel), 'selection carries no authority/grant');
  assert.deepEqual(Object.keys(sel).sort(), ['key', 'subject'], 'selection is only {subject, key}');

  // (5) destroying a focused view clears focus cleanly (no stale handle).
  await compositor.closeView(viewA);
  assert.equal(compositor.focusedView(), null, 'closing the focused view clears focus');

  // (6) focus is NEVER serialized to Perspective: durableIntent is handle-free
  // AND focus-free.
  const intent = compositor.durableIntent();
  for (const entry of intent) {
    assert.ok(!('surfaceHandle' in entry), 'durableIntent is handle-free');
    assert.ok(!('focused' in entry) && !('focus' in entry), 'durableIntent carries no focus');
  }

  // (7) an interaction on an unknown handle resolves to no view (no crash, no
  // focus/selection change).
  compositor.focusView(viewB);
  selection.clear();
  const nowhere = compositor.interactWithSurface('fake-surface-999', selection);
  assert.equal(nowhere, null, 'unknown handle -> no view');
  assert.equal(compositor.focusedView(), viewB, 'unknown handle does not change focus');
  assert.equal(selection.selectedSubject(), null, 'unknown handle does not change selection');

  await compositor.destroy();
});

test('renderer teardown/recreation cannot change semantic selection (keyed by subject, not handle)', async () => {
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const selection = createSelectionModel();

  const viewA = await open(compositor, ref('obj-a'));
  compositor.interactWithSurface('fake-surface-0', selection);
  assert.deepEqual(selection.selectedSubject(), ref('obj-a'), 'A selected');

  // Tear down the whole renderer (new GPU/surface handles on recreate).
  await compositor.destroy();
  assert.deepEqual(selection.selectedSubject(), ref('obj-a'), 'selection survives renderer teardown (keyed by subject, not handle)');

  // A fresh Compositor/Session mints a RECYCLED handle `fake-surface-0` — but
  // bound to a DIFFERENT subject (obj-b). If selection were keyed by handle,
  // interacting with the recycled handle would either clobber obj-a or the
  // stale handle would still resolve to obj-a. Keyed by SUBJECT, neither
  // happens.
  const fresh = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  await open(fresh, ref('obj-b')); // recycled handle fake-surface-0 -> obj-b
  assert.ok(selection.isSelected(ref('obj-a')), 'selection is STILL obj-a after a recycled handle appears (keyed by subject)');
  // The discriminator: a handle-keyed selection would falsely resolve obj-b
  // (whose handle recycled fake-surface-0) as selected -> RED.
  assert.ok(!selection.isSelected(ref('obj-b')), 'obj-b is NOT selected just because its handle recycled the old one');

  // Interacting with the recycled handle selects obj-b (the CURRENT subject),
  // proving the resolution is by current view, not a stale handle->selection.
  const r = fresh.interactWithSurface('fake-surface-0', selection);
  assert.deepEqual(r.subject, ref('obj-b'), 'the recycled handle resolves to its CURRENT subject');
  assert.ok(selection.isSelected(ref('obj-b')), 'after interacting, obj-b is selected (current subject, not stale)');
  assert.ok(!selection.isSelected(ref('obj-a')), 'obj-a deselected by the new interaction (per-subject identity)');

  assert.notEqual(fresh.focusedView(), null, 'interaction focused the fresh view');
  await fresh.destroy();
});

test('two presentations of the same subject: distinct focus, same selection', async () => {
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const selection = createSelectionModel();

  // A source view A1 and a 3D view A2 of the SAME object.
  const viewA1 = await open(compositor, ref('obj-a'));
  const viewA2 = await open(compositor, ref('obj-a'));

  // Interact with A2 (the 3D view): focus = A2, selection = Object A.
  compositor.interactWithSurface('fake-surface-1', selection);
  assert.equal(compositor.focusedView(), viewA2, 'focus is A2 (the interacted view)');
  assert.deepEqual(selection.selectedSubject(), ref('obj-a'), 'selection is Object A');

  // Interact with A1 (the source view): focus moves to A1, selection is STILL
  // Object A (same semantic identity, distinct view focus).
  compositor.interactWithSurface('fake-surface-0', selection);
  assert.equal(compositor.focusedView(), viewA1, 'focus moves to A1');
  assert.deepEqual(selection.selectedSubject(), ref('obj-a'), 'selection is STILL Object A (same subject, distinct focus)');
  assert.ok(selection.isSelected(ref('obj-a')), 'the same semantic selection across both views');

  await compositor.destroy();
});

test('selection identity edge cases: missing-vs-empty imageId, non-ref no-op', async () => {
  const selection = createSelectionModel();

  // A subject with a missing imageId is a DIFFERENT identity from one with an
  // empty-string imageId (S2: the key must not merge them).
  const noImage = {kind: 'ref', objectId: 'x'};
  const emptyImage = {kind: 'ref', imageId: '', objectId: 'x'};
  selection.select(noImage);
  assert.ok(selection.isSelected(noImage), 'missing-imageId selected');
  assert.ok(!selection.isSelected(emptyImage), 'empty-imageId is a DIFFERENT identity (not merged)');

  // A non-ref subject is NOT selectable: select() is a no-op that leaves the
  // current selection unchanged (N1), NOT a clear.
  selection.select(emptyImage);
  assert.ok(selection.isSelected(emptyImage), 'empty-imageId now selected');
  const ret = selection.select({kind: 'literal', value: 42});
  assert.equal(ret, null, 'a non-ref subject returns null (not selectable)');
  assert.ok(selection.isSelected(emptyImage), 'a non-ref select() does NOT clear the current selection');

  // Explicit clear() still works.
  selection.clear();
  assert.equal(selection.selectedSubject(), null, 'explicit clear empties the selection');
});

test('selection is transient by default and never enters durable intent', async () => {
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const selection = createSelectionModel();
  await open(compositor, ref('obj-a'));
  compositor.interactWithSurface('fake-surface-0', selection);
  assert.ok(selection.isSelected(ref('obj-a')));

  // The durable intent (the only thing allowed to reach a Perspective) has no
  // selection and no focus.
  const intent = compositor.durableIntent();
  assert.equal(intent.length, 1);
  assert.ok(!('selection' in intent[0]) && !('selectedSubject' in intent[0]), 'no selection in durable intent');
  assert.ok(!('focused' in intent[0]), 'no focus in durable intent');
  await compositor.destroy();
});
