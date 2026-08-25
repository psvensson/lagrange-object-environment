import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {Command} from '../src/index.js';
import {createImageClientAdapter, classIdFor, refToEdgeString} from '../src/image-client-adapter.js';
import {
  CommandAuthorizationError,
  CommandNotApplicableError,
} from '../src/command-dispatcher.js';

// Resolve the sibling lagrange-images runtime. The environment stays
// dependency-free (ADR 0002): this integration test is the only place the real
// substrate is wired, via LAGRANGE_IMAGES_URL or the default sibling path.
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

const IMAGE = 'env-demo';
const IDS = Object.freeze({
  shapeId: 'probe-shape',
  className: 'Probe',
  interfaceId: 'probe-create-interface',
  bindingId: 'probe-create-binding',
  blockId: 'probe-create-block',
});

async function setup() {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});

  // The adapter consumes the public surface: the runtime services plus the
  // helpers the module barrels export.
  const adapter = createImageClientAdapter({
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    defineClass: imagesApi.defineClass,
    installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });

  const schema = await adapter.ensureSchema(IMAGE, IDS);
  return {runtime, adapter, schema};
}

function grant(runtime, operation, resource) {
  return runtime.authority.issue({principal: 'alice', grants: [{operation, resource}]});
}

test('image-client-adapter integration', {skip: !available && 'lagrange-images sibling runtime not available'}, async (t) => {
  await t.test('schema provisions idempotently with a kernel precondition', async () => {
    const {adapter} = await setup();
    const again = await adapter.ensureSchema(IMAGE, IDS);
    assert.ok(again.classRecord);

    const noKernel = await imagesApi.createRuntime({backend: {mode: 'mock'}});
    await noKernel.images.createImage({id: 'bare'});
    await assert.rejects(
      createImageClientAdapter({
        images: noKernel.images,
        invocations: noKernel.invocations,
        executor: noKernel.executor,
        defineClass: imagesApi.defineClass,
        installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
        installImageCreationBinding: imagesApi.installImageCreationBinding,
        findSmalltalkKernel: imagesApi.findSmalltalkKernel,
        objectRef: imagesApi.objectRef,
        objectResource: imagesApi.objectResource,
        parseObjectResource: imagesApi.parseObjectResource,
        textValue: imagesApi.textValue,
        packCompositeValue: imagesApi.packCompositeValue,
        normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
      }).ensureSchema('bare', IDS),
      /no Smalltalk kernel/,
    );
  });

  await t.test('create -> read back -> observe closes the live loop', async () => {
    const {runtime, adapter, schema} = await setup();
    const classId = classIdFor(IDS.className);

    // A durable target for the edge subject, created host-side.
    const targetShape = schema.shape.id;
    await runtime.images.putObject(IMAGE, {
      id: 'subject-target',
      shape: imagesApi.objectRef(IMAGE, targetShape),
      behavior: imagesApi.objectRef(IMAGE, classId),
      slots: {
        'probe-title': imagesApi.textValue('target'),
        'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
      },
    });

    const authority = runtime.authority.issue({
      principal: 'alice',
      grants: [
        {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
        {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, 'subject-target')},
      ],
    });

    const created = await adapter.createObject({
      imageId: IMAGE,
      classId,
      title: 'My probe',
      subject: {kind: 'ref', imageId: IMAGE, objectId: 'subject-target'},
      authority,
      blockId: IDS.blockId,
    });

    assert.ok(created.objectId.length > 0);
    assert.equal(typeof created.versionToken, 'string');

    const read = await adapter.readObject(IMAGE, created.objectId);
    assert.equal(read.slots['probe-title'].value, 'My probe');
    assert.deepEqual(read.slots['probe-subject'], {
      kind: 'ref',
      imageId: IMAGE,
      objectId: 'subject-target',
    });

    // Observation: the create emitted an object.put change on the history
    // stream. Catch-up mode (afterRevision: 0) replays it; live-follow would
    // wait only for events after now.
    const observed = [];
    for await (const change of adapter.observe(IMAGE, {afterRevision: 0, intervalMs: 0})) {
      observed.push(change);
      if (observed.some((c) => c.kind === 'object.put' && c.record?.id === created.objectId)) break;
    }
    const created2 = observed.find((c) => c.record?.id === created.objectId);
    assert.ok(created2, 'expected to observe the created object on the change feed');
  });

  await t.test('a foreign-image subject ref is rejected adapter-side', async () => {
    const {runtime, adapter} = await setup();
    const classId = classIdFor(IDS.className);
    const authority = grant(runtime, 'object/create', imagesApi.objectResource(IMAGE, classId));

    await assert.rejects(
      adapter.createObject({
        imageId: IMAGE,
        classId,
        title: 'x',
        subject: {kind: 'ref', imageId: 'elsewhere', objectId: 'subject-target'},
        authority,
        blockId: IDS.blockId,
      }),
      /cannot reference elsewhere/,
    );
  });

  await t.test('creation without the edge grant surfaces CommandAuthorizationError on dispatch', async () => {
    const {runtime, adapter} = await setup();
    const classId = classIdFor(IDS.className);
    // Only object/create, no object/edge-write on the target.
    const authority = grant(runtime, 'object/create', imagesApi.objectResource(IMAGE, classId));

    const createCmd = new Command({
      id: 'probe/create',
      title: 'Create probe',
      appliesTo: (s) => s?.classId !== undefined,
      invoke: (s, {authority: auth, adapter: a}) => a.createObject({
        imageId: IMAGE,
        classId: s.classId,
        title: 'cmd',
        subject: {kind: 'ref', imageId: IMAGE, objectId: 'subject-target'},
        authority: auth,
        blockId: IDS.blockId,
      }),
    });

    await assert.rejects(
      adapter.dispatch(createCmd, {classId}, {authority}),
      (error) => error instanceof CommandAuthorizationError || /object\/edge-write|not authorized/i.test(error?.message ?? ''),
    );
  });

  await t.test('not-applicable command never touches the image seam', async () => {
    const {adapter} = await setup();
    let invoked = false;
    const cmd = new Command({
      id: 'probe/never',
      title: 'Never',
      appliesTo: () => false,
      invoke: () => {
        invoked = true;
      },
    });

    await assert.rejects(
      adapter.dispatch(cmd, {classId: 'x'}, {}),
      (error) => error instanceof CommandNotApplicableError,
    );
    assert.equal(invoked, false);
  });
});

