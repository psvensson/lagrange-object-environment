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

test('bindIntents({navigator: true}) routes a host activate-item from the navigator view to selection', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}, indexed: []},
  };
  const {shell, selectionModel, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  // A minimal adapter intent seam stub.
  const handlers = new Set();
  const adapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  shell.bindIntents({adapter, navigator: true});
  // Emit an activate-item key 0 from the navigator's LIVE surface.
  const navSurface = compositor.surfaceHandleForView('navigator-view');
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, navSurface);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(selectionModel.selectedSubject(), ref('obj-b'), 'the DOM intent resolved + selected obj-b');
  // An intent from a DIFFERENT surface is ignored.
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, 'fake-surface-999');
  // A non-activate-item intent is ignored.
  selectionModel.clear();
  for (const fn of handlers) fn({kind: 'activate'}, navSurface);
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
  // The inspector surface must be the LIVE handle the Compositor gave that view:
  // the shell resolves the bound view by surface (the same source the
  // CommandRouter uses for the subject), so a made-up handle is a no-op.
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const navSurface = compositor.surfaceHandleForView('navigator-view');
  shell.bindIntents({
    adapter, navigator: true, inspector: true,
    commandRouter, authority: null, readBlockId: undefined,
  });
  // An edit-field intent from the INSPECTOR surface routes through the inspector's
  // edit binding, which resolves key->slot + attaches the transient token.
  for (const fn of handlers) fn({kind: 'edit-field', key: 0, text: 'B-edited'}, inspSurface);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'the edit-field intent reached the CommandRouter');
  assert.deepEqual(calls[0].intent, {kind: 'edit-field', key: 0});
  assert.equal(calls[0].opts.surfaceHandle, inspSurface);
  assert.deepEqual(calls[0].opts.context.field, {slot: 'probe-title'}, 'key 0 resolved to the writable slot, NESTED under field');
  assert.deepEqual(Object.keys(calls[0].opts.context).sort(), ['commandId', 'field', 'text', 'versionToken'], 'the shell\'s context keys are fixed');
  assert.equal(calls[0].opts.context.text, 'B-edited', 'the raw text passes through');
  assert.equal(calls[0].opts.context.versionToken, 'tok-b', 'the transient token is attached');
  // An edit-field intent from a DIFFERENT surface is ignored.
  for (const fn of handlers) fn({kind: 'edit-field', key: 0, text: 'x'}, 'other-surface');
  // An activate-item intent from the NAVIGATOR surface still routes to selection.
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, navSurface);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, 'a wrong-surface edit-field and the navigator activate-item do NOT reach the edit router');
  await compositor.destroy();
});

test('bindIntents routes activation bindings by the LIVE view behind the emitted surface to that view\'s resolver', async () => {
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
    navigator: true,
    activationBindings: [{viewId: 'navigator-view', resolveItem: () => target}],
  }), /activation bindings must be unique per viewId/,
  'one logical view cannot ambiguously own two activation resolutions');
  shell.bindIntents({
    adapter,
    activationBindings: [{
      viewId: 'project-view',
      resolveItem: (descriptor, key) => key === 0 ? descriptor.parameters.target : null,
    }],
  });
  const projectSurface = compositor.surfaceHandleForView('project-view');
  for (const fn of handlers) fn({kind: 'activate-item', key: 0}, projectSurface);
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
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const result = await shell.handleEditField({
    key: 0, text: 'B-edited', commandRouter: router, surfaceHandle: inspSurface,
  });
  assert.deepEqual(result, {objectId: 'obj-b'}, 'the dispatch result is returned');
  // The shell routed a semantic edit-field intent through CommandRouter, with the
  // resolved slot + the transient token in the dispatch context (NEVER a descriptor).
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0].intent, {kind: 'edit-field', key: 0});
  assert.equal(router.calls[0].surfaceHandle, inspSurface);
  assert.deepEqual(router.calls[0].context.field, {slot: 'probe-title'}, 'key 0 resolved to the writable slot (nested under field)');
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
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const router = makeCapturingRouter();
  // key 1 would name probe-count (read-only) if the shell miscounted writable
  // fields; key 99 is out of range. Both are no-ops with NO dispatch.
  assert.equal(await shell.handleEditField({key: 1, text: 'x', commandRouter: router, surfaceHandle: inspSurface}), null);
  assert.equal(await shell.handleEditField({key: 99, text: 'x', commandRouter: router, surfaceHandle: inspSurface}), null);
  // A handle that resolves to NO live view is an explicit no-op too (the view is
  // gone or never was this shell's inspector), never a dispatch against another view.
  assert.equal(await shell.handleEditField({key: 0, text: 'x', commandRouter: router, surfaceHandle: 'not-a-live-surface'}), null);
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

