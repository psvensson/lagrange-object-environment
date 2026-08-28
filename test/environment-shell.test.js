import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createSelectionModel} from '../src/selection-model.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createObjectNavigator} from '../src/object-navigator.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {
  createObjectInspectorProvider,
  createUnavailableRefProvider,
  createUnauthorizedRefProvider,
} from '../src/object-presentation-providers.js';

// The EnvironmentShell headless proof (Bead cny slice 1): selection drives the
// inspector through the real owners (ObjectNavigator / SelectionModel /
// Compositor), with no shadow browser model and no direct image read.

const ref = (objectId) => ({kind: 'ref', imageId: 'img', objectId});
const pinned = (objectId, revision) => ({kind: 'pinned-ref', imageId: 'img', objectId, revision: String(revision)});
function referencesOfValue(value) {
  if (value && typeof value === 'object' && (value.kind === 'ref' || value.kind === 'pinned-ref')) return [value];
  return [];
}

function makeShell({records = {}, readError = null, authorityFor = null} = {}) {
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  const readCalls = [];
  const adapter = {
    async readObject({imageId, objectId, authority, blockId} = {}) {
      readCalls.push({objectId});
      if (readError) throw readError;
      if (authorityFor && !authorityFor({imageId, objectId, authority})) {
        const denied = new Error(`not authorized: object/read ${objectId}`);
        denied.name = 'AuthorityError';
        throw denied;
      }
      return records[objectId] ?? null;
    },
  };
  const navigator = createObjectNavigator({adapter, presentationRegistry, commandRegistry, referencesOfValue});
  const selectionModel = createSelectionModel();
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor});
  return {shell, navigator, selectionModel, compositor, rendererAdapter, readCalls};
}

