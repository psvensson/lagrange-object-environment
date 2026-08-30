import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createImageClientAdapter, classIdFor} from '../src/image-client-adapter.js';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createSelectionModel} from '../src/selection-model.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createObjectNavigator} from '../src/object-navigator.js';
import {createCommandRouter} from '../src/command-router.js';
import {Command} from '../src/model.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {
  createObjectInspectorProvider,
  createUnavailableRefProvider,
  createUnauthorizedRefProvider,
} from '../src/object-presentation-providers.js';

// The EnvironmentShell INTEGRATION proof (Bead cny slice 1): the full
// selection -> inspector -> live-reread loop against a REAL image, a REAL
// ObjectNavigator, and the AUTHORIZED observation lane, under RESTRICTED
// authority. Proves the inspector updates from image state (no shadow model).

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(HERE, '../../lagrange-images/src/runtime.js');
const RUNTIME_URL = process.env.LAGRANGE_IMAGES_URL ?? pathToFileURL(DEFAULT_RUNTIME).href;
let imagesApi = null;
let available = false;
try {
  imagesApi = await import(RUNTIME_URL);
  available = true;
} catch {
  available = false;
}

const IMAGE = 'shell-e2e-image';
const IDS = Object.freeze({
  className: 'Probe', shapeId: 'probe-shape', classId: 'probe-class',
  interfaceId: 'probe-interface', bindingId: 'probe-binding', blockId: 'probe-block',
  mutationInterfaceId: 'probe-mutate-interface', mutationBindingId: 'probe-mutate-binding', mutationBlockId: 'probe-mutate-block',
  readInterfaceId: 'object-read-interface', readBindingId: 'object-read-binding', readBlockId: 'object-read-block',
  observationInterfaceId: 'observation-interface', observationBindingId: 'observation-binding', observationBlockId: 'observation-block',
});

test('EnvironmentShell end-to-end: select ref -> inspector; external mutation -> authorized observation -> reread -> inspector updates; restricted authority', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});
  const adapter = createImageClientAdapter({
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    defineClass: imagesApi.defineClass,
    installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    installImageMutationBinding: imagesApi.installImageMutationBinding,
    installImageObjectReadBinding: imagesApi.installImageObjectReadBinding,
    installImageObservationBinding: imagesApi.installImageObservationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    unpackCompositeValue: imagesApi.unpackCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });
  await adapter.ensureSchema(IMAGE, IDS);

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor});

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
  const readAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/read', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });

  // Two durable objects: A references B.
  const createdB = await adapter.createObject({
    imageId: IMAGE, classId, title: 'B-original', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId,
  });
  const createdA = await adapter.createObject({
    imageId: IMAGE, classId, title: 'A', subject: ref(createdB.objectId), authority: createAuthority(createdB.objectId), blockId: IDS.blockId,
  });

  // --- open the workspace on root A; the navigator pane carries A's refs ----
  await shell.openWorkspace(ref(createdA.objectId), {authority: readAuthority(createdA.objectId), readBlockId: IDS.readBlockId});
  const nav = compositor.durableIntent().find((v) => v.viewId === 'navigator-view');
  assert.equal(nav.presentationDescriptor.kind, 'navigator');
  assert.ok(nav.presentationDescriptor.parameters.references.map((r) => r.objectId).includes(createdB.objectId), 'navigator pane carries the ref to B');

  // --- select B: selection drives the inspector via a descriptor ------------
  const descriptor = await shell.selectObject(ref(createdB.objectId), {authority: readAuthority(createdB.objectId), readBlockId: IDS.readBlockId});
  assert.equal(descriptor.subject.objectId, createdB.objectId);
  assert.equal(descriptor.parameters.fields['probe-title'].value, 'B-original');
  assert.equal(compositor.focusedView(), 'navigator-view');

  // --- follow B: mutate it EXTERNALLY -> authorized observation -> reread ---
  const updates = [];
  const follow = shell.followSelected({
    observe: (imageId, opts) => adapter.observe(imageId, opts),
    imageId: IMAGE,
    authority: readAuthority(createdB.objectId),
    observationBlockId: IDS.observationBlockId,
    readBlockId: IDS.readBlockId,
    onUpdate: (d) => updates.push(d),
  });
  await new Promise((r) => setTimeout(r, 50)); // let the lane anchor live-follow

  // Mutate B to a value the UI never displayed, through a REAL authorized command.
  await adapter.mutateObject({
    imageId: IMAGE, objectId: createdB.objectId,
    value: {title: 'B-EXTERNAL-EDIT'},
    authority: runtime.authority.issue({
      principal: 'alice',
      grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, createdB.objectId)}],
    }),
    blockId: IDS.mutationBlockId,
  });

  // Wait for the observation -> reread -> presentOn to land.
  await assertEventually(async () => {
    const insp = compositor.durableIntent().find((v) => v.viewId === 'inspector-view');
    assert.equal(insp.presentationDescriptor.parameters.fields['probe-title'].value, 'B-EXTERNAL-EDIT',
      'the inspector reflects the externally-mutated state (fresh authorized reread, not a shadow cache)');
  }, 3000);
  assert.ok(updates.length >= 1, 'the observation->reread path fired at least once');
  assert.equal(updates[updates.length - 1].subject.objectId, createdB.objectId, 'same B identity');

  // The inspector update traveled as a DESCRIPTOR via presentOn.
  const attaches = rendererAdapter.calls().filter((c) => c.method === 'attachPresentation');
  assert.equal(attaches[attaches.length - 1].detail.presentationDescriptor.parameters.fields['probe-title'].value, 'B-EXTERNAL-EDIT');

  follow.stop();
  await compositor.destroy();
});

