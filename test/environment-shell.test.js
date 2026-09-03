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
  // The inspector surface must be the LIVE handle the Compositor gave that view:
  // the shell resolves the bound view by surface (the same source the
  // CommandRouter uses for the subject), so a made-up handle is a no-op.
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  shell.bindIntents({
    adapter, navigatorSurfaceHandle: 'nav-surface', inspectorSurfaceHandle: inspSurface,
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
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const result = await shell.handleEditField({
    key: 0, text: 'B-edited', commandRouter: router, inspectorSurfaceHandle: inspSurface,
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
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  await shell.openWorkspace(ref('obj-root'), {});
  await shell.selectObject(ref('obj-b'), {});
  const router = makeCapturingRouter();
  // key 1 would name probe-count (read-only) if the shell miscounted writable
  // fields; key 99 is out of range. Both are no-ops with NO dispatch.
  assert.equal(await shell.handleEditField({key: 1, text: 'x', commandRouter: router, inspectorSurfaceHandle: inspSurface}), null);
  assert.equal(await shell.handleEditField({key: 99, text: 'x', commandRouter: router, inspectorSurfaceHandle: inspSurface}), null);
  // A handle that resolves to NO live view is an explicit no-op too (the view is
  // gone or never was this shell's inspector), never a dispatch against another view.
  assert.equal(await shell.handleEditField({key: 0, text: 'x', commandRouter: router, inspectorSurfaceHandle: 'not-a-live-surface'}), null);
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
// Bead 6lm: generic EDIT BINDINGS (the shell's row 64 generalized). Everything
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
      surfaceHandle: surface, viewId: 'custom-view',
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
    editBindings: [{surfaceHandle: surface, viewId: 'custom-view', commandId: 'custom-edit', resolveField: (d, key) => key === 1 ? {} : null}],
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

test('(c),(d),(h) routing by (kind, surface): unbound surface ignored; inspector still routes to its own binding; an activation binding and an edit binding share one surface', async () => {
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
    adapter, commandRouter: router, inspectorSurfaceHandle: inspSurface,
    activationBindings: [{surfaceHandle: surface, viewId: 'custom-view', resolveItem: (d, key) => key === 0 ? target : null}],
    editBindings: [{surfaceHandle: surface, viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver}],
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

test('(e) bind-time validation: duplicate edit surface, an edit binding on the inspector surface, edit bindings without a CommandRouter, malformed entries', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface} = await openCustomView(compositor);
  const inspSurface = compositor.surfaceHandleForView('inspector-view');
  const {adapter} = intentSeam();
  const router = makeCapturingRouter();
  const ok = {surfaceHandle: surface, viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver};
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [ok, {...ok}]}), /edit surfaceHandle bindings must be unique/);
  // A public binding on the inspector's SURFACE (under any other viewId) collides
  // with the inspector binding when inspectorSurfaceHandle is set.
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, inspectorSurfaceHandle: inspSurface, editBindings: [{...ok, surfaceHandle: inspSurface}]}), /must be unique/, 'the inspector surface is taken by inspectorSurfaceHandle');
  assert.throws(() => shell.bindIntents({adapter, editBindings: [ok]}), /requires a CommandRouter/, 'an edit binding without a router can never work: loud at bind time');
  assert.throws(() => shell.bindIntents({adapter, inspectorSurfaceHandle: inspSurface}), /requires a CommandRouter/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, resolveField: 'nope'}]}), /requires surfaceHandle, viewId and resolveField/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, tokenFor: 42}]}), /tokenFor must be a function/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: 'nope'}), /editBindings must be an array/);
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, commandId: undefined}]}), /must declare its commandId/, 'a binding cannot inherit the inspector default command');
  // The inspector view is bound ONLY through inspectorSurfaceHandle: a public edit
  // binding on it (even when the inspector is otherwise unbound) would drive the
  // shell's own inspector with a foreign token and no barrier.
  assert.throws(() => shell.bindIntents({adapter, commandRouter: router, editBindings: [{...ok, surfaceHandle: inspSurface, viewId: 'inspector-view'}]}), /bound through inspectorSurfaceHandle/);
  // Valid: the same surface in an ACTIVATION binding and an EDIT binding is fine.
  const unsubscribe = shell.bindIntents({
    adapter, commandRouter: router,
    activationBindings: [{surfaceHandle: surface, viewId: 'custom-view', resolveItem: () => null}],
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
      surfaceHandle: surface, viewId: 'custom-view', commandId: 'custom-edit',
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
    editBindings: [{surfaceHandle: surface, viewId: 'custom-view', commandId: 'declared-command', resolveField: () => ({commandId: 'hijack', text: 'hijack', versionToken: 'hijack'})}],
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
    editBindings: [{surfaceHandle: surface, viewId: 'custom-view', commandId: 'custom-edit', resolveField: labelResolver, onEditError: (e, recovery) => errors.push({e, recovery})}],
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

test('the binding viewId is an ASSERTION: a live surface whose view is not the declared one is an explicit no-op and the resolver is never consulted', async () => {
  const records = {'obj-root': {slots: {}, indexed: []}};
  const {shell, compositor} = makeShell({records});
  await shell.openWorkspace(ref('obj-root'), {});
  const {surface} = await openCustomView(compositor);
  const {adapter, emit} = intentSeam();
  const router = makeCapturingRouter();
  let resolverCalls = 0;
  shell.bindIntents({
    adapter, commandRouter: router,
    editBindings: [{surfaceHandle: surface, viewId: 'other-view', commandId: 'custom-edit', resolveField: () => { resolverCalls += 1; return {}; }}],
  });
  emit({kind: 'edit-field', key: 0, text: 'x'}, surface); // live surface, but it realizes 'custom-view', not 'other-view'
  await settle();
  assert.equal(router.calls.length, 0, 'a viewId mismatch never dispatches (descriptor and subject could belong to different views)');
  assert.equal(resolverCalls, 0, 'the resolver is not even consulted on a mismatch');
  await compositor.destroy();
});