test('openWorkspace + selectObject: selection drives the inspector via a descriptor through presentOn', async () => {
  const records = {
    'obj-root': {slots: {'slot-title': {kind: 'text', value: 'Root'}, 'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
  };
  const {shell, selectionModel, compositor, rendererAdapter} = makeShell({records});

  await shell.openWorkspace(ref('obj-root'), {});
  // Both panes exist; the navigator pane is kind 'navigator' carrying the root's refs.
  const intent = compositor.durableIntent();
  const nav = intent.find((v) => v.viewId === 'navigator-view');
  const insp = intent.find((v) => v.viewId === 'inspector-view');
  assert.equal(nav.presentationDescriptor.kind, 'navigator');
  assert.equal(insp.presentationDescriptor.kind, 'inspector');
  assert.equal(insp.presentationDescriptor.subject.objectId, 'obj-root');
  // The navigator pane carries the root's discovered refs as data (no shadow model).
  assert.deepEqual(nav.presentationDescriptor.parameters.references.map((r) => r.objectId), ['obj-b']);

  // Activate ref B (a selection gesture).
  const descriptor = await shell.selectObject(ref('obj-b'), {});
  // Selection updated to B; focus is the NAVIGATOR pane (the user is interacting there).
  assert.deepEqual(selectionModel.selectedSubject(), ref('obj-b'));
  assert.equal(compositor.focusedView(), 'navigator-view');
  // The inspector re-presented B: the update traveled as a DESCRIPTOR through
  // presentOn (attach/detach on the fake adapter), NOT as shell-side DOM poking.
  assert.equal(descriptor.subject.objectId, 'obj-b');
  const attached = rendererAdapter.calls().filter((c) => c.method === 'attachPresentation');
  const lastAttach = attached[attached.length - 1];
  assert.equal(lastAttach.detail.presentationDescriptor.subject.objectId, 'obj-b', 'the inspector update is a descriptor via presentOn');
  await compositor.destroy();
});

test('an unauthorized ref yields the explicit unauthorized-ref inspector presentation', async () => {
  const records = {'obj-root': {slots: {'slot-c': ref('obj-c')}, indexed: []}};
  const {shell} = makeShell({records, authorityFor: ({objectId}) => objectId !== 'obj-c'});
  await shell.openWorkspace(ref('obj-root'), {});
  // Selecting C (denied read) presents the explicit unauthorized-ref kind.
  const descriptor = await shell.selectObject(ref('obj-c'), {});
  assert.equal(descriptor.kind, 'unauthorized-reference', 'denied read materializes as the unauthorized-ref presentation (no existence oracle)');
  assert.equal(descriptor.subject.objectId, 'obj-c');
});

test('inspectSelected re-navigates the selected object (the observation->reread path); NO shadow state', async () => {
  // B's record MUTATES externally; the shell re-navigates and the inspector
  // reflects the NEW value (which the UI never held). A shadow-state cache
  // would show the stale value and go red.
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B-original'}}, indexed: []},
  };
  const {shell, readCalls} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  // Externally mutate B to a value the UI never displayed.
  records['obj-b'] = {slots: {'slot-title': {kind: 'text', value: 'B-EXTERNAL-EDIT'}}, indexed: []};
  // The observation->reread path re-navigates (fresh authorized read).
  const descriptor = await shell.inspectSelected({});
  assert.equal(descriptor.parameters.fields['slot-title'].value, 'B-EXTERNAL-EDIT', 'the inspector reflects the externally-mutated state, not a UI-side cache');
  assert.equal(descriptor.subject.objectId, 'obj-b', 'same B identity');
  // Read-count: root (1) + select B (1) + reread B (1) = exactly 3 authorized
  // reads. A shadow ref-model pre-reading children would read more.
  assert.equal(readCalls.length, 3, 'exactly the navigate() reads the loop implies (no shadow-model pre-reads)');
});

test('handleActivateItem resolves a descriptor-local key to a ref; a stale key is a no-op (never a wrong ref)', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b'), 'slot-c': ref('obj-c')}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
  };
  const {shell, selectionModel} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  // Activate key 0 -> obj-b (the navigator's references[0]).
  const selected = await shell.handleActivateItem({key: 0});
  assert.equal(selected.objectId, 'obj-b', 'key 0 resolves to the navigator\'s references[0]');
  assert.deepEqual(selectionModel.selectedSubject(), ref('obj-b'));
  // A STALE key (out of range) resolves to null and does NOT change the selection.
  const stale = await shell.handleActivateItem({key: 99});
  assert.equal(stale, null, 'an out-of-range key is a no-op');
  assert.deepEqual(selectionModel.selectedSubject(), ref('obj-b'), 'the selection is unchanged by a stale key');
  // A non-number key is a no-op too.
  assert.equal(await shell.handleActivateItem({key: 'obj-c'}), null, 'a key is an index, never a ref');
  await shell.destroy?.();
});

test('bindDomIntents routes a DOM activate-item from the navigator surface to selection', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
  };
  const {shell, selectionModel, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  // A minimal adapter intent seam stub.
  const handlers = new Set();
  const adapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  shell.bindDomIntents({adapter, navigatorSurfaceHandle: 'fake-surface-0'});
  // Emit an activate-item key 0 from the navigator surface.
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'fake-surface-0');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(selectionModel.selectedSubject(), ref('obj-b'), 'the DOM intent resolved + selected obj-b');
  // An intent from a DIFFERENT surface is ignored.
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'fake-surface-999');
  // A non-activate-item intent is ignored.
  selectionModel.clear();
  for (const fn of handlers) fn({kind: 'activate'}, 'fake-surface-0');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(selectionModel.selectedSubject(), null, 'a non-activate-item intent does not select');
  await compositor.destroy();
});

test('durable intent is focus/selection/handle-free after select (focus/selection are transient)', async () => {
  const records = {'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  // Durable intent is focus-free + selection-free (focus/selection are transient).
  const intent = compositor.durableIntent();
  assert.equal(intent.length, 2, 'both panes present');
  for (const v of intent) {
    assert.ok(!('focus' in v) && !('focusedView' in v) && !('selection' in v) && !('surfaceHandle' in v), 'durable intent is focus/selection/handle-free');
  }
  assert.deepEqual(intent.map((v) => v.viewId).sort(), ['inspector-view', 'navigator-view']);
  await compositor.destroy();
});