// S4a: the edit-field path against a REAL image — the shell resolves key->slot
// and attaches the transient token, then routes through the REAL CommandRouter ->
// CommandRegistry -> CommandDispatcher -> ImageClientAdapter mutation lane. The
// happy path mutates; a STALE token conflicts. The six-op contract is untouched.
test('S4a: edit-field routes through CommandRouter to a REAL mutation; a stale transient token conflicts', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});
  const adapter = createImageClientAdapter({
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    defineClass: imagesApi.defineClass,
    installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    installImageMutationBinding: imagesApi.installImageMutationBinding,
    installImageObjectReadBinding: imagesApi.installImageObjectReadBinding,
    installImageObservationBinding: imagesApi.installImageObservationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    unpackCompositeValue: imagesApi.unpackCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });
  await adapter.ensureSchema(IMAGE, IDS);

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  // The REAL registered edit Command (NOT built by the shell): it owns the
  // canonical text mutation and forwards the opaque versionToken the shell
  // attached to the dispatch context.
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, text, versionToken}) => a.mutateObject({
      imageId: subject.imageId, objectId: subject.objectId,
      value: {title: text}, authority, blockId: IDS.mutationBlockId, versionToken,
    }),
  }));
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  // The shell gets the writable-slot set from the adapter (the single owner).
  const shell = createEnvironmentShell({navigator, selectionModel, compositor, writableSlots: adapter.writableSlots});

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
  const readAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/read', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const writeAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });
  // Root A references B (the acceptance flow's "browse root -> activate
  // reference"); B is the object we inspect and edit.
  const created = await adapter.createObject({
    imageId: IMAGE, classId, title: 'original', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId,
  });
  const root = await adapter.createObject({
    imageId: IMAGE, classId, title: 'root', subject: ref(created.objectId), authority: createAuthority(created.objectId), blockId: IDS.blockId,
  });

  // The REAL CommandRouter: subject from the Compositor view, authority fresh
  // per dispatch, dispatch through the adapter's authorized seam.
  const commandRouter = createCommandRouter({
    compositor,
    commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async ({subject}) => writeAuthority(subject.objectId),
  });

  // Browse the root, then ACTIVATE the reference to B (selection -> inspector),
  // the acceptance flow's "activate reference -> inspector follows selection".
  await shell.openWorkspace(ref(root.objectId), {authority: readAuthority(root.objectId), readBlockId: IDS.readBlockId});
  await shell.selectObject(ref(created.objectId), {authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId});
  // The inspector pane is the LAST attachPresentation. Its surface handle is
  // what CommandRouter resolves the subject from.
  const attaches = rendererAdapter.calls().filter((c) => c.method === 'attachPresentation');
  const inspHandle = attaches[attaches.length - 1]?.detail?.surfaceHandle;

  const readTitle = async () => (await adapter.readObject({
    imageId: IMAGE, objectId: created.objectId, authority: readAuthority(created.objectId), blockId: IDS.readBlockId,
  }))?.slots?.['probe-title']?.value;

  // --- HAPPY PATH: edit field key 0 (probe-title) -> real mutation -----------
  const happy = await shell.handleEditField({
    key: 0, text: 'edited-via-shell', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
  });
  assert.ok(happy, 'the edit dispatched through CommandRouter');
  assert.equal(await readTitle(), 'edited-via-shell', 'the image reflects the edit (real authorized mutation)');
  assert.equal(shell._inspectorToken().token, created.versionToken, 'the displayed token is still the pre-edit one (updated only on reread)');

  // --- STALE TOKEN: an external write advances the version; the shell's held
  // token is now stale; replaying the edit surfaces a conflict. -------------
  await adapter.mutateObject({
    imageId: IMAGE, objectId: created.objectId, value: {title: 'external-advance'},
    authority: writeAuthority(created.objectId), blockId: IDS.mutationBlockId,
  });
  let conflict = null;
  let conflictReread = null;
  await shell.handleEditField({
    key: 0, text: 'stale-edit', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
    onEditError: async (error, {reread}) => {
      conflict = error;
      // NO dead-end: recover via a fresh authorized reread (updates the transient
      // token + shows the current value), so the user can retry.
      conflictReread = await reread();
    },
  });
  assert.ok(conflict, 'a stale token surfaced an error');
  assert.equal(conflict.name, 'CommandConflictError', 'a stale transient token -> CommandConflictError (optimistic concurrency)');
  assert.equal(await readTitle(), 'external-advance', 'the stale edit did NOT overwrite the external write');
  // The recovery reread refreshed the inspector to the image's CURRENT value and
  // updated the transient token (no longer the stale one).
  assert.equal(conflictReread.parameters.fields['probe-title'].value, 'external-advance',
    'the conflict recovery reread shows the current image value (not the stale edit, not a dead-end)');
  const tokenAfterConflict = shell._inspectorToken().token;
  assert.ok(tokenAfterConflict && tokenAfterConflict !== created.versionToken,
    'the transient token was refreshed by the recovery reread (not the stale token)');

  // The user can now retry the edit successfully with the fresh token.
  const retry = await shell.handleEditField({
    key: 0, text: 'retry-after-conflict', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
  });
  assert.ok(retry, 'the retry after conflict-recovery dispatched');
  assert.equal(await readTitle(), 'retry-after-conflict', 'the retry succeeded with the refreshed token (the user could continue)');

  // --- DENIED WRITE: distinct from an unauthorized READ; no mutation; no dead-end.
  const deniedRouter = createCommandRouter({
    compositor, commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async () => runtime.authority.issue({principal: 'mallory', grants: []}), // NO write grant
  });
  let denied = null;
  let deniedReread = null;
  await shell.handleEditField({
    key: 0, text: 'denied-edit', commandId: 'set-title',
    commandRouter: deniedRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
    onEditError: async (error, {reread}) => {
      denied = error;
      deniedReread = await reread();
    },
  });
  assert.ok(denied, 'a denied write surfaced an error');
  assert.equal(denied.name, 'CommandAuthorizationError',
    'a denied WRITE is a CommandAuthorizationError (DISTINCT from an unauthorized-READ presentation)');
  assert.equal(await readTitle(), 'retry-after-conflict', 'a denied write mutated nothing');
  assert.equal(deniedReread.parameters.fields['probe-title'].value, 'retry-after-conflict',
    'the denied-write recovery reread keeps the current value visible (no dead-end)');
  assert.equal(deniedReread.kind, 'inspector',
    'the denied WRITE leaves an INSPECTOR presentation (the read still succeeds), NOT an unauthorized-reference — a denied write is distinct from a denied read');

  // --- C1 FALSIFIER: the versionToken NEVER appears in any serialized sink ---
  // After the full flow (open -> select -> edit -> conflict -> retry -> denied),
  // walk the Compositor's durableIntent and every presentationDescriptor's
  // parameters and assert the token string is ABSENT — so it cannot reach the
  // SemanticUi description, a Perspective persistence, or the renderer boundary.
  const tokenStrings = [created.versionToken, shell._inspectorToken().token].filter(Boolean);
  assert.ok(tokenStrings.length > 0, 'the test holds at least one real token to check for leaks');
  const serializedSinks = [
    JSON.stringify(compositor.durableIntent()),
    ...compositor.durableIntent().map((v) => JSON.stringify(v.presentationDescriptor?.parameters ?? {})),
    JSON.stringify(conflictReread.parameters),
    JSON.stringify(deniedReread.parameters),
  ];
  for (const sink of serializedSinks) {
    for (const token of tokenStrings) {
      assert.ok(!sink.includes(token), `the versionToken must NEVER appear in a serialized sink (durableIntent / presentationDescriptor); found in: ${sink.slice(0, 80)}...`);
    }
  }

  await compositor.destroy();
});

