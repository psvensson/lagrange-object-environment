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

function makeShell({records = {}, readError = null, authorityFor = null, writableSlots = []} = {}) {
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  const readCalls = [];
  const adapter = {
    async readObject({imageId, objectId, authority, blockId} = {}) {
      readCalls.push({imageId, objectId, authority, blockId});
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
  const shell = createEnvironmentShell({navigator, selectionModel, compositor, writableSlots});
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

test('handleActivateItem defaults to navigator resolution; a stale key is a no-op (never a wrong ref)', async () => {
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

test('handleActivateItem resolves against the named view current descriptor and preserves a cross-Image ref', async () => {
  const first = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const retargeted = {kind: 'ref', imageId: 'third-image', objectId: 'obj-c'};
  const records = {
    'obj-root': {slots: {}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
    'obj-c': {slots: {'slot-title': {kind: 'text', value: 'C'}}, indexed: []},
  };
  const {shell, selectionModel, compositor, readCalls} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const projectDescriptor = (target) => ({
    kind: 'project',
    subject: {kind: 'project', imageId: 'project-image', projectId: 'p'},
    parameters: {project: {members: [{key: 'stable', role: 'source', target}]}},
  });
  await compositor.openView({
    viewId: 'project-view',
    viewDescriptor: {kind: 'canvas', width: 64, height: 64},
    presentationDescriptor: projectDescriptor(first),
  });
  const seen = [];
  const resolveItem = (descriptor, key) => {
    seen.push(descriptor);
    if (!Number.isSafeInteger(key)) return null;
    return descriptor?.parameters?.project?.members[key]?.target ?? null;
  };

  const authority = {opaque: true};
  const selectedFirst = await shell.handleActivateItem({
    key: 0, viewId: 'project-view', resolveItem, authority, readBlockId: 'read-lane',
  });
  assert.equal(selectedFirst, first, 'the resolver result crosses the shell unchanged');
  assert.deepEqual(selectionModel.selectedSubject(), first);
  assert.deepEqual(readCalls.at(-1), {
    imageId: 'other-image', objectId: 'obj-b', authority, blockId: 'read-lane',
  }, 'the cross-Image ref and explicit read context reach ObjectNavigator unchanged');
  assert.equal(compositor.focusedView(), 'project-view', 'selection focuses its actual source view');

  const current = projectDescriptor(retargeted);
  await compositor.presentOn('project-view', current);
  const selectedRetargeted = await shell.handleActivateItem({key: 0, viewId: 'project-view', resolveItem});
  assert.equal(seen.at(-1), current, 'the resolver receives the current Compositor descriptor, not a cached copy');
  assert.equal(selectedRetargeted, retargeted);
  assert.deepEqual(selectionModel.selectedSubject(), retargeted,
    'the same local key follows the current descriptor cross-Image target unchanged');

  assert.equal(await shell.handleActivateItem({key: 9, viewId: 'project-view', resolveItem}), null);
  assert.deepEqual(selectionModel.selectedSubject(), retargeted, 'a stale key cannot change selection');
  await compositor.destroy();
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

test('bindIntents routes an edit-field intent from the inspector surface to handleEditField (the host-neutral hookup)', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: [], versionToken: 'tok-root'},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}, 'probe-count': {kind: 'integer', value: '7'}}, indexed: [], versionToken: 'tok-b'},
  };
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  // A minimal adapter intent seam stub + a capturing CommandRouter.
  const handlers = new Set();
  const adapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  const calls = [];
  const commandRouter = {consumeIntent: async (intent, opts) => { calls.push({intent, opts}); return {ok: true}; }};
  shell.bindIntents({
    adapter, navigatorSurfaceHandle: 'nav-surface', inspectorSurfaceHandle: 'insp-surface',
    commandRouter, authority: null, readBlockId: undefined,
  });
  // An edit-field intent from the INSPECTOR surface routes to handleEditField,
  // which resolves key->slot + attaches the transient token and calls the router.
  for (const fn of handlers) fn({kind: 'edit-field', key: 0, text: 'B-edited'}, 'insp-surface');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'the edit-field intent reached the CommandRouter');
  assert.deepEqual(calls[0].intent, {kind: 'edit-field', key: 0});
  assert.equal(calls[0].opts.surfaceHandle, 'insp-surface');
  assert.equal(calls[0].opts.context.slot, 'probe-title', 'key 0 resolved to the writable slot');
  assert.equal(calls[0].opts.context.text, 'B-edited', 'the raw text passes through');
  assert.equal(calls[0].opts.context.versionToken, 'tok-b', 'the transient token is attached');
  // An edit-field intent from a DIFFERENT surface is ignored.
  for (const fn of handlers) fn({kind: 'edit-field', key: 0, text: 'x'}, 'other-surface');
  // An activate-item intent from the NAVIGATOR surface still routes to selection.
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'nav-surface');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'a wrong-surface edit-field and the navigator activate-item do NOT reach the edit router');
  await compositor.destroy();
});