// ---------------------------------------------------------------------------
// Bead 6lm: generic EDIT BINDINGS (the shell's row 65 generalized). Everything
// below is proved at the shell's intent contract with synthesized intents: no
// SemanticUi producer emits edit-field for a non-inspector surface yet (Bead ndk).
// ---------------------------------------------------------------------------

// A bound non-inspector view: a 'custom' presentation whose descriptor carries
// labels the CONSUMER's resolver indexes. Nothing Project/Images-specific.
async function openCustomView(compositor, {labels = ['first'], subject = {kind: 'ref', imageId: 'img', objectId: 'obj-root'}} = {}) {
  const presentationDescriptor = {kind: 'custom', subject, parameters: {labels}};
  await compositor.openView({
    viewId: 'custom-view',
    viewDescriptor: {kind: 'canvas', width: 64, height: 64},
    presentationDescriptor,
  });
  return {surface: compositor.surfaceHandleForView('custom-view'), presentationDescriptor};
}
const labelResolver = (descriptor, key) => descriptor?.parameters?.labels?.[key] ? {field: descriptor.parameters.labels[key]} : null;
function intentSeam() {
  const handlers = new Set();
  const adapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  const emit = (intent, surface) => { for (const fn of handlers) fn(intent, surface); };
  return {adapter, emit};
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('(a) an edit binding routes an edit-field intent from ITS surface with the resolver context nested under field, its own token and commandId; the resolver sees the CURRENT descriptor', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface, presentationDescriptor} = await openCustomView(compositor);
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter({routed: true});
  const seen = [];
  const tokens = [];
  const edited = [];
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{
      viewId: 'custom-view',
      resolveField: (descriptor, key) => { seen.push(descriptor); return labelResolver(descriptor, key); },
      tokenFor: (descriptor) => { tokens.push(descriptor); return 'custom-token'; },
      commandId: 'rename-thing',
      onEdited: (result) => { edited.push(result); },
    }],
  });
  emit({kind: 'edit-field', key: 0, text: 'new text'}, surface);
  await settle();
  assert.equal(router.calls.length, 1, 'the non-inspector edit-field intent reached the CommandRouter');
  assert.deepEqual(router.calls[0].intent, {kind: 'edit-field', key: 0});
  assert.equal(router.calls[0].surfaceHandle, surface);
  assert.deepEqual(router.calls[0].context, {commandId: 'rename-thing', text: 'new text', versionToken: 'custom-token', field: {field: 'first'}});
  assert.equal(seen[0].kind, 'custom', 'the resolver received the BOUND view\'s descriptor (by kind)');
  assert.deepEqual(seen[0].subject, presentationDescriptor.subject, '…and by subject identity, not the inspector\'s');
  assert.equal(tokens[0], seen[0], 'tokenFor receives the same resolved descriptor the resolver saw');
  assert.deepEqual(edited, [{routed: true}], 'onEdited receives the router result verbatim');
  // Re-present the bound view: the resolver sees the CURRENT descriptor, not a cached one.
  const current = {kind: 'custom', subject: presentationDescriptor.subject, parameters: {labels: ['renamed-label']}};
  await compositor.presentOn('custom-view', current);
  emit({kind: 'edit-field', key: 0, text: 'again'}, surface);
  await settle();
  assert.equal(router.calls.length, 2);
  assert.deepEqual(router.calls[1].context.field, {field: 'renamed-label'});
  assert.equal(seen.at(-1), current, 'the resolver receives the current Compositor descriptor object');
  await compositor.destroy();
});

