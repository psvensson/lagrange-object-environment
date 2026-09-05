import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {Command} from '../src/index.js';
import {createImageClientAdapter, classIdFor, refToEdgeString} from '../src/image-client-adapter.js';
import {presentation, split, stack, empty, leafViewIds as leafViewIdsImport} from '../src/composition-tree.js';
import {encodeCompositionLayout, decodeCompositionLayout} from '../src/composition-persistence.js';
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
    authority: runtime.authority,
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
    authorizedReadProject: imagesApi.authorizedReadProject,
    authorizedRenameProject: imagesApi.authorizedRenameProject,
    authorizedDescribeSmalltalkClass: imagesApi.authorizedDescribeSmalltalkClass,
    authorizedDescribeSmalltalkMethod: imagesApi.authorizedDescribeSmalltalkMethod,
  });

  const schema = await adapter.ensureSchema(IMAGE, IDS);
  return {runtime, adapter, schema};
}

function grant(runtime, operation, resource) {
  return runtime.authority.issue({principal: 'alice', grants: [{operation, resource}]});
}

// A control-plane read authority provider for loadPerspective: issues a fresh
// opaque context authorizing exactly the requested read. Mirror of the
// savePerspective authorityProvider pattern. An optional deny set leaves a
// child unauthorized (ref != authority).
function readAuthorityProvider(runtime, {deny = new Set()} = {}) {
  return async (request) => {
    const objectId = request.kind === 'read-perspective' ? request.perspectiveId : request.objectId;
    const grants = deny.has(objectId)
      ? []
      : [{operation: 'object/read', resource: imagesApi.objectResource(request.imageId, objectId)}];
    return runtime.authority.issue({principal: 'alice', grants});
  };
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
        authority: noKernel.authority,
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
        authorizedReadProject: imagesApi.authorizedReadProject,
        authorizedRenameProject: imagesApi.authorizedRenameProject,
        authorizedDescribeSmalltalkClass: imagesApi.authorizedDescribeSmalltalkClass,
        authorizedDescribeSmalltalkMethod: imagesApi.authorizedDescribeSmalltalkMethod,
      }).ensureSchema('bare', IDS),
      /no Smalltalk kernel/,
    );
  });

  await t.test('authorized Project read returns the canonical descriptor without granting member targets', async () => {
    const {runtime, adapter} = await setup();
    const projectId = 'adapter-project';
    await imagesApi.createProject({images: runtime.images, imageId: IMAGE, projectId, name: 'Adapter Project'});
    await imagesApi.addProjectMember({
      images: runtime.images, imageId: IMAGE, projectId,
      key: 'z-last', role: 'test', target: imagesApi.objectRef(IMAGE, 'target-z'),
    });
    await imagesApi.addProjectMember({
      images: runtime.images, imageId: IMAGE, projectId,
      key: 'a-first', role: 'source', target: imagesApi.objectRef(IMAGE, 'target-a'),
    });

    const projectAuthority = grant(
      runtime,
      'object/read',
      imagesApi.objectResource(IMAGE, imagesApi.projectObjectId(projectId)),
    );
    const read = await adapter.readProject({imageId: IMAGE, projectId, authority: projectAuthority});
    // The version-aware seam: {descriptor, versionToken} returned UNCHANGED.
    assert.deepEqual(Object.keys(read).sort(), ['descriptor', 'versionToken']);
    assert.ok(Object.isFrozen(read), 'Images returns a frozen result; the adapter passes it through');
    assert.equal(typeof read.versionToken, 'string');
    assert.ok(read.versionToken.length > 0, 'the token is an opaque non-empty string (never interpreted here)');
    const {descriptor} = read;
    assert.equal(descriptor.name, 'Adapter Project');
    assert.deepEqual(descriptor.members.map(({key, role, target}) => ({key, role, target})), [
      {key: 'a-first', role: 'source', target: imagesApi.objectRef(IMAGE, 'target-a')},
      {key: 'z-last', role: 'test', target: imagesApi.objectRef(IMAGE, 'target-z')},
    ], 'Images canonicalizes member order; the adapter returns that descriptor unchanged');

    const none = runtime.authority.issue({principal: 'mallory', grants: []});
    for (const deniedProjectId of [projectId, 'does-not-exist']) {
      await assert.rejects(
        adapter.readProject({imageId: IMAGE, projectId: deniedProjectId, authority: none}),
        (error) => error?.name === 'AuthorityError',
        'denied existing and nonexistent Projects are indistinguishable by error kind',
      );
    }
    await assert.rejects(
      adapter.readObject({
        imageId: IMAGE, objectId: 'target-a', authority: projectAuthority, blockId: IDS.readBlockId,
      }),
      (error) => error?.name === 'AuthorityError',
      'Project membership and Project-read authority do not grant target object/read',
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
        'probe-count': imagesApi.integerValue(0),
        'probe-flag': imagesApi.booleanValue(false),
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
      count: 7,
      flag: true,
      authority,
      blockId: IDS.blockId,
    });

    assert.ok(created.objectId.length > 0);
    assert.equal(typeof created.versionToken, 'string');

    const read = await adapter.readObject({
      imageId: IMAGE,
      objectId: created.objectId,
      authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, created.objectId)),
      blockId: IDS.readBlockId,
    });
    assert.equal(read.slots['probe-title'].value, 'My probe');
    assert.deepEqual(read.slots['probe-subject'], {
      kind: 'ref',
      imageId: IMAGE,
      objectId: 'subject-target',
    });
    // S1: the probe carries REAL browseable scalar Values. count/flag round-trip
    // as canonical integer/boolean and are READ-ONLY (not in the mutation lane);
    // only probe-title is writable. Canonical integer carries value as a decimal
    // string (BigInt-safe); the projector's valueText renders it as '7'.
    assert.deepEqual(read.slots['probe-count'], {kind: 'integer', value: '7'});
    assert.deepEqual(read.slots['probe-flag'], {kind: 'boolean', value: true});

    // Defaults: count/flag omitted -> seeded 0/false (the creation record is
    // OOM-complete; the adapter owns the canonical scalar defaults).
    const createdDefaults = await adapter.createObject({
      imageId: IMAGE,
      classId,
      title: 'Defaults probe',
      subject: {kind: 'ref', imageId: IMAGE, objectId: 'subject-target'},
      authority,
      blockId: IDS.blockId,
    });
    const readDefaults = await adapter.readObject({
      imageId: IMAGE,
      objectId: createdDefaults.objectId,
      authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, createdDefaults.objectId)),
      blockId: IDS.readBlockId,
    });
    assert.deepEqual(readDefaults.slots['probe-count'], {kind: 'integer', value: '0'});
    assert.deepEqual(readDefaults.slots['probe-flag'], {kind: 'boolean', value: false});

    // READ-ONLY proof (S1 invariant): count/flag are NOT in the mutation lane's
    // writable surface, and a title mutation leaves them untouched. The adapter
    // exposes the single-owner writable-slot set; S3 derives editability from it.
    assert.deepEqual([...adapter.writableSlots].sort(), ['probe-title'],
      'only probe-title is writable; count/flag are read-only');
    await adapter.mutateObject({
      imageId: IMAGE, objectId: created.objectId, value: {title: 'My probe (renamed)'},
      authority: grant(runtime, 'object/write', imagesApi.objectResource(IMAGE, created.objectId)),
      blockId: IDS.mutationBlockId,
    });
    const afterRename = await adapter.readObject({
      imageId: IMAGE, objectId: created.objectId,
      authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, created.objectId)),
      blockId: IDS.readBlockId,
    });
    assert.equal(afterRename.slots['probe-title'].value, 'My probe (renamed)');
    assert.deepEqual(afterRename.slots['probe-count'], {kind: 'integer', value: '7'},
      'a title mutation preserves the read-only count (unmapped slots are never written)');
    assert.deepEqual(afterRename.slots['probe-flag'], {kind: 'boolean', value: true},
      'a title mutation preserves the read-only flag');

    // Observation over the AUTHORIZED LANE: live-follow from the current end
    // replays no backlog, then a fresh create appears as a metadata-only
    // invalidation — identity + kind + opaque cursor, no record payload, no
    // global revision. (Catch-up/restricted proofs are their own test below.)
    const ac = new AbortController();
    const observing = (async () => {
      for await (const change of adapter.observe(IMAGE, {
        // Exact-match grant on the object we expect to change (NO wildcard — ADR 0037 §6).
        authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, created.objectId)),
        blockId: IDS.observationBlockId,
        intervalMs: 0,
        signal: ac.signal,
      })) {
        return change;
      }
      return null;
    })();
    await new Promise((resolve) => setTimeout(resolve, 25)); // let the lane anchor live-follow
    // Mutate the ALREADY-GRANTED object (not a fresh create whose id we don't hold a grant for), so
    // the exact-match object/read grant covers the change the lane filters on.
    await adapter.mutateObject({
      imageId: IMAGE,
      objectId: created.objectId,
      value: {title: 'My probe (edited)'},
      authority: runtime.authority.issue({
        principal: 'alice',
        grants: [
          {operation: 'object/write', resource: imagesApi.objectResource(IMAGE, created.objectId)},
          {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
        ],
      }),
      blockId: IDS.mutationBlockId,
    });
    const firstChange = await observing;
    ac.abort();

    assert.equal(firstChange.kind, 'object.put');
    assert.equal(typeof firstChange.objectId, 'string');
    // Metadata-only: no payload, no global revision, opaque string cursor.
    assert.ok(!('record' in firstChange), 'the authorized feed never carries a record payload');
    assert.ok(!('revision' in firstChange), 'the authorized feed never carries a global revision');
    assert.equal(typeof firstChange.cursor, 'string');
    assert.ok(Number.isNaN(Number(firstChange.cursor)), 'the cursor is an opaque string, not a number');
    assert.match(firstChange.cursor, /^obs-cursor\/v1:/);

    // The consumer re-reads CURRENT state via the authorized read seam; the
    // feed itself disclosed nothing but identity.
    const reread = await adapter.readObject({
      imageId: IMAGE,
      objectId: firstChange.objectId,
      authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, firstChange.objectId)),
      blockId: IDS.readBlockId,
    });
    assert.equal(reread.slots['probe-title'].value, 'My probe (edited)');
    assert.equal(firstChange.objectId, created.objectId, 'the invalidation names the mutated, granted object');
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

    const loaded = await adapter.loadPerspective({
      imageId: IMAGE,
      perspectiveId: saved.perspectiveId,
      authorityProvider: readAuthorityProvider(runtime),
      readBlockId: IDS.readBlockId,
    });
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

  await t.test('composition tree round-trips through the REAL authorized Perspective save/load; indexed order != arrangement', async () => {
    const {runtime, adapter} = await setup();
    const schema = await adapter.ensurePerspectiveSchema(IMAGE, PERSP_IDS);

    const subjectShape = await runtime.images.putShape(IMAGE, {id: 'subj-shape', slots: []});
    for (const id of ['subject-a', 'subject-b', 'subject-c']) {
      await runtime.images.putObject(IMAGE, {
        id, shape: imagesApi.objectRef(IMAGE, subjectShape.id), slots: {}, metadata: {},
      }, {expectedVersion: 0});
    }
    const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});

    // The intended composition: split(A, stack([B, C], active B)).
    const tree = split('row', 0.3, presentation('view-A'), stack([presentation('view-B'), presentation('view-C')], 'view-B'));
    // Perspective presentations DELIBERATELY enumerated in a DIFFERENT order
    // (C, A, B) than the arrangement — proving indexed enumeration != arrangement.
    const presentations = [
      {id: 'view-C', kind: 'inspector', subject: ref('subject-c'), context: {}, state: {open: true}},
      {id: 'view-A', kind: 'browser', subject: ref('subject-a'), context: {}, state: {}},
      {id: 'view-B', kind: 'editor', subject: ref('subject-b'), context: {line: 3}, state: {}},
    ];
    // The layout is the VERSIONED composition payload (bijection enforced at encode).
    const layout = encodeCompositionLayout(tree, presentations);

    const {Perspective} = await import('../src/model.js');
    const perspective = new Perspective({
      id: 'in-memory',
      subject: ref('subject-a'),
      title: 'Composed workbench',
      layout,
      presentations,
    });

    const authorityProvider = async (request) => {
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
    const loaded = await adapter.loadPerspective({
      imageId: IMAGE,
      perspectiveId: saved.perspectiveId,
      authorityProvider: readAuthorityProvider(runtime),
      readBlockId: IDS.readBlockId,
    });

    // The indexed enumeration order is preserved (C, A, B) — NOT the arrangement.
    assert.deepEqual(loaded.presentations.map((p) => p.id), ['view-C', 'view-A', 'view-B'], 'indexed enumeration is membership order, not arrangement');
    // The composition tree decodes identically from the layout slot.
    const decoded = decodeCompositionLayout(loaded.layout, loaded.presentations);
    assert.equal(decoded.legacy, false);
    assert.deepEqual(decoded.composition, tree, 'the composition tree round-trips through the real save/load');
    assert.equal(decoded.composition.second.active, 'view-B', 'stack.active survives persistence');
    // The tree's leaf order (A,B,C) differs from the indexed order (C,A,B): the
    // two orders are independent.
    assert.deepEqual([...leafViewIdsImport(decoded.composition)], ['view-A', 'view-B', 'view-C']);

    // The layout JSON is ref-free and carries no viewDescriptor/geometry/handle.
    const layoutJson = JSON.stringify(loaded.layout);
    for (const banned of ['"kind":"ref"', 'surfaceHandle', 'width', 'height', 'viewDescriptor', 'focus', 'selection', 'authority']) {
      assert.ok(!layoutJson.includes(banned), `persisted layout must not carry "${banned}"`);
    }
  });

  await t.test('an empty Perspective round-trips an empty() composition', async () => {
    const {runtime, adapter} = await setup();
    const schema = await adapter.ensurePerspectiveSchema(IMAGE, PERSP_IDS);
    const subjectShape = await runtime.images.putShape(IMAGE, {id: 'subj-shape', slots: []});
    await runtime.images.putObject(IMAGE, {
      id: 'subject-a', shape: imagesApi.objectRef(IMAGE, subjectShape.id), slots: {}, metadata: {},
    }, {expectedVersion: 0});
    const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});

    const {Perspective} = await import('../src/model.js');
    const perspective = new Perspective({
      id: 'in-memory',
      subject: ref('subject-a'),
      title: null,
      layout: encodeCompositionLayout(empty(), []),
      presentations: [],
    });
    const authorityProvider = async (request) => runtime.authority.issue({
      principal: 'alice',
      grants: [
        {operation: 'object/create', resource: imagesApi.objectResource(request.imageId, request.classId)},
        {operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, request.subjectRef.objectId)},
      ],
    });
    const saved = await adapter.savePerspective({imageId: IMAGE, perspective, authorityProvider, schema});
    const loaded = await adapter.loadPerspective({
      imageId: IMAGE,
      perspectiveId: saved.perspectiveId,
      authorityProvider: readAuthorityProvider(runtime),
      readBlockId: IDS.readBlockId,
    });
    assert.equal(loaded.presentations.length, 0);
    const decoded = decodeCompositionLayout(loaded.layout, loaded.presentations);
    assert.deepEqual(decoded.composition, {kind: 'empty'}, 'an empty Perspective round-trips empty(), not a special-cased layout');
  });

  // The authorized object/read lane (substrate ADR 0068): readObject is the
  // environment's single user-facing read seam, crossing object/read under
  // explicit authority. Denied => AuthorityError (no existence oracle);
  // authorized-but-missing => a distinct not-found TypeError.
  await t.test('readObject crosses the authorized read lane; denied and missing are distinct', async () => {
    const {runtime, adapter, schema} = await setup();
    const classId = classIdFor(IDS.className);
    const shapeId = schema.shape.id;

    await runtime.images.putObject(IMAGE, {
      id: 'subject-target',
      shape: imagesApi.objectRef(IMAGE, shapeId),
      behavior: imagesApi.objectRef(IMAGE, classId),
      slots: {
        'probe-title': imagesApi.textValue('target'),
        'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
        'probe-count': imagesApi.integerValue(0),
        'probe-flag': imagesApi.booleanValue(false),
      },
    });

    // Authorized read of an existing object returns the whole record + token.
    const read = await adapter.readObject({
      imageId: IMAGE,
      objectId: 'subject-target',
      authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'subject-target')),
      blockId: IDS.readBlockId,
    });
    assert.equal(read.slots['probe-title'].value, 'target');
    assert.deepEqual(read.slots['probe-subject'], {kind: 'ref', imageId: IMAGE, objectId: 'smalltalk/nil'});
    assert.equal(typeof read.versionToken, 'string');
    assert.match(read.versionToken, /^object-version\/v0:/);

    // Denied: AuthorityError BEFORE any existence check, so an existing and a
    // nonexistent object are indistinguishable (no existence oracle).
    const wrongGrant = grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'elsewhere'));
    await assert.rejects(
      adapter.readObject({imageId: IMAGE, objectId: 'subject-target', authority: wrongGrant, blockId: IDS.readBlockId}),
      (error) => error?.name === 'AuthorityError' && /object\/read/.test(error.message),
    );
    await assert.rejects(
      adapter.readObject({imageId: IMAGE, objectId: 'no-such-object', authority: wrongGrant, blockId: IDS.readBlockId}),
      (error) => error?.name === 'AuthorityError' && /object\/read/.test(error.message),
    );

    // Authorized but nonexistent: a distinct not-found, never conflated with
    // AuthorityError and never a silent null. Machine-readable via the lane-owned
    // stable code (OBJECT_NOT_FOUND), not by matching message text.
    await assert.rejects(
      adapter.readObject({
        imageId: IMAGE,
        objectId: 'no-such-object',
        authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'no-such-object')),
        blockId: IDS.readBlockId,
      }),
      (error) => error?.code === 'OBJECT_NOT_FOUND' && error?.name !== 'AuthorityError',
    );
  });

  await t.test('resolveAssetBytes resolves durable bytes per-ref under object/read; denied and invalid are distinct', async () => {
    const {runtime, adapter, schema} = await setup();
    const classId = classIdFor(IDS.className);
    const shapeId = schema.shape.id;
    const b64 = (bytes) => Buffer.from(bytes).toString('base64');

    // Two durable asset objects, each carrying a byte payload (base64) in the
    // 'probe-title' text slot — the durable bytes live there and
    // resolveAssetBytes reads them via ref.slot = 'probe-title'.
    const assetSlots = (bytesVal) => ({
      'probe-title': imagesApi.textValue(bytesVal),
      'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
      'probe-count': imagesApi.integerValue(0),
      'probe-flag': imagesApi.booleanValue(false),
    });
    await runtime.images.putObject(IMAGE, {
      id: 'asset-a',
      shape: imagesApi.objectRef(IMAGE, shapeId),
      behavior: imagesApi.objectRef(IMAGE, classId),
      slots: assetSlots(b64([1, 2, 3, 4])),
    });
    await runtime.images.putObject(IMAGE, {
      id: 'asset-b',
      shape: imagesApi.objectRef(IMAGE, shapeId),
      behavior: imagesApi.objectRef(IMAGE, classId),
      slots: assetSlots(b64([9, 9, 9])),
    });

    // Authorized: each presentation-local name resolves to ITS OWN opaque bytes.
    const allow = await adapter.resolveAssetBytes({
      assets: [
        {name: 'main-model', ref: {imageId: IMAGE, objectId: 'asset-a', slot: 'probe-title', blockId: IDS.readBlockId}},
        {name: 'alt-model', ref: {imageId: IMAGE, objectId: 'asset-b', slot: 'probe-title', blockId: IDS.readBlockId}},
      ],
      // A multi-grant context authorizing both reads (per-ref object/read).
      authority: runtime.authority.issue({
        principal: 'alice',
        grants: [
          {operation: 'object/read', resource: imagesApi.objectResource(IMAGE, 'asset-a')},
          {operation: 'object/read', resource: imagesApi.objectResource(IMAGE, 'asset-b')},
        ],
      }),
    });
    assert.deepEqual([...allow.get('main-model')], [1, 2, 3, 4], 'main-model -> asset-a bytes');
    assert.deepEqual([...allow.get('alt-model')], [9, 9, 9], 'alt-model -> asset-b bytes (names are presentation-local, not the object id)');

    // Denied: a principal without object/read on asset-b cannot resolve it, even
    // though the name is presentation-local. AuthorityError, no existence oracle.
    await assert.rejects(
      adapter.resolveAssetBytes({
        assets: [{name: 'main-model', ref: {imageId: IMAGE, objectId: 'asset-b', slot: 'probe-title', blockId: IDS.readBlockId}}],
        authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'asset-a')),
      }),
      (error) => error?.name === 'AuthorityError' && /object\/read/.test(error.message),
    );

    // Invalid: an object whose named slot carries no byte payload is a distinct
    // failure (not a silent empty allowlist). asset-empty has a probe-title that
    // is not valid base64 bytes we can use — we ask for a slot that does not exist.
    await runtime.images.putObject(IMAGE, {
      id: 'asset-empty',
      shape: imagesApi.objectRef(IMAGE, shapeId),
      behavior: imagesApi.objectRef(IMAGE, classId),
      slots: {
        'probe-title': imagesApi.textValue('not-bytes'),
        'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
        'probe-count': imagesApi.integerValue(0),
        'probe-flag': imagesApi.booleanValue(false),
      },
    });
    await assert.rejects(
      adapter.resolveAssetBytes({
        assets: [{name: 'main-model', ref: {imageId: IMAGE, objectId: 'asset-empty', slot: 'no-such-slot', blockId: IDS.readBlockId}}],
        authority: grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'asset-empty')),
      }),
      /carries no byte payload/,
    );
  });

  // The headline ADR 0070 proof env-side (mirror of the substrate lane proof):
  // a restricted principal's observation receives ONLY invalidations for
  // objects it may object/read; an UNREADABLE object's change never appears —
  // not its record, not its identity, not a gap in any numeric sequence. This
  // is the falsification arm: it goes red if observe() falls back to the raw
  // images.history stream (which discloses every object's full record).
  await t.test('authorized observation: an unreadable object\'s change never appears; the consumer re-reads via readObject', async () => {
    const {runtime, adapter, schema} = await setup();
    const classId = classIdFor(IDS.className);
    const shapeId = schema.shape.id;

    // Seed two objects: 'readable' (alice may object/read) and 'secret'
    // (alice may not). Both writes land on the private history stream.
    for (const [id, title] of [['readable', 'visible'], ['secret', 'hidden']]) {
      await runtime.images.putObject(IMAGE, {
        id,
        shape: imagesApi.objectRef(IMAGE, shapeId),
        behavior: imagesApi.objectRef(IMAGE, classId),
        slots: {
          'probe-title': imagesApi.textValue(title),
          'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
          'probe-count': imagesApi.integerValue(0),
          'probe-flag': imagesApi.booleanValue(false),
        },
      });
    }

    // Sanity (control-plane/trusted host read): the secret write really is on
    // the raw privileged stream — the lane's silence is filtering, not absence.
    const raw = await runtime.images.history(IMAGE, {afterRevision: 0});
    assert.ok(raw.some((e) => e.type === 'object.put' && e.objectId === 'secret'),
      'sanity: the unreadable object really is in the private stream');

    // The restricted principal: object/read on 'readable' ONLY. A consumer
    // cannot mint cursors, so the documented flow is: live-follow to anchor at
    // the current end (one authorized pull), write, then observe.
    const restricted = grant(runtime, 'object/read', imagesApi.objectResource(IMAGE, 'readable'));

    const anchor = await adapter.observePull({
      imageId: IMAGE, afterCursor: '', authority: restricted, blockId: IDS.observationBlockId,
    });
    assert.equal(anchor.events.length, 0, 'live-follow replays no backlog');
    assert.equal(typeof anchor.cursor, 'string');
    assert.ok(Number.isNaN(Number(anchor.cursor)), 'the lane cursor is an opaque string, not a number');
    assert.match(anchor.cursor, /^obs-cursor\/v1:/);

    // Both objects change; only the readable one may surface.
    for (const [id, title] of [['secret', 'hidden-v2'], ['readable', 'visible-v2']]) {
      const existing = await runtime.images.getObject(IMAGE, id);
      await runtime.images.putObject(IMAGE, {
        id,
        shape: imagesApi.objectRef(IMAGE, shapeId),
        behavior: imagesApi.objectRef(IMAGE, classId),
        slots: {
          'probe-title': imagesApi.textValue(title),
          'probe-subject': imagesApi.objectRef(IMAGE, 'smalltalk/nil'),
          'probe-count': imagesApi.integerValue(0),
          'probe-flag': imagesApi.booleanValue(false),
        },
      }, {expectedVersion: existing._version});
    }

    const page = await adapter.observePull({
      imageId: IMAGE, afterCursor: anchor.cursor, authority: restricted, blockId: IDS.observationBlockId,
    });
    assert.deepEqual(page.events.map((e) => e.objectId), ['readable'],
      'only the readable object\'s invalidation appears');
    const event = page.events[0];
    assert.equal(event.kind, 'object.put');
    assert.deepEqual(Object.keys(event).sort(), ['cursor', 'kind', 'objectId'],
      'metadata-only: identity + kind + per-event cursor, nothing else');
    for (const cursor of [page.cursor, event.cursor]) {
      assert.equal(typeof cursor, 'string');
      assert.ok(Number.isNaN(Number(cursor)), 'no numeric revision leaks');
      assert.match(cursor, /^obs-cursor\/v1:/);
    }
    const serialized = JSON.stringify(page);
    assert.ok(!serialized.includes('"secret"'), 'the unreadable object\'s identity never appears');
    assert.ok(!serialized.includes('hidden-v2'), 'the unreadable object\'s state never appears');
    assert.ok(!/\brevision\b/.test(serialized), 'no global revision leaks');

    // The consumer obtains CURRENT state only via the authorized read seam:
    // the invalidation named 'readable'; re-reading it crosses object/read.
    const reread = await adapter.readObject({
      imageId: IMAGE,
      objectId: event.objectId,
      authority: restricted, // the same restricted context: object/read('readable')
      blockId: IDS.readBlockId,
    });
    assert.equal(reread.slots['probe-title'].value, 'visible-v2',
      'state disclosure stays in readObject; the feed carried identity only');
  });

  await t.test('loadPerspective reads through the authorized lane; ref != authority for children', async () => {
    const {runtime, adapter} = await setup();
    const schema = await adapter.ensurePerspectiveSchema(IMAGE, PERSP_IDS);
    const subjectShape = await runtime.images.putShape(IMAGE, {id: 'subj-shape3', slots: []});
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
        {id: 'c', kind: 'browser', subject: ref('subject-b'), context: {}, state: {}},
        {id: 'a', kind: 'editor', subject: ref('subject-a'), context: {}, state: {}},
      ],
    });

    const createProvider = async (request) => {
      const grants = [
        {operation: 'object/create', resource: imagesApi.objectResource(request.imageId, request.classId)},
        {operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, request.subjectRef.objectId)},
      ];
      for (const childRef of request.childRefs ?? []) {
        grants.push({operation: 'object/edge-write', resource: imagesApi.objectResource(request.imageId, childRef.objectId)});
      }
      return runtime.authority.issue({principal: 'alice', grants});
    };
    const saved = await adapter.savePerspective({imageId: IMAGE, perspective, authorityProvider: createProvider, schema});

    // Track which reads the provider authorizes to prove each child is a
    // SEPARATE authorized read (not "read P implies read P's children").
    const authorized = [];
    const trackingProvider = async (request) => {
      authorized.push(`${request.kind}:${request.kind === 'read-perspective' ? request.perspectiveId : request.objectId}`);
      const objectId = request.kind === 'read-perspective' ? request.perspectiveId : request.objectId;
      return runtime.authority.issue({
        principal: 'alice',
        grants: [{operation: 'object/read', resource: imagesApi.objectResource(request.imageId, objectId)}],
      });
    };
    const loaded = await adapter.loadPerspective({
      imageId: IMAGE, perspectiveId: saved.perspectiveId, authorityProvider: trackingProvider, readBlockId: IDS.readBlockId,
    });
    assert.equal(loaded.title, 'Workbench');
    assert.deepEqual(loaded.presentations.map((p) => p.id), ['c', 'a'], 'loadPerspective reconstructs through authorized reads');
    // One read for the Perspective + one per child, each separately authorized.
    assert.equal(authorized.filter((r) => r.startsWith('read-perspective')).length, 1);
    assert.equal(authorized.filter((r) => r.startsWith('read-presentation')).length, 2);

    // ref != authority: reading P authorizes P only. Withhold the child grant
    // and the child read is denied even though the Perspective itself is readable.
    const deniedChild = saved.presentationIds[0];
    await assert.rejects(
      adapter.loadPerspective({
        imageId: IMAGE,
        perspectiveId: saved.perspectiveId,
        authorityProvider: readAuthorityProvider(runtime, {deny: new Set([deniedChild])}),
        readBlockId: IDS.readBlockId,
      }),
      (error) => error?.name === 'AuthorityError' && /object\/read/.test(error.message),
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
    images: {}, invocations: {}, executor: {}, authority: {require: () => {}},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    installImageMutationBinding: () => {}, installImageObjectReadBinding: () => {}, installImageObservationBinding: () => {}, findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    objectVersionToken: () => {}, textValue: () => {}, packCompositeValue: () => {}, unpackCompositeValue: () => {}, normalizeTypeDeclarations: () => {}, authorizedReadProject: () => {}, authorizedRenameProject: () => {}, authorizedDescribeSmalltalkClass: () => {}, authorizedDescribeSmalltalkMethod: () => {},
  };
  assert.ok(createImageClientAdapter(good));
  const missing = {...good};
  delete missing.defineClass;
  assert.throws(() => createImageClientAdapter(missing), /missing required helper: defineClass/);
  const noObservation = {...good};
  delete noObservation.installImageObservationBinding;
  assert.throws(() => createImageClientAdapter(noObservation), /missing required helper: installImageObservationBinding/);
  const noProjectRead = {...good};
  delete noProjectRead.authorizedReadProject;
  assert.throws(() => createImageClientAdapter(noProjectRead), /missing required helper: authorizedReadProject/);
  const noProjectRename = {...good};
  delete noProjectRename.authorizedRenameProject;
  assert.throws(() => createImageClientAdapter(noProjectRename), /missing required helper: authorizedRenameProject/);
  // The ADR 0087 native class browsing seam is REQUIRED, not optional: a
  // mis-wired adapter must fail at construction, not at the first browse.
  const noNativeClassBrowse = {...good};
  delete noNativeClassBrowse.authorizedDescribeSmalltalkClass;
  assert.throws(() => createImageClientAdapter(noNativeClassBrowse), /missing required helper: authorizedDescribeSmalltalkClass/);
  const noNativeMethodBrowse = {...good};
  delete noNativeMethodBrowse.authorizedDescribeSmalltalkMethod;
  assert.throws(() => createImageClientAdapter(noNativeMethodBrowse), /missing required helper: authorizedDescribeSmalltalkMethod/);
  const noAuthorityRequire = {...good, authority: {}};
  assert.throws(() => createImageClientAdapter(noAuthorityRequire), /authority service is missing required operation: require/);
});