// olm REGRESSION (deterministic, no busy-poll timing reliance): with follow
// ACTIVE across an edit, the follow's observation of the edit's OWN committed
// write must be DEFERRED (not dropped, not raced) until the edit settles, then
// run as the follow's reread — pairing the token to the current version so an
// IMMEDIATE second edit succeeds. The race window is opened EXACTLY by a HELD
// Command (the real mutation commits, then the Command holds before returning,
// so the self-observation arrives while the edit is still in flight). The
// onDeferred seam lets the test SYNCHRONIZE on the deferral (not a wall-clock
// wait that could pass vacuously). The OPPOSITE case (a genuinely external
// concurrent write) must STILL conflict — the barrier must NOT turn optimistic
// concurrency into last-writer-wins.
test('olm: edit-during-active-follow defers the self-observation reread; a second edit succeeds; an external write still conflicts', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});
  const adapter = createImageClientAdapter({
    images: runtime.images, invocations: runtime.invocations, executor: runtime.executor,
    defineClass: imagesApi.defineClass, installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    installImageMutationBinding: imagesApi.installImageMutationBinding,
    installImageObjectReadBinding: imagesApi.installImageObjectReadBinding,
    installImageObservationBinding: imagesApi.installImageObservationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel, objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource, parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken, textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue, unpackCompositeValue: imagesApi.unpackCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });
  await adapter.ensureSchema(IMAGE, IDS);

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  // A HELD set-title Command: performs the REAL mutation, then waits on a
  // test-controlled gate before returning — so the edit stays in flight (the
  // dispatch unsettled) while the self-observation of the committed write
  // arrives. `gates` maps text -> {promise, release}.
  const gates = new Map();
  commandRegistry.register(new Command({
    id: 'set-title', title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, text, versionToken}) => {
      const result = await a.mutateObject({
        imageId: subject.imageId, objectId: subject.objectId,
        value: {title: text}, authority, blockId: IDS.mutationBlockId, versionToken,
      });
      const gate = gates.get(text);
      if (gate) await gate.promise; // hold AFTER the commit, BEFORE returning
      return result;
    },
  }));
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor, writableSlots: adapter.writableSlots});

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
  const readAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/read', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const writeAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });
  const created = await adapter.createObject({
    imageId: IMAGE, classId, title: 'original', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId,
  });
  const root = await adapter.createObject({
    imageId: IMAGE, classId, title: 'root', subject: ref(created.objectId), authority: createAuthority(created.objectId), blockId: IDS.blockId,
  });
  const commandRouter = createCommandRouter({
    compositor, commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async ({subject}) => writeAuthority(subject.objectId),
  });
  await shell.openWorkspace(ref(root.objectId), {authority: readAuthority(root.objectId), readBlockId: IDS.readBlockId});
  await shell.selectObject(ref(created.objectId), {authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId});
  const attaches = rendererAdapter.calls().filter((c) => c.method === 'attachPresentation');
  const inspHandle = attaches[attaches.length - 1]?.detail?.surfaceHandle;
  const readTitle = async () => (await adapter.readObject({
    imageId: IMAGE, objectId: created.objectId, authority: readAuthority(created.objectId), blockId: IDS.readBlockId,
  }))?.slots?.['probe-title']?.value;
  const inspectorValue = () => compositor.durableIntent().find((v) => v.viewId === 'inspector-view')
    ?.presentationDescriptor?.parameters?.fields?.['probe-title']?.value;
  // Spy on inspector presents: the STRONG barrier falsifier. Under the RACE
  // (an immediate in-flight reread), the follow would presentOn the inspector
  // DURING the held edit; under DEFERRAL it must NOT. Counting attachPresentation
  // CALLS on the inspector surface (not just the resulting value) catches a racy
  // reread that happens to land on the stale pre-commit value — which a
  // value-only assertion would miss. The Compositor is frozen, so count via the
  // fake rendererAdapter's recorded calls (presentOn -> attachPresentation).
  const inspectorPresentCount = () => rendererAdapter.calls()
    .filter((c) => c.method === 'attachPresentation' && c.detail?.surfaceHandle === inspHandle).length;

  // The pre-edit transient token (paired by the selectObject reread).
  const tokenBeforeEdit = shell._inspectorToken().token;
  assert.ok(tokenBeforeEdit, 'a token is paired after navigation');

  // follow ACTIVE, with the onDeferred seam so the test SYNCHRONIZES on the
  // deferral (deterministic — not a wall-clock wait).
  let resolveDeferred;
  const deferredSeen = new Promise((r) => { resolveDeferred = r; });
  const follow = shell.followSelected({
    observe: (imageId, opts) => adapter.observe(imageId, opts),
    imageId: IMAGE,
    authority: readAuthority(created.objectId),
    observationBlockId: IDS.observationBlockId,
    readBlockId: IDS.readBlockId,
    onDeferred: () => resolveDeferred(),
  });
  await new Promise((r) => setTimeout(r, 50)); // let the lane anchor live-follow

  // --- THE RACE WINDOW: an edit whose Command holds AFTER the commit ---------
  let releaseGate;
  gates.set('edit-one', {promise: new Promise((r) => { releaseGate = r; })});
  const editOne = shell.handleEditField({
    key: 0, text: 'edit-one', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
  });
  // Wait until the Command has committed (the gate is now awaited) AND the
  // follow loop has observed-and-DEFERRED the self-invalidation. onDeferred
  // fires only when an invalidation arrives while the edit is in flight — so
  // awaiting it PROVES the deferral happened (not that it never observed).
  await deferredSeen;
  // While the edit is STILL in flight (gate held), the follow must NOT have
  // re-presented the inspector AT ALL. This is the STRONG barrier falsifier: it
  // counts presentOn CALLS, so a racy reread that lands on the stale pre-commit
  // value (which a value-only check would miss) is still caught. The count is
  // taken AFTER deferredSeen (the self-observation was already seen+deferred),
  // so any in-flight present would be a barrier violation.
  const presentsDuringEdit = inspectorPresentCount();
  // Let the busy-poll run a few turns while the gate is still held; if the
  // barrier raced, the deferred self-observation would drive a presentOn here.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(inspectorPresentCount(), presentsDuringEdit,
    'NO inspector presentOn may fire while the edit is in flight (the self-observation is DEFERRED, not raced)');
  assert.equal(shell._inspectorToken().token, tokenBeforeEdit,
    'the follow did NOT re-pair the token while the edit was in flight (deferred, not raced)');
  // Release the held Command: the edit settles; the deferred observation drains
  // as the follow's reread -> fresh authorized reread -> presentOn.
  releaseGate();
  await editOne;
  assert.equal(await readTitle(), 'edit-one', 'the committed write landed in the image');
  // The deferred reread updates the inspector to the committed value and pairs
  // the token to the CURRENT version (N+1). assertEventually absorbs the lane.
  await assertEventually(async () => {
    assert.equal(inspectorValue(), 'edit-one', 'the deferred reread presented the committed value');
    const tok = shell._inspectorToken().token;
    assert.ok(tok && tok !== tokenBeforeEdit, 'the token advanced to the post-edit version');
  }, 3000);

  // --- THE STRONG FALSIFIER: an IMMEDIATE second edit succeeds with the fresh
  // token. If the barrier merely HID the race (token still N), this conflicts.
  const tokenAfterOne = shell._inspectorToken().token;
  await shell.handleEditField({
    key: 0, text: 'edit-two', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
  });
  await assertEventually(async () => {
    assert.equal(inspectorValue(), 'edit-two', 'the second edit committed and was presented');
  }, 3000);
  assert.equal(await readTitle(), 'edit-two', 'the immediate second edit succeeded with the fresh token (the race is GONE, not hidden)');
  assert.notEqual(shell._inspectorToken().token, tokenAfterOne, 'the second edit advanced the token again');

  // --- OPPOSITE CASE: a genuinely external concurrent write STILL conflicts --
  // (the barrier must NOT become last-writer-wins). An external write advances
  // the version; the shell's held token is now stale; the edit conflicts.
  await adapter.mutateObject({
    imageId: IMAGE, objectId: created.objectId, value: {title: 'external-clobber'},
    authority: writeAuthority(created.objectId), blockId: IDS.mutationBlockId,
  });
  let conflict = null;
  let conflictReread = null;
  await shell.handleEditField({
    key: 0, text: 'should-not-land', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
    onEditError: async (error, {reread}) => { conflict = error; conflictReread = await reread(); },
  });
  assert.ok(conflict, 'an external concurrent write still surfaced an error');
  assert.equal(conflict.name, 'CommandConflictError', 'a stale token still conflicts (optimistic concurrency preserved, NOT last-writer-wins)');
  assert.equal(await readTitle(), 'external-clobber', 'the stale edit did NOT overwrite the external write');
  assert.equal(conflictReread.parameters.fields['probe-title'].value, 'external-clobber',
    'the conflict recovery reread shows the current value (the inspector stays usable)');

  // --- SUBJECT-CHANGE-DURING-DEFER: navigate away while an edit is held; the
  // drain must NOT re-present/re-pair the OLD subject with the edit's stale
  // context (it must be cancelled — selectObject already reread the new subject).
  // Select B again first so the held edit + defer target B.
  await shell.selectObject(ref(created.objectId), {authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId});
  let resolveDeferred2;
  const deferredSeen2 = new Promise((r) => { resolveDeferred2 = r; });
  follow.stop();
  const follow2 = shell.followSelected({
    observe: (imageId, opts) => adapter.observe(imageId, opts),
    imageId: IMAGE,
    authority: readAuthority(created.objectId),
    observationBlockId: IDS.observationBlockId,
    readBlockId: IDS.readBlockId,
    onDeferred: () => resolveDeferred2(),
  });
  await new Promise((r) => setTimeout(r, 50));
  let releaseGate2;
  gates.set('edit-three', {promise: new Promise((r) => { releaseGate2 = r; })});
  const editThree = shell.handleEditField({
    key: 0, text: 'edit-three', commandId: 'set-title',
    commandRouter, inspectorSurfaceHandle: inspHandle,
    authority: readAuthority(created.objectId), readBlockId: IDS.readBlockId,
  });
  await deferredSeen2; // B's self-observation was seen + deferred (edit in flight)
  // Navigate AWAY to the root while the edit is held. selectObject bypasses the
  // lane and rereads the NEW subject immediately, pairing its token.
  await shell.selectObject(ref(root.objectId), {authority: readAuthority(root.objectId), readBlockId: IDS.readBlockId});
  const presentsAfterNav = inspectorPresentCount();
  releaseGate2();
  await editThree;
  // The drain must SKIP its reread (the subject moved on): NO further inspector
  // presentOn after the navigation's own. Without the in-closure guard, the
  // enqueued drain would fire a redundant reread/present here.
  await new Promise((r) => setTimeout(r, 150)); // let any (bad) drain present land
  assert.equal(inspectorPresentCount(), presentsAfterNav,
    'the drain must SKIP its reread after a subject change (no redundant inspector presentOn)');
  assert.equal(shell._inspectorToken().objectId, root.objectId,
    'the token subject remains the root (the deferred B-observation was moot)');
  assert.equal(await readTitle(), 'edit-three', 'the held edit still committed to B in the image');

  follow2.stop();
  follow.stop();
  await compositor.destroy();
});

async function assertEventually(fn, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      await fn();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