test('(b) resolver null = explicit no-op; (b\') a descriptor carrying inspector-style fields/writable does NOT trigger a shell-side fallback slot walk; (f) tokenFor absent -> versionToken null even while the inspector holds a LIVE token', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'},
  };
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  assert.equal(shell._inspectorToken().token, 'tok-b', 'precondition: the inspector holds a live token');
  // A foreign view whose descriptor LOOKS like an inspector descriptor (fields +
  // writable). If the shell fell back to its own key->slot walk when the binding
  // resolver returns null, this would dispatch. It must not.
  const lookalike = {
    kind: 'custom', subject: {kind: 'ref', imageId: 'img', objectId: 'obj-b'},
    parameters: {fields: {'probe-title': 'B'}, writable: ['probe-title'], labels: ['x']},
  };
  await compositor.openView({viewId: 'custom-view', viewDescriptor: {kind: 'canvas', width: 64, height: 64}, presentationDescriptor: lookalike});
  const surface = compositor.surfaceHandleForView('custom-view');
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{viewId: 'custom-view', commandId: 'custom-edit', resolveField: (d, key) => key === 1 ? {} : null}],
  });
  // Key 0 is EXACTLY the key the inspector's own key->writable-slot walk would
  // resolve on this lookalike descriptor; the binding's resolver says null. A
  // shell that fell back to its inspector walk would dispatch here. It must not.
  emit({kind: 'edit-field', key: 0, text: 'x'}, surface); // resolver -> null
  await settle();
  assert.equal(router.calls.length, 0, 'a null resolution is a no-op: no shell-side fallback resolution against fields/writable');
  emit({kind: 'edit-field', key: 1, text: 'x'}, surface); // resolver -> {} (legal, dispatches)
  await settle();
  assert.equal(router.calls.length, 1, '{} is a legal field context and dispatches');
  assert.deepEqual(router.calls[0].context.field, {});
  assert.equal(router.calls[0].context.versionToken, null, 'no tokenFor -> null, NOT the inspector\'s live token');
  assert.equal(shell._inspectorToken().token, 'tok-b', 'the inspector token is untouched by a foreign edit');
  await compositor.destroy();
});

test('(c),(d),(h) routing by (kind, live view): an unbound surface is ignored; the inspector still routes to its own binding; an activation binding and an edit binding coexist on one view', async () => {
  const target = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'},
  };
  const {shell, selectionModel, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  const {surface} = await openCustomView(compositor, {labels: ['lbl']});
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  shell.bindIntents({
    adapter, commandRouter: router, inspector: true,
    activationBindings: [{viewId: 'custom-view', resolveItem: (d, key) => key === 0 ? target : null}],
    editBindings: [{viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver}],
  });
  emit({kind: 'edit-field', key: 0, text: 'x'}, 'unbound-surface');
  await settle();
  assert.equal(router.calls.length, 0, 'an unbound surface routes nowhere');
  emit({kind: 'edit-field', key: 0, text: 'from inspector'}, inspSurface);
  await settle();
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0].context.field, {slot: 'probe-title'}, 'the inspector surface still resolves via its own binding');
  assert.equal(router.calls[0].context.versionToken, 'tok-b');
  selectionModel.clear();
  emit({kind: 'activate-item', key: 0}, surface); // same surface, activation kind
  await settle();
  assert.deepEqual(selectionModel.selectedSubject(), target, 'activate-item on the shared surface routes to the activation binding');
  emit({kind: 'edit-field', key: 0, text: 'from custom'}, surface); // same surface, edit kind
  await settle();
  assert.equal(router.calls.length, 2);
  assert.deepEqual(router.calls[1].context.field, {field: 'lbl'}, 'edit-field on the shared surface routes to the edit binding');
  await compositor.destroy();
});