test('readProject delegates the Images-owned demand unchanged to the injected authority service', async () => {
  const context = Object.freeze({opaque: true});
  const demand = Object.freeze({operation: 'owner/decides', resource: 'owner/opaque'});
  const calls = [];
  const descriptor = Object.freeze({format: 'lagrange-project/v1', projectId: 'p', name: 'P', namespace: null, members: []});
  const client = {
    images: {}, invocations: {}, executor: {},
    authority: {require: (receivedContext, receivedDemand) => calls.push({receivedContext, receivedDemand})},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    installImageMutationBinding: () => {}, installImageObjectReadBinding: () => {}, installImageObservationBinding: () => {}, findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    objectVersionToken: () => {}, textValue: () => {}, packCompositeValue: () => {}, unpackCompositeValue: () => {}, normalizeTypeDeclarations: () => {},
    authorizedRenameProject: () => {},
    authorizedDescribeSmalltalkClass: () => {}, authorizedDescribeSmalltalkMethod: () => {},
    authorizedReadProject: ({images, imageId, projectId, require}) => {
      assert.equal(images, client.images);
      assert.equal(imageId, 'img');
      assert.equal(projectId, 'p');
      require(demand);
      return Object.freeze({descriptor, versionToken: 'tok-owner-opaque'});
    },
  };

  const result = await createImageClientAdapter(client).readProject({
    imageId: 'img', projectId: 'p', authority: context,
  });

  assert.equal(result.descriptor, descriptor, 'the canonical descriptor is returned unchanged');
  assert.equal(result.versionToken, 'tok-owner-opaque', 'the opaque token is returned unchanged (never decoded)');
  assert.deepEqual(Object.keys(result).sort(), ['descriptor', 'versionToken'], 'the Images result shape crosses unchanged');
  assert.deepEqual(calls, [{receivedContext: context, receivedDemand: demand}],
    'the adapter bridges the opaque context and exact owner-created demand only');
});