test('bindIntents routes activation bindings by surface to their named view resolver', async () => {
  const target = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const records = {
    'obj-root': {slots: {}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
  };
  const {shell, selectionModel, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  await compositor.openView({
    viewId: 'project-view',
    viewDescriptor: {kind: 'canvas', width: 64, height: 64},
    presentationDescriptor: {
      kind: 'project', subject: {kind: 'project', imageId: 'img', projectId: 'p'},
      parameters: {target},
    },
  });
  const handlers = new Set();
  const adapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  assert.throws(() => shell.bindIntents({
    adapter,
    navigatorSurfaceHandle: 'shared-surface',
    activationBindings: [{
      surfaceHandle: 'shared-surface', viewId: 'project-view', resolveItem: () => target,
    }],
  }), /surfaceHandle bindings must be unique/,
  'one renderer surface cannot ambiguously own two activation resolutions');
  shell.bindIntents({
    adapter,
    activationBindings: [{
      surfaceHandle: 'project-surface',
      viewId: 'project-view',
      resolveItem: (descriptor, key) => key === 0 ? descriptor.parameters.target : null,
    }],
  });

  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'project-surface');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(selectionModel.selectedSubject(), target);
  assert.equal(compositor.focusedView(), 'project-view');

  selectionModel.clear();
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'other-surface');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(selectionModel.selectedSubject(), null, 'an unbound surface cannot activate an item');
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

// --- S4a: edit-field routing through CommandRouter; transient token lifecycle -

// A mock CommandRouter that captures the intent + context the shell routes, so
// the test proves the shell resolves key->slot and attaches the transient token,
// and that CommandRouter (not the shell) owns dispatch.
function makeCapturingRouter(result = {ok: true}) {
  const calls = [];
  return {
    calls,
    async consumeIntent(intent, {surfaceHandle, context} = {}) {
      calls.push({intent, surfaceHandle, context});
      return result;
    },
  };
}

test('handleEditField resolves the descriptor-local key to a writable slot and routes through CommandRouter with the transient token', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: [], versionToken: 'tok-root'},
    'obj-b': {
      slots: {'probe-title': {kind: 'text', value: 'B'}, 'probe-count': {kind: 'integer', value: '7'}},
      indexed: [],
      versionToken: 'tok-b',
    },
  };
  // probe-title is writable; probe-count is read-only.
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});

  // The transient token is paired with the displayed inspector (obj-b), and is
  // NOT in the descriptor/durableIntent.
  assert.deepEqual(shell._inspectorToken(), {token: 'tok-b', objectId: 'obj-b'});
  const inspView = compositor.durableIntent().find((v) => v.viewId === 'inspector-view');
  assert.ok(!('versionToken' in (inspView.presentationDescriptor.parameters ?? {})), 'no token in the inspector descriptor');
  assert.deepEqual(inspView.presentationDescriptor.parameters.writable, ['probe-title'], 'the writable set is threaded to the descriptor');

  const router = makeCapturingRouter({objectId: 'obj-b'});
  const result = await shell.handleEditField({
    key: 0, text: 'B-edited', commandRouter: router, inspectorSurfaceHandle: 'insp-surface-0',
  });
  assert.deepEqual(result, {objectId: 'obj-b'}, 'the dispatch result is returned');
  // The shell routed a semantic edit-field intent through CommandRouter, with the
  // resolved slot + the transient token in the dispatch context (NEVER a descriptor).
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0].intent, {kind: 'edit-field', key: 0});
  assert.equal(router.calls[0].surfaceHandle, 'insp-surface-0');
  assert.equal(router.calls[0].context.slot, 'probe-title', 'key 0 resolved to the writable slot');
  assert.equal(router.calls[0].context.text, 'B-edited', 'the RAW text passes through unparsed');
  assert.equal(router.calls[0].context.versionToken, 'tok-b', 'the transient token is attached to the dispatch context');
  await compositor.destroy();
});

test('handleEditField: a stale or read-only key is an explicit no-op (never a wrong slot, no dispatch)', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: [], versionToken: 'tok-root'},
    'obj-b': {
      slots: {'probe-title': {kind: 'text', value: 'B'}, 'probe-count': {kind: 'integer', value: '7'}},
      indexed: [],
      versionToken: 'tok-b',
    },
  };
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  const router = makeCapturingRouter();
  // key 1 would name probe-count (read-only) if the shell miscounted writable
  // fields; key 99 is out of range. Both are no-ops with NO dispatch.
  assert.equal(await shell.handleEditField({key: 1, text: 'x', commandRouter: router, inspectorSurfaceHandle: 's'}), null);
  assert.equal(await shell.handleEditField({key: 99, text: 'x', commandRouter: router, inspectorSurfaceHandle: 's'}), null);
  assert.equal(router.calls.length, 0, 'a stale/read-only key never reaches CommandRouter');
  await compositor.destroy();
});

test('the transient token is cleared when the inspected subject changes', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b'), 'slot-c': ref('obj-c')}, indexed: [], versionToken: 'tok-root'},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'},
    'obj-c': {slots: {'probe-title': {kind: 'text', value: 'C'}}, indexed: [], versionToken: 'tok-c'},
  };
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  assert.deepEqual(shell._inspectorToken(), {token: 'tok-b', objectId: 'obj-b'});
  // Switch the inspected subject: the old token is dropped and replaced by the
  // new subject's token (paired with the successful reread -> presentOn).
  await shell.selectObject(ref('obj-c'), {});
  assert.deepEqual(shell._inspectorToken(), {token: 'tok-c', objectId: 'obj-c'});
  await compositor.destroy();
});

test('an unreadable inspector (unavailable/unauthorized) carries NO transient token', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: [], versionToken: 'tok-root'},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'},
  };
  // obj-c is not in records -> authorized-but-missing -> unavailable-ref.
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  assert.equal(shell._inspectorToken().token, 'tok-b');
  // Re-navigate to a subject that becomes unreadable: no token survives.
  await shell.selectObject(ref('obj-c'), {});
  assert.deepEqual(shell._inspectorToken(), {token: null, objectId: 'obj-c'},
    'a failure presentation carries no token (paired only with a successful read)');
  await compositor.destroy();
});