test('(e) bind-time validation: duplicate viewIds per kind, the structural inspector fence, retired handle keys, a missing CommandRouter, malformed entries', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  await openCustomView(compositor);
  const {adapter} = intentSeam();
  const router = makeCapturingRouter();
  const ok = {viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver};
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [ok, {...ok}]}), /edit bindings must be unique per viewId/);
  assert.throws(() => shell.bindIntents({adapter, activationBindings: [{viewId: 'custom-view', resolveItem: () => null}, {viewId: 'custom-view', resolveItem: () => null}]}), /activation bindings must be unique per viewId/);
  // The inspector fence is STRUCTURAL: rejected whether or not `inspector: true` is set (and, in P6, whether or not the inspector is live).
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, inspector: true, editBindings: [{...ok, viewId: 'inspector-view'}]}), /bound through `inspector: true`/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, viewId: 'inspector-view'}]}), /bound through `inspector: true`/);
  assert.throws(() => shell.bindIntents({adapter, editBindings: [ok]}), /requires a CommandRouter/, 'an edit binding without a router can never work: loud at bind time');
  assert.throws(() => shell.bindIntents({adapter, inspector: true}), /requires a CommandRouter/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, resolveField: 'nope'}]}), /requires viewId and resolveField/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, tokenFor: 42}]}), /tokenFor must be a function/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: 'nope'}), /editBindings must be an array/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, commandId: undefined}]}), /must declare its commandId/, 'a binding cannot inherit the inspector default command');
  // RETIRED handle keys fail LOUDLY (a silently ignored key would silently swallow interactions).
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, surfaceHandle: 'h'}]}), /never a surfaceHandle/);
  assert.throws(() => shell.bindIntents({adapter, activationBindings: [{surfaceHandle: 'h', viewId: 'custom-view', resolveItem: () => null}]}), /never a surfaceHandle/);
  assert.throws(() => shell.bindIntents({adapter, navigatorSurfaceHandle: 'h'}), /`navigatorSurfaceHandle` was retired/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, inspectorSurfaceHandle: 'h'}), /`inspectorSurfaceHandle` was retired/);
  await assert.rejects(shell.handleEditField({key: 0, text: 'x', commandRouter: router, inspectorSurfaceHandle: 'h'}), /`inspectorSurfaceHandle` was retired/);
  await assert.rejects(shell.handleEditField({key: 0, text: 'x', commandRouter: router}), /requires the emitted surfaceHandle/);
  // Valid: one activation + one edit binding on the SAME view.
  const unsubscribe = shell.bindIntents({
    adapter, commandRouter: router,
    activationBindings: [{viewId: 'custom-view', resolveItem: () => null}],
    editBindings: [ok],
  });
  assert.equal(typeof unsubscribe, 'function');
  await compositor.destroy();
});


test('(g) a malformed resolver result (non-plain-data, string, array, class instance) or a throwing resolver/tokenFor is a LOUD error to onEditError, reported once, with NO dispatch and no inspector reread offered', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface} = await openCustomView(compositor, {labels: ['a', 'b', 'c', 'd', 'e', 'f']});
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  const errors = [];
  class Boxed { constructor() { this.v = 1; } }
  const results = [() => ({fn: () => 1}), () => 'a string', () => [1, 2], () => new Boxed(), () => { throw new Error('resolver boom'); }, () => ({})];
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{
      viewId: 'custom-view', commandId: 'custom-edit',
      resolveField: (d, key) => results[key](),
      tokenFor: (d) => { if (d.parameters.labels[0] === 'TOKEN-BOOM') throw new Error('token boom'); return null; },
      onEditError: (error, recovery) => { errors.push({message: error.message, recovery}); },
    }],
  });
  for (const key of [0, 1, 2, 3, 4]) emit({kind: 'edit-field', key, text: 'x'}, surface);
  await settle();
  assert.equal(router.calls.length, 0, 'no malformed/throwing resolution dispatches');
  assert.equal(errors.length, 5, 'each malformed/throwing resolution is reported exactly once');
  assert.match(errors[0].message, /data-representable/);
  for (const i of [1, 2, 3]) assert.match(errors[i].message, /null or a plain object/);
  assert.equal(errors[4].message, 'resolver boom');
  for (const e of errors) assert.deepEqual(e.recovery, {}, 'a foreign binding gets NO shell-side reread');
  // A throwing tokenFor is reported the same way, after a valid resolution.
  await compositor.presentOn('custom-view', {kind: 'custom', subject: {kind: 'ref', imageId: 'img', objectId: 'obj-root'}, parameters: {labels: ['TOKEN-BOOM', 'b', 'c', 'd', 'e', 'f']}});
  emit({kind: 'edit-field', key: 5, text: 'x'}, surface);
  await settle();
  assert.equal(router.calls.length, 0);
  assert.equal(errors.at(-1).message, 'token boom');
  await compositor.destroy();
});