test('createImageClientAdapter validates services and helpers (unit, no runtime)', () => {
  assert.throws(() => createImageClientAdapter(null), /requires the lagrange-images public surface/);
  assert.throws(() => createImageClientAdapter({images: {}}), /missing required service: invocations/);

  const good = {
    images: {}, invocations: {}, executor: {},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    textValue: () => {}, packCompositeValue: () => {}, normalizeTypeDeclarations: () => {},
  };
  assert.ok(createImageClientAdapter(good));
  const missing = {...good};
  delete missing.defineClass;
  assert.throws(() => createImageClientAdapter(missing), /missing required helper: defineClass/);
});

test('ensureSchema validates its ids eagerly (unit)', async () => {
  const good = {
    images: {}, invocations: {}, executor: {},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    textValue: () => {}, packCompositeValue: () => {}, normalizeTypeDeclarations: () => {},
  };
  const adapter = createImageClientAdapter(good);
  await assert.rejects(adapter.ensureSchema('img', {}), /ids\.shapeId/);
  await assert.rejects(
    adapter.ensureSchema('img', {shapeId: 's', className: 'c', interfaceId: 'i', bindingId: 'b'}),
    /ids\.blockId/,
  );
});

test('refToEdgeString mapping (unit, no runtime)', () => {
  assert.equal(refToEdgeString({kind: 'ref', imageId: 'i', objectId: 'o'}, 'i'), 'o');
  assert.equal(refToEdgeString({kind: 'pinned-ref', imageId: 'i', objectId: 'o', revision: '3'}, 'i'), 'pin:o@3');
  assert.throws(() => refToEdgeString({kind: 'ref', imageId: 'x', objectId: 'o'}, 'i'), /cannot reference x/);
  assert.throws(() => refToEdgeString({kind: 'text', value: 'o'}, 'i'), /ref or pinned-ref/);
});
