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