test('a resolver cannot re-target the Command: a field context carrying commandId/text/versionToken stays nested and the shell\'s own keys win', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface} = await openCustomView(compositor);
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{viewId: 'custom-view', commandId: 'declared-command', resolveField: () => ({commandId: 'hijack', text: 'hijack', versionToken: 'hijack'})}],
  });
  emit({kind: 'edit-field', key: 0, text: 'real text'}, surface);
  await settle();
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].context.commandId, 'declared-command', 'the binding\'s declared commandId wins');
  assert.equal(router.calls[0].context.text, 'real text');
  assert.equal(router.calls[0].context.versionToken, null);
  assert.deepEqual(router.calls[0].context.field, {commandId: 'hijack', text: 'hijack', versionToken: 'hijack'}, 'the resolver payload is fenced under field');
  await compositor.destroy();
});

test('a foreign edit takes NO olm barrier and leaves the inspector alone: an inspector invalidation during a foreign in-flight edit rereads immediately (never deferred); the inspector descriptor/token are unchanged on success and failure', async () => {
  const records = {
    'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []},
    'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'},
  };
  const {shell, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  const inspectorBefore = compositor.durableIntent().find((v) => v.viewId === 'inspector-view').presentationDescriptor;
  const tokenBefore = shell._inspectorToken();
  const {surface} = await openCustomView(compositor);
  const {adapter, emit} = intentSeam();
  // A router whose dispatch blocks until released: the foreign edit stays in flight.
  let release;
  const gate = new Promise((r) => { release = r; });
  let mode = 'ok';
  const router = {calls: [], async consumeIntent(intent, opts) { this.calls.push({intent, opts}); await gate; if (mode === 'fail') throw new Error('foreign edit failed'); return {ok: true}; }};
  const errors = [];
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver, onEditError: (e, recovery) => errors.push({e, recovery})}],
  });
  // A controllable observation feed for the inspector follow.
  const pending = [];
  let wake = null;
  async function* observe() { for (;;) { if (pending.length) { yield pending.shift(); continue; } await new Promise((r) => { wake = r; }); } }
  const pushChange = (change) => { pending.push(change); if (wake) { const w = wake; wake = null; w(); } };
  const updates = [];
  const deferred = [];
  const follow = shell.followSelected({observe, imageId: 'img', onUpdate: (d) => updates.push(d), onDeferred: (c) => deferred.push(c)});
  emit({kind: 'edit-field', key: 0, text: 'x'}, surface); // foreign edit, now in flight (blocked on gate)
  await settle();
  assert.equal(router.calls.length, 1, 'the foreign edit is in flight');
  pushChange({objectId: 'obj-b', imageId: 'img'}); // inspector invalidation DURING the foreign edit
  await settle();
  assert.equal(deferred.length, 0, 'a foreign in-flight edit does NOT take the shell\'s olm barrier: nothing is deferred');
  assert.equal(updates.length, 1, 'the inspector reread ran immediately');
  release();
  await settle();
  const inspectorAfter = compositor.durableIntent().find((v) => v.viewId === 'inspector-view').presentationDescriptor;
  assert.deepEqual(inspectorAfter, inspectorBefore, 'the inspector descriptor is unchanged by the foreign edit');
  assert.deepEqual(shell._inspectorToken(), tokenBefore, 'the inspector token is unchanged by the foreign edit');
  // Failure path: still no barrier side effects, no inspector reread offered.
  mode = 'fail';
  emit({kind: 'edit-field', key: 0, text: 'y'}, surface);
  await settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].recovery, {}, 'no inspector reread is offered to a foreign binding');
  assert.deepEqual(shell._inspectorToken(), tokenBefore);
  follow.stop();
  await compositor.destroy();
});

