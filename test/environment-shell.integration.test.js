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
