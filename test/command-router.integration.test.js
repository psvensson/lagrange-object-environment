import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {Command} from '../src/index.js';
import {CommandAuthorizationError} from '../src/command-dispatcher.js';
import {createImageClientAdapter, classIdFor} from '../src/image-client-adapter.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createCommandRouter} from '../src/command-router.js';

// The PR D core proof (Bead lagrange-object-environment-nlg): a semantic
// interaction on a Component-backed view routes through the ordinary
// Command -> authorized image-operation path. Headless, against the real
// in-memory lagrange-images substrate (like phase1-e2e); the renderer is the
// FakeRendererAdapter (the routing does not need a browser — the browser half
// only has to deliver the intent to consumeIntent, proven separately).
//
// Discrimination: (a) an authorized interaction on view A mutates A's subject
// (observable via readObject), NOT view B's (the subject is bound per-view,
// never global); (b) the unauthorized path (no/wrong authority) is rejected
// (applicability != authorization); (c) a stale version token conflicts.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(HERE, '../../lagrange-images/src/runtime.js');
const RUNTIME_URL = process.env.LAGRANGE_IMAGES_URL ?? pathToFileURL(DEFAULT_RUNTIME).href;

let imagesApi = null;
try {
  imagesApi = await import(RUNTIME_URL);
} catch {
  imagesApi = null;
}
const available = imagesApi !== null && typeof imagesApi.createRuntime === 'function';

const IMAGE = 'env-pr-d';
const IDS = Object.freeze({
  shapeId: 'probe-shape',
  className: 'Probe',
  interfaceId: 'probe-create-interface',
  bindingId: 'probe-create-binding',
  blockId: 'probe-create-block',
  mutationInterfaceId: 'probe-mutate-interface',
  mutationBindingId: 'probe-mutate-binding',
  mutationBlockId: 'probe-mutate-block',
  readInterfaceId: 'object-read-interface',
  readBindingId: 'object-read-binding',
  readBlockId: 'object-read-block',
  observationInterfaceId: 'observation-interface',
  observationBindingId: 'observation-binding',
  observationBlockId: 'observation-block',
});

test('PR D: semantic interaction on a view routes Command -> authorized image mutation (per-view subject)', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
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

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });

  // Two durable subjects the two views render.
  const createdA = await adapter.createObject({imageId: IMAGE, classId, title: 'A', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId});
  const createdB = await adapter.createObject({imageId: IMAGE, classId, title: 'B', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId});

  // The set-title command (applicability-only discovery; authorized at dispatch).
  const commandRegistry = createCommandRegistry();
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, title}) => a.mutateObject({
      imageId: subject.imageId, objectId: subject.objectId,
      value: {title}, authority, blockId: IDS.mutationBlockId,
    }),
  }));

  // A Compositor over the FakeRendererAdapter; two views, one per subject.
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const viewA = await compositor.openView({
    viewDescriptor: {kind: 'webgpu-canvas', width: 320, height: 200},
    presentationDescriptor: {kind: 'glb', subject: ref(createdA.objectId), parameters: {}},
  });
  const viewB = await compositor.openView({
    viewDescriptor: {kind: 'webgpu-canvas', width: 320, height: 200},
    presentationDescriptor: {kind: 'glb', subject: ref(createdB.objectId), parameters: {}},
  });

  // The FakeRendererAdapter mints handles `fake-surface-N` in openView order:
  // A opened first (handle-0), B second (handle-1). The router resolves each
  // handle to its view's bound subject via the Compositor.
  const handleA = 'fake-surface-0';
  const handleB = 'fake-surface-1';

  // The router: authority issued per dispatch (the Session connection-locus
  // seam); the router never mints/stores it.
  const writeAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice',
    grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const router = createCommandRouter({
    compositor,
    commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async ({subject}) => writeAuthority(subject.objectId),
  });

  const readTitle = async (objectId) => {
    const read = await adapter.readObject({
      imageId: IMAGE, objectId,
      authority: runtime.authority.issue({principal: 'alice', grants: [{operation: 'object/read', resource: imagesApi.objectResource(IMAGE, objectId)}]}),
      blockId: IDS.readBlockId,
    });
    return read?.slots?.['probe-title']?.value ?? null;
  };

  // (a) authorized interaction on view A -> A's subject mutates, B's does not.
  const resultA = await router.consumeIntent({kind: 'activate'}, {surfaceHandle: handleA, context: {title: 'A-activated'}});
  assert.ok(resultA, 'the interaction on view A dispatched a mutation');
  assert.equal(await readTitle(createdA.objectId), 'A-activated', 'view A subject mutated');
  assert.equal(await readTitle(createdB.objectId), 'B', 'view B subject unchanged (subject is bound per-view, never global)');

  // (b) unauthorized: an authorityProvider that issues NO write grant -> rejected.
  const routerNoAuth = createCommandRouter({
    compositor,
    commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async () => runtime.authority.issue({principal: 'mallory', grants: []}),
  });
  await assert.rejects(
    () => routerNoAuth.consumeIntent({kind: 'activate'}, {surfaceHandle: handleB, context: {title: 'B-hijack'}}),
    CommandAuthorizationError,
    'an interaction without write authority must be rejected (applicability != authorization)',
  );
  assert.equal(await readTitle(createdB.objectId), 'B', 'unauthorized interaction left B unchanged');

  // (c) stale version token -> conflict. Capture the token before a mutation,
  // then replay it after the version has advanced.
  const freshToken = imagesApi.objectVersionToken(IMAGE, createdA.objectId, (await runtime.images.getObject(IMAGE, createdA.objectId))?._version);
  await adapter.mutateObject({
    imageId: IMAGE, objectId: createdA.objectId, value: {title: 'A-second'},
    authority: writeAuthority(createdA.objectId), blockId: IDS.mutationBlockId,
  });
  await assert.rejects(
    () => adapter.mutateObject({
      imageId: IMAGE, objectId: createdA.objectId, value: {title: 'A-stale'},
      authority: writeAuthority(createdA.objectId), blockId: IDS.mutationBlockId,
      versionToken: freshToken, // stale: A-second already advanced the token
    }),
    /conflict|stale|version/i,
    'a stale version token must conflict (optimistic concurrency)',
  );

  // (d) an intent on an unknown handle routes nowhere (no subject, no crash).
  const nowhere = await router.consumeIntent({kind: 'activate'}, {surfaceHandle: 'fake-surface-999', context: {title: 'x'}});
  assert.equal(nowhere, null, 'an interaction on an unknown handle routes nowhere');
});