test('an intent from a live view with NO edit binding of that kind is ignored: a binding for another view is never consulted', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface} = await openCustomView(compositor);
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  let resolverCalls = 0;
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{viewId: 'other-view', commandId: 'custom-edit', resolveField: () => { resolverCalls += 1; return {}; }}],
  });
  emit({kind: 'edit-field', key: 0, text: 'x'}, surface); // live surface realizing 'custom-view'; the only edit binding names 'other-view'
  await settle();
  assert.equal(router.calls.length, 0, 'no edit binding names the live view: nothing dispatches');
  assert.equal(resolverCalls, 0, 'another view\'s resolver is never consulted');
  await compositor.destroy();
});

// ---------------------------------------------------------------------------
// Bead 4o8 (+8ik): bindings name LOGICAL views; the Compositor is the sole
// authority mapping a transient surface handle to the live view.
// ---------------------------------------------------------------------------

const customPresentation = (labels, target) => ({
  kind: 'custom', subject: {kind: 'ref', imageId: 'img', objectId: 'obj-root'},
  parameters: {labels, target},
});
const VIEW = {kind: 'canvas', width: 64, height: 64};

test('P1/P2/P3/P7 reopen: a binding for logical view V survives close + re-open; H2 routes (both kinds) with the CURRENT descriptor and the emitted handle; stale H1 does nothing', async () => {
  const target1 = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const target2 = {kind: 'ref', imageId: 'other-image', objectId: 'obj-c'};
  const records = {'obj-root': {slots: {}, indexed: []}, 'obj-b': {slots: {}, indexed: []}, 'obj-c': {slots: {}, indexed: []}};
  const {shell, selectionModel, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  await compositor.openView({viewId: 'custom-view', viewDescriptor: VIEW, presentationDescriptor: customPresentation(['old-label'], target1)});
  const h1 = compositor.surfaceHandleForView('custom-view');
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  const seenByItem = [];
  const seenByField = [];
  shell.bindIntents({
    adapter, commandRouter: router,
    activationBindings: [{viewId: 'custom-view', resolveItem: (d, key) => { seenByItem.push(d); return key === 0 ? d.parameters.target : null; }}],
    editBindings: [{viewId: 'custom-view', commandId: 'custom-edit', resolveField: (d, key) => { seenByField.push(d); return labelResolver(d, key); }}],
  });
  // close + re-open the SAME logical view under a NEW realization, with a DIFFERENT presentation
  await compositor.closeView('custom-view');
  const current = customPresentation(['new-label'], target2);
  await compositor.openView({viewId: 'custom-view', viewDescriptor: VIEW, presentationDescriptor: current});
  const h2 = compositor.surfaceHandleForView('custom-view');
  assert.notEqual(h2, h1, 'precondition: the re-opened view has a new handle');
  // P1 (activation) + P3: routes with NO re-bind, and the resolver sees ONLY the current descriptor.
  emit({kind: 'activate-item', key: 0}, h2);
  await settle();
  assert.deepEqual(selectionModel.selectedSubject(), target2, 'an activation from the re-opened view routes without re-binding');
  assert.equal(seenByItem.length, 1);
  assert.equal(seenByItem[0], current, 'the resolver received the CURRENT (H2) descriptor object, not the one realized as H1');
  // P1 (edit) + P7: the edit routes, resolved over the H2 descriptor; consumeIntent receives H2 unchanged.
  emit({kind: 'edit-field', key: 0, text: 'x'}, h2);
  await settle();
  assert.equal(router.calls.length, 1, 'an edit from the re-opened view routes without re-binding');
  assert.equal(router.calls[0].surfaceHandle, h2, 'the EMITTED handle reaches the CommandRouter unchanged (subject ownership stays there)');
  assert.deepEqual(router.calls[0].context.field, {field: 'new-label'}, 'field resolution used the H2/current descriptor');
  assert.equal(seenByField[0], current);
  // P2: the stale handle does nothing, for either kind, and no resolver is consulted.
  selectionModel.clear();
  emit({kind: 'activate-item', key: 0}, h1);
  emit({kind: 'edit-field', key: 0, text: 'x'}, h1);
  await settle();
  assert.equal(selectionModel.selectedSubject(), null, 'a stale handle cannot activate');
  assert.equal(router.calls.length, 1, 'a stale handle cannot dispatch an edit');
  assert.equal(seenByItem.length, 1);
  assert.equal(seenByField.length, 1, 'no resolver is consulted for a stale handle');
  await compositor.destroy();
});

test('P4 lost view (8ik): a view lost at open, and a view lost AFTER being live, resolve NO activation — durable intent still describes them, the resolver is never consulted, the dead handle routes nowhere', async () => {
  const target = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const records = {'obj-root': {slots: {}, indexed: []}, 'obj-b': {slots: {}, indexed: []}};
  const {shell, selectionModel, compositor, rendererAdapter} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  let resolverCalls = 0;
  const resolveItem = () => { resolverCalls += 1; return target; }; // ignores its descriptor: a forcing function
  const {adapter, emit} = intentSeam();
  shell.bindIntents({adapter, activationBindings: [{viewId: 'lost-at-open', resolveItem}, {viewId: 'lost-later', resolveItem}]});
  // Arm 1: lost at open (attach fails) — the Compositor keeps a lost entry with the descriptor.
  rendererAdapter.failNext('attachPresentation');
  await assert.rejects(compositor.openView({viewId: 'lost-at-open', viewDescriptor: VIEW, presentationDescriptor: customPresentation(['l'], target)}));
  assert.equal(compositor.viewStatus('lost-at-open'), 'lost');
  assert.ok(compositor.durableIntent().some((v) => v.viewId === 'lost-at-open' && v.presentationDescriptor), 'durable intent still describes the lost view');
  assert.equal(await shell.handleActivateItem({viewId: 'lost-at-open', key: 0, resolveItem}), null, 'a lost view is not live: no activation');
  // Arm 2: lost AFTER being live — a previously VALID handle is now dead; the old descriptor is retained.
  await compositor.openView({viewId: 'lost-later', viewDescriptor: VIEW, presentationDescriptor: customPresentation(['m'], target)});
  const wasLive = compositor.surfaceHandleForView('lost-later');
  rendererAdapter.failNext('detachPresentation');
  await assert.rejects(compositor.presentOn('lost-later', customPresentation(['m2'], target)));
  assert.equal(compositor.viewStatus('lost-later'), 'lost');
  assert.ok(compositor.durableIntent().some((v) => v.viewId === 'lost-later' && v.presentationDescriptor.parameters.labels[0] === 'm'), 'the lost view keeps its last good descriptor in durable intent');
  assert.equal(await shell.handleActivateItem({viewId: 'lost-later', key: 0, resolveItem}), null);
  emit({kind: 'activate-item', key: 0}, wasLive); // the once-valid, now-dead handle
  await settle();
  assert.equal(selectionModel.selectedSubject(), null, 'a dead handle routes nowhere');
  assert.equal(resolverCalls, 0, 'the resolver is never consulted for a lost or dead view');
  await compositor.destroy();
});

test('P5 binding identity + activation fence: activation and edit are unique per viewId within their kind; both on one view is legal; public activation bindings for the navigator and the inspector are legal (activation carries no shell-internal state)', async () => {
  const target = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const records = {'obj-root': {slots: {'slot-b': ref('obj-b')}, indexed: []}, 'obj-b': {slots: {'probe-title': {kind: 'text', value: 'B'}}, indexed: [], versionToken: 'tok-b'}};
  const {shell, selectionModel, compositor} = makeShell({records, writableSlots: ['probe-title']});
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  // A public activation binding for the NAVIGATOR view without `navigator: true` REPLACES the default resolver…
  const custom = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const unsub = shell.bindIntents({adapter, activationBindings: [{viewId: 'navigator-view', resolveItem: () => custom}]});
  emit({kind: 'activate-item', key: 7}, compositor.surfaceHandleForView('navigator-view'));
  await settle();
  assert.deepEqual(selectionModel.selectedSubject(), custom, 'the public navigator resolver was used (key 7 would be out of range for the default)');
  unsub();
  // …and a public activation binding for the INSPECTOR view binds and routes (the inspector renders ref rows too).
  shell.bindIntents({adapter, commandRouter: router, inspector: true, activationBindings: [{viewId: 'inspector-view', resolveItem: (d, key) => key === 0 ? target : null}]});
  selectionModel.clear();
  emit({kind: 'activate-item', key: 0}, compositor.surfaceHandleForView('inspector-view'));
  await settle();
  assert.deepEqual(selectionModel.selectedSubject(), target, 'a public inspector activation binding routes');
  await compositor.destroy();
});

test('P6 inspector capture: a public edit binding for inspector-view is rejected while the inspector is live, after it is closed (absent) and while it is lost — the fence is structural, not tied to a handle', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor, rendererAdapter} = makeShell({records});
  const {adapter} = intentSeam();
  const router = makeCapturingRouter();
  const foreign = {viewId: 'inspector-view', commandId: 'hijack', resolveField: () => ({}), tokenFor: () => 'foreign-token'};
  // absent (workspace not open yet)
  assert.equal(compositor.liveView('inspector-view'), null);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [foreign]}), /bound through `inspector: true`/);
  await shell.openWorkspace(ref('obj-root'), {});
  // live
  assert.ok(compositor.liveView('inspector-view'));
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [foreign]}), /bound through `inspector: true`/);
  // lost
  rendererAdapter.failNext('detachPresentation');
  await assert.rejects(compositor.presentOn('inspector-view', {kind: 'inspector', subject: {kind: 'ref', imageId: 'img', objectId: 'obj-root'}, parameters: {}}));
  assert.equal(compositor.viewStatus('inspector-view'), 'lost');
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [foreign]}), /bound through `inspector: true`/);
  // closed/absent again
  await compositor.closeView('inspector-view');
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [foreign]}), /bound through `inspector: true`/);
  await compositor.destroy();
});

