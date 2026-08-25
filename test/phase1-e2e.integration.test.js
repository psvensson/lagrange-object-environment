import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {Command} from '../src/index.js';
import {CommandAuthorizationError} from '../src/command-dispatcher.js';
import {createImageClientAdapter, classIdFor} from '../src/image-client-adapter.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {createObjectNavigator} from '../src/object-navigator.js';
import {
  createObjectInspectorProvider,
  createUnavailableRefProvider,
} from '../src/object-presentation-providers.js';

// The Phase 1 end-to-end proof (Bead kmu): manipulating an object through the
// environment demonstrably manipulates the Image rather than a shadow UI
// model. Headless, against the real sibling runtime (resolved like the other
// integration test); no renderer.

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

const IMAGE = 'env-e2e';
const IDS = Object.freeze({
  shapeId: 'probe-shape',
  className: 'Probe',
  interfaceId: 'probe-create-interface',
  bindingId: 'probe-create-binding',
  blockId: 'probe-create-block',
  mutationInterfaceId: 'probe-mutate-interface',
  mutationBindingId: 'probe-mutate-binding',
  mutationBlockId: 'probe-mutate-block',
});

test('Phase 1 end-to-end: open -> present -> navigate -> command -> authorized mutation -> observe -> presentation updates', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
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
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });
  await adapter.ensureSchema(IMAGE, IDS);

  // Wire the discovery architecture: registries + the generic providers, and
  // the navigator (with the substrate's graph walker injected).
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  const commandRegistry = createCommandRegistry();
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfRecord: imagesApi.referencesOfRecord,
  });

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});

  // --- setup: two durable objects, A references B (through the authorized
  // creation lane, staged authority). B points at smalltalk/nil (createObject
  // requires a subject). ------------------------------------------------------
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });
  const createdB = await adapter.createObject({
    imageId: IMAGE, classId, title: 'B',
    subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId,
  });
  const createdA = await adapter.createObject({
    imageId: IMAGE, classId, title: 'A-original',
    subject: ref(createdB.objectId), authority: createAuthority(createdB.objectId), blockId: IDS.blockId,
  });

  // --- 1. open object -> presentation discovered (via the registry) ---------
  const openA = await navigator.navigate(ref(createdA.objectId));
  assert.equal(openA.presentations.length, 1, 'exactly one inspector presentation for a ref subject');
  assert.equal(openA.presentations[0].kind, 'inspector');
  assert.equal(openA.presentations[0].context.fields['probe-title'].value, 'A-original');

  // --- 2. inspect -> select referenced subject (follow the ref from context,
  // not a hard-coded B) -------------------------------------------------------
  const refToB = openA.presentations[0].context.references.find((r) => r.objectId === createdB.objectId);
  assert.ok(refToB, 'A must reference B through its stored edge');
  const openB = await navigator.navigate(refToB);
  assert.equal(openB.presentations[0].kind, 'inspector');
  assert.equal(openB.presentations[0].context.fields['probe-title'].value, 'B');

  // --- 3. command discovered (applicability-only, not authorized) -----------
  // The mutation command: set-title crosses the image boundary through the
  // dispatcher, using the authority passed AT DISPATCH (not closure-captured).
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, title}) => {
      return a.mutateObject({
        imageId: subject.imageId, objectId: subject.objectId,
        value: {title}, authority, blockId: IDS.mutationBlockId,
      });
    },
  }));
  const discovered = await navigator.navigate(ref(createdA.objectId));
  const setTitle = discovered.commands.find((c) => c.id === 'set-title');
  assert.ok(setTitle, 'the set-title command is discovered (applicability-only)');

  // --- 4. invoke through CommandDispatcher -> authorized image mutation ------
  // Authority is issued per-dispatch and crosses the boundary. The mutated
  // result exists ONLY as the return of this dispatch (falsification E1).
  const mutateAuthority = runtime.authority.issue({
    principal: 'alice',
    grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, createdA.objectId)}],
  });
  const dispatched = await adapter.dispatch(setTitle, ref(createdA.objectId), {
    authority: mutateAuthority, context: {title: 'A-changed'},
  });
  assert.equal(dispatched.objectId, createdA.objectId, 'mutation preserves identity (same object id)');

  // --- 5. observation sees the change (the SAME object id, new value) -------
  let observedChange = null;
  for await (const change of adapter.observe(IMAGE, {afterRevision: 0, intervalMs: 0})) {
    if (
      change.kind === 'object.put' &&
      change.record?.id === createdA.objectId &&
      change.record?.slots?.['probe-title']?.value === 'A-changed'
    ) {
      observedChange = change;
      break; // the stream is infinite; stop at the target change
    }
  }
  assert.ok(observedChange, 'observation must see the authorized mutation on the change feed');

  // --- 6. presentation model updates (fresh read from the image, not a shadow)
  const reopened = await navigator.navigate(ref(createdA.objectId));
  assert.equal(
    reopened.presentations[0].context.fields['probe-title'].value,
    'A-changed',
    'the presentation model reflects the image mutation, not a shadow model',
  );

  // --- falsification arm: authority is load-bearing at dispatch -------------
  // Dispatching with a DENYING authority (no object/write on A) surfaces
  // CommandAuthorizationError and writes nothing new to the feed.
  const noWriteAuthority = runtime.authority.issue({principal: 'mallory', grants: []});
  await assert.rejects(
    adapter.dispatch(setTitle, ref(createdA.objectId), {
      authority: noWriteAuthority, context: {title: 'A-unauthorized'},
    }),
    (error) => error instanceof CommandAuthorizationError || /object\/write|not authorized/i.test(error?.message ?? ''),
  );
  const afterDeny = await navigator.navigate(ref(createdA.objectId));
  assert.equal(afterDeny.presentations[0].context.fields['probe-title'].value, 'A-changed', 'a denied dispatch mutates nothing');

  await runtime.close();
});