test('ensureSchema validates its ids eagerly (unit)', async () => {
  const good = {
    images: {}, invocations: {}, executor: {}, authority: {require: () => {}},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    installImageMutationBinding: () => {}, installImageObjectReadBinding: () => {}, installImageObservationBinding: () => {}, findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    objectVersionToken: () => {}, textValue: () => {}, packCompositeValue: () => {}, unpackCompositeValue: () => {}, normalizeTypeDeclarations: () => {}, authorizedReadProject: () => {}, authorizedRenameProject: () => {}, authorizedDescribeSmalltalkClass: () => {}, authorizedDescribeSmalltalkMethod: () => {},
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

// GETOBJECT AUDIT (the invariant of this change): ordinary user-facing reads
// (readProject, readObject, loadPerspective, and by composition
// ObjectNavigator.navigate)
// must NOT use the privileged images.getObject; they cross the authorized
// object/read lane. The only remaining getObject call sites are the
// control-plane/schema reads (trusted host), each explicitly commented. This
// guard makes a regression — a new un-commented privileged read, or one inside
// readProject/readObject/loadPerspective — go red.
test('no ordinary runtime-facing path calls images.getObject directly (audit)', () => {
  const source = readFileSync(resolve(HERE, '../src/image-client-adapter.js'), 'utf8');
  const lines = source.split('\n');
  const getObjectLines = lines
    .map((text, index) => ({text, line: index + 1}))
    .filter(({text}) => text.includes('images.getObject('));
  assert.ok(getObjectLines.length > 0, 'expected the audited control-plane getObject sites to be present');
  for (const {text, line} of getObjectLines) {
    const context = lines.slice(Math.max(0, line - 3), line).join('\n');
    assert.ok(
      context.includes('Control-plane/schema read (trusted host)'),
      `images.getObject at src/image-client-adapter.js:${line} is not marked as a control-plane/schema read`,
    );
  }

  // The user-facing read bodies must not contain a privileged getObject.
  const bodyOf = (name) => {
    const start = source.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\n  (async )?function \w+\(/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  for (const name of ['readProject', 'renameProject', 'authorizedReadObject', 'readObject', 'loadPerspective']) {
    assert.ok(
      !bodyOf(name).includes('images.getObject('),
      `${name} must not call images.getObject; it must cross the authorized object/read lane`,
    );
  }
});

// HISTORY AUDIT (the observation invariant of this change, substrate ADR
// 0070): the user-facing observe() must consume the authorized observation
// lane — NEVER the raw privileged images.history stream, which discloses
// every object's full record with no authority check. The lane's executor
// (substrate-side) is the only authorized history consumer. This guard makes
// a regression — observe()/observePull reaching back to images.history — go
// red, and pins the one place the lane seam is wired.
test('the restricted observation path never calls images.history (audit)', () => {
  const source = readFileSync(resolve(HERE, '../src/image-client-adapter.js'), 'utf8');

  // The whole adapter module must not reference the raw stream at all: the
  // only authorized consumer of history is the substrate-side lane executor.
  assert.ok(
    !source.includes('images.history('),
    'no adapter path may call the raw privileged images.history stream; ' +
    'observation crosses the authorized image-observation-binding/v1 lane',
  );

  // observe() (non-async body) must wire the lane through observePull.
  const observeStart = source.indexOf('function observe(');
  assert.notEqual(observeStart, -1, 'observe must exist');
  const observeRest = source.slice(observeStart);
  const observeNext = observeRest.slice(1).search(/\n  (async )?function \w+\(/);
  const observeBody = observeNext === -1 ? observeRest : observeRest.slice(0, observeNext + 1);
  assert.ok(observeBody.includes('observePull'), 'observe must poll through the authorized lane (observePull)');
  assert.ok(!observeBody.includes('history'), 'observe must not touch the history stream');
});

// ---------------------------------------------------------------------------
// okv Slice B: the version-aware Project bridge (Images ADR 0080 consumed).
// ---------------------------------------------------------------------------

test('renameProject delegates to authorizedRenameProject mapping ONLY the argument name, bridges require, makes ZERO images.* calls, returns the result unchanged (unit)', async () => {
  const context = Object.freeze({opaque: true});
  const demand = Object.freeze({operation: 'owner/decides', resource: 'owner/opaque'});
  const calls = [];
  const imagesCalls = [];
  // Any touch of the images service by renameProject is a violation (the adapter
  // must not fetch, mint, default or validate a token).
  const images = new Proxy({}, {get(_t, prop) { imagesCalls.push(String(prop)); return () => { throw new Error(`renameProject touched images.${String(prop)}`); }; }});
  const client = {
    images, invocations: {}, executor: {},
    authority: {require: (receivedContext, receivedDemand) => calls.push({receivedContext, receivedDemand})},
    defineClass: () => {}, installCallableInterfaceV2: () => {}, installImageCreationBinding: () => {},
    installImageMutationBinding: () => {}, installImageObjectReadBinding: () => {}, installImageObservationBinding: () => {}, findSmalltalkKernel: () => {}, objectRef: () => {}, objectResource: () => {}, parseObjectResource: () => {},
    objectVersionToken: () => {}, textValue: () => {}, packCompositeValue: () => {}, unpackCompositeValue: () => {}, normalizeTypeDeclarations: () => {},
    authorizedReadProject: () => {},
    authorizedDescribeSmalltalkClass: () => {}, authorizedDescribeSmalltalkMethod: () => {},
    authorizedRenameProject: ({images: receivedImages, imageId, projectId, name, expectedVersionToken, require, ...rest}) => {
      assert.equal(receivedImages, images);
      assert.equal(imageId, 'img');
      assert.equal(projectId, 'p');
      assert.equal(name, 'Renamed');
      assert.equal(expectedVersionToken, 'tok-verbatim', 'the Environment versionToken becomes Images expectedVersionToken, verbatim');
      assert.deepEqual(rest, {}, 'no other argument crosses');
      require(demand);
      return Object.freeze({versionToken: 'tok-new-opaque'});
    },
  };
  const result = await createImageClientAdapter(client).renameProject({
    imageId: 'img', projectId: 'p', name: 'Renamed', versionToken: 'tok-verbatim', authority: context,
  });
  assert.deepEqual(result, {versionToken: 'tok-new-opaque'}, 'the Images result is returned unchanged');
  assert.deepEqual(calls, [{receivedContext: context, receivedDemand: demand}], 'require is bridged with the opaque context and the owner-created demand only');
  assert.deepEqual(imagesCalls, [], 'renameProject never touches the images service (no token fetch/default)');
});

// TOKEN-DECODING AUDIT: the Project bridge must never inspect a Project version
// token. The adapter legitimately ships a token decoder for its own createObject
// flow, so this is a BODY-level audit of the two Project seams, not a
// client-surface check.
test('readProject/renameProject bodies never decode, parse or split a version token (audit)', () => {
  const source = readFileSync(resolve(HERE, '../src/image-client-adapter.js'), 'utf8');
  const bodyOf = (name) => {
    const start = source.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\n  (async )?function \w+\(/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  for (const name of ['readProject', 'renameProject']) {
    const body = bodyOf(name);
    for (const needle of ['objectIdFromVersionToken', 'parseObjectResource', "split(':')", 'objectVersionToken(', 'projectObjectId']) {
      assert.ok(!body.includes(needle), `${name} must not contain ${needle}: the adapter never decodes/mints a Project token or names a Project object id`);
    }
  }
});

test('Project bridge against real Images: rename with a fresh token; stale token -> ObjectMutationConflictError -> CommandConflictError via the dispatcher; foreign token -> NOT a conflict; token scope: member add changes it, retarget does not', {skip: !available && 'lagrange-images sibling runtime not available'}, async () => {
  const {runtime, adapter} = await setup();
  const projectId = 'bridge-project';
  await imagesApi.createProject({images: runtime.images, imageId: IMAGE, projectId, name: 'Old'});
  await imagesApi.addProjectMember({
    images: runtime.images, imageId: IMAGE, projectId,
    key: 'm', role: 'source', target: imagesApi.objectRef(IMAGE, 'target-1'),
  });
  const projectResource = imagesApi.objectResource(IMAGE, imagesApi.projectObjectId(projectId));
  const readAuthority = grant(runtime, 'object/read', projectResource);
  const writeAuthority = grant(runtime, 'object/write', projectResource);

  // A successful rename with the token of the current read returns a NEW token;
  // the change is visible only through a fresh authorized read.
  const first = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  const renamed = await adapter.renameProject({imageId: IMAGE, projectId, name: 'New', versionToken: first.versionToken, authority: writeAuthority});
  assert.deepEqual(Object.keys(renamed), ['versionToken'], 'rename returns only the new opaque token (no descriptor: the consumer must reread)');
  assert.notEqual(renamed.versionToken, first.versionToken);
  const second = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  assert.equal(second.descriptor.name, 'New');
  assert.equal(second.versionToken, renamed.versionToken, 'the reread pairs the token the write returned');

  // STALE: the old token now conflicts. The adapter does NOT translate (raw
  // Images error); the existing dispatcher owner maps it to CommandConflictError.
  await assert.rejects(
    adapter.renameProject({imageId: IMAGE, projectId, name: 'Stale', versionToken: first.versionToken, authority: writeAuthority}),
    (error) => error?.name === 'ObjectMutationConflictError',
    'the adapter surfaces Images own conflict error untranslated',
  );
  const {createCommandDispatcher} = await import('../src/command-dispatcher.js');
  const dispatcher = createCommandDispatcher({image: ({command, subject, authority, context}) => command.invoke(subject, {...context, authority, adapter})});
  const renameCommand = new Command({
    id: 'rename-project-probe', title: 'rename', applies: (subject) => subject?.kind === 'project',
    invoke: (subject, {adapter: a, authority, text, versionToken}) => a.renameProject({imageId: subject.imageId, projectId: subject.projectId, name: text, versionToken, authority}),
  });
  const subject = {kind: 'project', imageId: IMAGE, projectId};
  await assert.rejects(
    dispatcher.dispatch({command: renameCommand, subject, authority: writeAuthority, context: {text: 'Stale', versionToken: first.versionToken}}),
    (error) => error?.name === 'CommandConflictError',
    'CommandDispatcher (the existing error owner) maps the stale conflict',
  );
  // FOREIGN token (well-formed, scoped to another object): NOT a conflict — Images
  // rejects it before authorization as ObjectVersionTokenError; the dispatcher
  // reports it as an execution error. A translator that treated every token
  // failure as a conflict would fail here.
  const foreign = imagesApi.objectVersionToken(IMAGE, 'some-other-object', 0);
  await assert.rejects(
    adapter.renameProject({imageId: IMAGE, projectId, name: 'X', versionToken: foreign, authority: writeAuthority}),
    (error) => error?.name === 'ObjectVersionTokenError',
  );
  await assert.rejects(
    dispatcher.dispatch({command: renameCommand, subject, authority: writeAuthority, context: {text: 'X', versionToken: foreign}}),
    (error) => error?.name === 'CommandExecutionError',
    'a foreign token is not a conflict',
  );
  assert.equal((await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority})).descriptor.name, 'New', 'neither failed rename changed the Project');

  // DENIED write: no rename, AuthorityError (with a well-formed current token,
  // because Images checks the token shape before authority).
  await assert.rejects(
    adapter.renameProject({imageId: IMAGE, projectId, name: 'Denied', versionToken: second.versionToken, authority: readAuthority}),
    (error) => error?.name === 'AuthorityError',
  );

  // TOKEN SCOPE (a consumed-contract characterization; Images ADR 0080 owns the
  // rule): the token describes the Project OBJECT. A member ADD rewrites its
  // linkage -> new token; a member RETARGET (same key + role) rewrites the member
  // record only -> same token while the descriptor changed.
  const beforeAdd = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE, projectId, key: 'n', role: 'lib', target: imagesApi.objectRef(IMAGE, 'target-2')});
  const afterAdd = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  assert.notEqual(afterAdd.versionToken, beforeAdd.versionToken, 'member add changes the Project token');
  assert.equal(afterAdd.descriptor.members.length, 2);
  await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE, projectId, key: 'n', role: 'lib', target: imagesApi.objectRef(IMAGE, 'target-3')});
  const afterRetarget = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  assert.equal(afterRetarget.versionToken, afterAdd.versionToken, 'member retarget does NOT change the Project token (the member record changed, not the Project object)');
  assert.equal(afterRetarget.descriptor.members.find((m) => m.key === 'n').target.objectId, 'target-3', '…while the descriptor did change');
  const again = await adapter.readProject({imageId: IMAGE, projectId, authority: readAuthority});
  assert.equal(again.versionToken, afterRetarget.versionToken, 'two reads with no write yield the same token');
  await runtime.close();
});