test('P8a bind-before-open: bindings made while the logical view does not exist route once it is opened (no handle can have been captured); P8 durable intent stays handle-free', async () => {
  const target = {kind: 'ref', imageId: 'other-image', objectId: 'obj-b'};
  const records = {'obj-root': {slots: {}, indexed: []}, 'obj-b': {slots: {}, indexed: []}};
  const {shell, selectionModel, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  assert.equal(compositor.liveView('later-view'), null, 'precondition: the view does not exist at bind time');
  shell.bindIntents({
    adapter, commandRouter: router,
    activationBindings: [{viewId: 'later-view', resolveItem: (d, key) => key === 0 ? d.parameters.target : null}],
    editBindings: [{viewId: 'later-view', commandId: 'later-edit', resolveField: labelResolver}],
  });
  await compositor.openView({viewId: 'later-view', viewDescriptor: VIEW, presentationDescriptor: customPresentation(['lbl'], target)});
  const h = compositor.surfaceHandleForView('later-view');
  emit({kind: 'activate-item', key: 0}, h);
  emit({kind: 'edit-field', key: 0, text: 'x'}, h);
  await settle();
  assert.deepEqual(selectionModel.selectedSubject(), target, 'activation routed to a view opened AFTER binding');
  assert.equal(router.calls.length, 1, 'edit routed to a view opened AFTER binding');
  assert.equal(router.calls[0].surfaceHandle, h);
  for (const v of compositor.durableIntent()) {
    assert.deepEqual(Object.keys(v).sort(), ['presentationDescriptor', 'viewDescriptor', 'viewId'], 'durable intent carries no handle');
  }
  await compositor.destroy();
});

test('P8c structural guard: the shell never consults the Compositor\'s durable intent for interaction', async () => {
  const {readFileSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('../src/environment-shell.js', import.meta.url)), 'utf8');
  assert.ok(!source.includes('durableIntent('), 'src/environment-shell.js must not call durableIntent( — durable intent lists lost views by design and is never evidence of a live realization');
  assert.ok(!/viewStatus\([^)]*\)\s*===\s*'live'/.test(source), 'the shell must not re-decide liveness via viewStatus(...) === \'live\'');
});
