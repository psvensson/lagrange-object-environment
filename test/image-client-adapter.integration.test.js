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

// Ids for the Perspective schema (ADR 0012). Distinct image ids from the probe.
const PERSP_IDS = Object.freeze({
  perspectiveShapeId: 'perspective-shape',
  perspectiveClassName: 'Perspective',
  presentationShapeId: 'presentation-shape',
  presentationClassName: 'Presentation',
  perspectiveInterfaceId: 'perspective-create-interface',
  perspectiveBindingId: 'perspective-create-binding',
  perspectiveBlockId: 'perspective-create-block',
  presentationInterfaceId: 'presentation-create-interface',
  presentationBindingId: 'presentation-create-binding',
  presentationBlockId: 'presentation-create-block',
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

  // The headline Phase 1 deliverable: a Perspective round trip as ordinary
  // image data, through the authorized creation lane (ADR 0012 + ADR 0064),
  // via a STAGED authorized workflow with server-minted child ids and a fresh
  // authority context per invocation.
  await t.test('Perspective save -> load round trip preserves order, refs and payloads', async () => {
    const {runtime, adapter} = await setup();
    const schema = await adapter.ensurePerspectiveSchema(IMAGE, PERSP_IDS);

    // Durable subjects for the edges to point at.
    const subjectShape = await runtime.images.putShape(IMAGE, {id: 'subj-shape', slots: []});
    for (const id of ['subject-a', 'subject-b']) {
      await runtime.images.putObject(IMAGE, {
        id, shape: imagesApi.objectRef(IMAGE, subjectShape.id), slots: {}, metadata: {},
      }, {expectedVersion: 0});
    }

    const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
    const perspective = new (await import('../src/model.js')).Perspective({
      id: 'in-memory',
      subject: ref('subject-a'),
      title: 'Workbench',
      layout: {split: 'vertical'},
      presentations: [
        {id: 'c', kind: 'browser', subject: ref('subject-b'), context: {pkg: 'core'}, state: {}},
        {id: 'a', kind: 'editor', subject: ref('subject-a'), context: {line: 7}, state: {cursor: [0, 0]}},
        {id: 'b', kind: 'inspector', subject: ref('subject-b'), context: {}, state: {open: true}},
      ],
    });

    // The control-plane authority provider: issues a FRESH context per
    // invocation, authorizing exactly that invocation's resources once they are
    // known. The adapter passes the contexts through opaquely. Track issuance to
    // prove the workflow is staged (>= 2 separately issued contexts).
    let issuanceCount = 0;
    const authorityProvider = async (request) => {
      issuanceCount += 1;
      const grants = [
        {operation: 'object/create', resource: imagesApi.objectResource(request.imageId, request.classId)},
        {operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, request.subjectRef.objectId)},
      ];
      for (const childRef of request.childRefs ?? []) {
        grants.push({operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, childRef.objectId)});
      }
      return runtime.authority.issue({principal: 'alice', grants});
    };

    const saved = await adapter.savePerspective({imageId: IMAGE, perspective, authorityProvider, schema});
    assert.ok(saved.perspectiveId.length > 0);
    assert.equal(saved.presentationIds.length, 3);
    // Staged: one context per child (3) + one for the Perspective = 4 separate issuances.
    assert.equal(issuanceCount, 4, 'the save issues a fresh authority context per invocation');
    // Child ids were server-minted (not chosen by the caller).
    for (const childId of saved.presentationIds) {
      assert.ok(childId.length > 0);
    }

    const loaded = await adapter.loadPerspective({imageId: IMAGE, perspectiveId: saved.perspectiveId});
    assert.equal(loaded.title, 'Workbench');
    assert.equal(loaded.subject.objectId, 'subject-a');
    assert.deepEqual(loaded.presentations.map((p) => p.id), ['c', 'a', 'b'], 'order follows the indexed part');
    assert.equal(loaded.presentations[1].kind, 'editor');
    assert.deepEqual(loaded.presentations[1].context, {line: 7});
    assert.deepEqual(loaded.presentations[1].state, {cursor: [0, 0]});
    assert.deepEqual(loaded.layout, {split: 'vertical'});
    // The loaded children are the server-minted objects the Perspective indexes.
    assert.deepEqual(
      loaded.presentations.map((p) => p.subject.objectId),
      ['subject-b', 'subject-a', 'subject-b'],
    );
  });

  await t.test('a Perspective create without an indexed-child edge grant is denied (per-element edge-write)', async () => {
    const {runtime, adapter} = await setup();
    const schema = await adapter.ensurePerspectiveSchema(IMAGE, PERSP_IDS);
    const subjectShape = await runtime.images.putShape(IMAGE, {id: 'subj-shape2', slots: []});
    await runtime.images.putObject(IMAGE, {
      id: 'subject-a', shape: imagesApi.objectRef(IMAGE, subjectShape.id), slots: {}, metadata: {},
    }, {expectedVersion: 0});

    const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
    const perspective = new (await import('../src/model.js')).Perspective({
      id: 'in-memory', subject: ref('subject-a'), title: null, layout: {},
      presentations: [{id: 'a', kind: 'editor', subject: ref('subject-a'), context: {}, state: {}}],
    });

    // The provider authorizes child creation fully, but the Perspective context
    // omits the object/edge-write grant for the (server-minted) child it will
    // index — so the Perspective create must be denied, even though every other
    // grant is present.
    const authorityProvider = async (request) => {
      const grants = [
        {operation: 'object/create', resource: imagesApi.objectResource(request.imageId, request.classId)},
        {operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, request.subjectRef.objectId)},
      ];
      if (request.kind === 'create-presentation') {
        // child creation authorized normally
      } else {
        // create-perspective: deliberately withhold the child indexed-edge grant
      }
      return runtime.authority.issue({principal: 'alice', grants});
    };

    await assert.rejects(
      adapter.savePerspective({imageId: IMAGE, perspective, authorityProvider, schema}),
      (error) => /object\/edge-write|not authorized|Authority/i.test(error?.message ?? error?.name ?? ''),
    );
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
