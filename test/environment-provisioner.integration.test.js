import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createEnvironmentProvisioner, Session} from '../src/index.js';
import {createImageProvisioningPort, createImageClientAdapter} from '../src/image-client-adapter.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createObjectNavigator} from '../src/object-navigator.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {createObjectInspectorProvider} from '../src/object-presentation-providers.js';
import {createSelectionModel} from '../src/selection-model.js';
import {createCompositor} from '../src/compositor.js';

const runtimeUrl = process.env.LAGRANGE_IMAGES_URL
  ?? new URL('../../lagrange-images/src/runtime.js', import.meta.url).href;
let api;
let graph;
let loadError;
try {
  api = await import(runtimeUrl);
  const root = new URL('../', runtimeUrl);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(typeof manifest.exports?.['./graph'], 'string');
  graph = await import(new URL(manifest.exports['./graph'], root).href);
  for (const name of ['provisionObject', 'provisionShape', 'ProvisioningConflictError']) {
    assert.equal(typeof graph[name], 'function');
  }
} catch (error) {
  loadError = error;
}
const integration = {skip: loadError && 'pinned Images public graph entry unavailable'};
const IMAGE = 'theme-installation';
const CATALOG = 'environment/catalog';
const THEME = 'environment/themes/smalltalk-workbench/v1';
const SHAPES = [
  ['environment/shapes/catalog/v1', ['format', 'defaultTheme'], 'values'],
  ['environment/shapes/root-theme/v1', ['format', 'name'], 'values'],
  ['environment/shapes/design-token/v1', ['format', 'path', 'type', 'value'], 'none'],
  ['environment/shapes/derived-theme/v1', ['format', 'name', 'baseTheme'], 'values'],
];
// Independent release oracle: no schema, stock list or ids imported from the SUT.
const TOKENS = [
  ['accent', 'color', 'text', '#245a81'],
  ['focus', 'color', 'text', '#b45a16'],
  ['radius.normal', 'dimension', 'integer', '0'],
  ['selection.background', 'color', 'text', '#245a81'],
  ['selection.text', 'color', 'text', '#ffffff'],
  ['spacing.compact', 'dimension', 'integer', '2'],
  ['spacing.normal', 'dimension', 'integer', '6'],
  ['surface.base', 'color', 'text', '#e6e6e2'],
  ['surface.raised', 'color', 'text', '#f5f5f0'],
  ['text.muted', 'color', 'text', '#56616a'],
  ['text.primary', 'color', 'text', '#1c2428'],
  ['typography.code.family', 'fontFamily', 'text', 'monospace'],
  ['typography.code.size', 'fontSize', 'integer', '13'],
  ['typography.ui.family', 'fontFamily', 'text', 'sans-serif'],
  ['typography.ui.size', 'fontSize', 'integer', '13'],
];
const tokenId = path => `${THEME}/tokens/${path}`;
const objectIds = [CATALOG, THEME, ...TOKENS.map(([path]) => tokenId(path))];
const ref = objectId => ({kind: 'ref', imageId: IMAGE, objectId});
const text = value => ({kind: 'text', value});

async function setup(t) {
  const runtime = await api.createRuntime({backend: {mode: 'mock'}});
  t.after(() => runtime.close());
  await runtime.images.createImage({id: IMAGE});
  const port = createImageProvisioningPort({...api, ...graph, images: runtime.images});
  return {runtime, port, provisioner: createEnvironmentProvisioner(port)};
}

async function snapshot(images) {
  return (await images.listRecords(IMAGE)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function objectInput(record) {
  return {id: record.id, shape: record.shape, slots: record.slots,
    ...(Object.hasOwn(record, 'indexed') ? {indexed: record.indexed} : {})};
}

function assertGraph(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  assert.deepEqual([...byId.keys()].sort(), [...SHAPES.map(([id]) => id), ...objectIds].sort());
  for (const [id, slots, indexed] of SHAPES) {
    const record = byId.get(id);
    assert.equal(record.kind, 'shape');
    assert.equal(record.imageId, IMAGE);
    assert.deepEqual(record.slots, slots.map(name => ({id: name, name})));
    assert.equal(record.indexed, indexed);
  }
  for (const [path, type, kind, value] of TOKENS) {
    const record = byId.get(tokenId(path));
    assert.equal(record.kind, 'object');
    assert.equal(record.behavior, null);
    assert.deepEqual(record.shape, ref(SHAPES[2][0]));
    assert.deepEqual(record.slots, {
      format: text('environment-design-token/v1'), path: text(path), type: text(type), value: {kind, value},
    });
    assert.equal(Object.hasOwn(record, 'indexed'), false);
  }
  const theme = byId.get(THEME);
  assert.deepEqual(theme.shape, ref(SHAPES[1][0]));
  assert.equal(theme.behavior, null);
  assert.deepEqual(theme.slots, {format: text('environment-theme/root/v1'), name: text('Smalltalk Workbench')});
  assert.deepEqual(theme.indexed, TOKENS.map(([path]) => ref(tokenId(path))), 'lexical path order is durable');
  const catalog = byId.get(CATALOG);
  assert.deepEqual(catalog.shape, ref(SHAPES[0][0]));
  assert.equal(catalog.behavior, null);
  assert.deepEqual(catalog.slots, {format: text('environment-catalog/v1'), defaultTheme: ref(THEME)});
  assert.deepEqual(catalog.indexed, [ref(THEME)]);
}

async function installReader(runtime) {
  // Direct public read-binding installation: no ensureSchema, kernel or class.
  const types = api.normalizeTypeDeclarations({
    'slot-value': {kind: 'record', fields: [{name: 'value', type: 'string'}]},
    'slot-entry': {kind: 'record', fields: [{name: 'name', type: 'string'}, {name: 'value', type: 'slot-value'}]},
    'object-record': {kind: 'record', fields: [
      {name: 'slots', type: {kind: 'list', element: 'slot-entry'}},
      {name: 'indexed', type: {kind: 'list', element: 'slot-value'}},
    ]},
    'object-read-result': {kind: 'record', fields: [
      {name: 'version-token', type: 'string'}, {name: 'value', type: 'object-record'},
    ]},
  });
  const callable = await api.installCallableInterfaceV2({
    images: runtime.images, imageId: IMAGE, interfaceId: 'theme-object-read-interface',
    functionName: 'read-object', parameters: ['string'], result: 'object-read-result', types,
  });
  await api.installImageObjectReadBinding({
    images: runtime.images, callableInterface: api.objectRef(IMAGE, callable.id),
    bindingId: 'theme-object-read-binding', blockId: 'theme-object-read-block',
  });
  const adapter = createImageClientAdapter({...api, ...runtime});
  const reader = await adapter.bindObjectRead({imageId: IMAGE, blockId: 'theme-object-read-block'});
  return {adapter, reader};
}

const authorityFor = (runtime, ids) => runtime.authority.issue({
  principal: 'theme-reader',
  grants: ids.map(id => ({operation: 'object/read', resource: api.objectResource(IMAGE, id)})),
});

function assertNoProvisioning(surface) {
  const names = new Set([...Object.keys(surface), ...Object.getOwnPropertyNames(Object.getPrototypeOf(surface) ?? {})]);
  assert.deepEqual([...names].filter(name => /provision/i.test(name)), []);
}

test('Theme integration requires the pinned public Images surface in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('kernel-free stock graph, complete write-free replay, and ordinary per-object authorized access', integration, async t => {
  const {runtime, provisioner} = await setup(t);
  const locator = await provisioner.provision({imageId: IMAGE});
  assert.deepEqual(locator, {imageId: IMAGE, objectId: CATALOG});
  assert.equal(Object.isFrozen(locator), true);
  const before = await snapshot(runtime.images);
  assertGraph(before);
  const versions = objectIds.map(id => api.objectVersionToken(IMAGE, id, before.find(record => record.id === id)._version));
  await provisioner.provision({imageId: IMAGE});
  assert.deepEqual(await snapshot(runtime.images), before, 'every stored field/version, including Shapes, remains unchanged');
  for (const [i, id] of objectIds.entries()) {
    const record = await runtime.images.getObject(IMAGE, id);
    assert.equal(api.objectVersionToken(IMAGE, id, record._version), versions[i]);
  }
  const {adapter, reader} = await installReader(runtime);
  for (const id of objectIds) {
    const read = await reader.read({objectId: id, authority: authorityFor(runtime, [id])});
    const stored = before.find(record => record.id === id);
    assert.deepEqual(read, {slots: stored.slots, indexed: stored.indexed ?? [], versionToken: versions[objectIds.indexOf(id)]});
  }
  const denied = tokenId('text.primary');
  const authority = authorityFor(runtime, objectIds.filter(id => id !== denied));
  await reader.read({objectId: THEME, authority});
  await assert.rejects(reader.read({objectId: denied, authority}), {name: 'AuthorityError'}, 'a readable parent ref does not authorize a child');

  const beforeSession = await snapshot(runtime.images);
  const session = new Session({principal: 'theme-reader'});
  const registry = createPresentationRegistry();
  registry.register(createObjectInspectorProvider());
  const navigator = createObjectNavigator({adapter, presentationRegistry: registry,
    commandRegistry: createCommandRegistry(), referencesOfValue: api.referencesOfValue});
  const renderer = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter: renderer});
  t.after(() => compositor.destroy());
  const shell = createEnvironmentShell({navigator, selectionModel: createSelectionModel(), compositor});
  await shell.openWorkspace(ref(CATALOG), {authority, readBlockId: 'theme-object-read-block'});
  for (const surface of [adapter, reader, session, renderer, shell]) assertNoProvisioning(surface);
  assert.deepEqual(await snapshot(runtime.images), beforeSession, 'ordinary opening creates no shared defaults or profiles');
});

test('ordinary startup in an unprovisioned image leaves shared defaults absent', integration, async t => {
  const {runtime} = await setup(t);
  await runtime.images.putShape(IMAGE, {id: 'ordinary-shape', slots: [{id: 'title', name: 'title'}]});
  await runtime.images.putObject(IMAGE, {id: 'ordinary-root', shape: ref('ordinary-shape'),
    slots: {title: text('Existing user object')}});
  const {adapter, reader} = await installReader(runtime);
  const before = await snapshot(runtime.images);
  assert.equal(await runtime.images.getRecord(IMAGE, CATALOG), undefined);
  const session = new Session({principal: 'theme-reader'});
  const registry = createPresentationRegistry();
  registry.register(createObjectInspectorProvider());
  const navigator = createObjectNavigator({adapter, presentationRegistry: registry,
    commandRegistry: createCommandRegistry(), referencesOfValue: api.referencesOfValue});
  const renderer = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter: renderer});
  t.after(() => compositor.destroy());
  const shell = createEnvironmentShell({navigator, selectionModel: createSelectionModel(), compositor});
  await shell.openWorkspace(ref('ordinary-root'), {
    authority: authorityFor(runtime, ['ordinary-root']), readBlockId: 'theme-object-read-block',
  });
  assert.equal(compositor.durableIntent().find(view => view.viewId === 'inspector-view')
    .presentationDescriptor.subject.objectId, 'ordinary-root', 'ordinary opening succeeds');
  for (const surface of [adapter, reader, session, renderer, shell]) assertNoProvisioning(surface);
  assert.deepEqual(await snapshot(runtime.images), before, 'startup must not create defaults even when absent');
  assert.equal(await runtime.images.getRecord(IMAGE, CATALOG), undefined);
});

test('upgrading the T1 graph adds only the derived Shape and preserves all old records', integration, async t => {
  const {runtime, port, provisioner} = await setup(t);
  const derivedId = 'environment/shapes/derived-theme/v1';
  // Reproduce the previous release through the same public installation port.
  await createEnvironmentProvisioner({...port, provisionShape(request) {
    return request.shape.id === derivedId ? undefined : port.provisionShape(request);
  }}).provision({imageId: IMAGE});
  const before = await snapshot(runtime.images);
  assert.equal(before.some(record => record.id === derivedId), false);
  await provisioner.provision({imageId: IMAGE});
  const after = await snapshot(runtime.images);
  assert.equal(after.length, before.length + 1);
  for (const record of before) assert.deepEqual(after.find(item => item.id === record.id), record);
  assertGraph(after);
  await provisioner.provision({imageId: IMAGE});
  assert.deepEqual(await snapshot(runtime.images), after);
});

for (const conflictKind of ['Shape', 'derived Shape', 'token']) {
  test(`a conflicting stock ${conflictKind} propagates the exact public conflict and preserves the occupant`, integration, async t => {
    const {runtime, port, provisioner} = await setup(t);
    const id = conflictKind === 'token' ? tokenId('accent') : SHAPES[conflictKind === 'Shape' ? 2 : 3][0];
    if (conflictKind !== 'token') {
      // Shapes are immutable: create the conflicting layout before installation.
      for (const [shapeId, names, indexed] of SHAPES) {
        await runtime.images.putShape(IMAGE, {id: shapeId, indexed,
          slots: names.map(name => ({id: name, name: shapeId === id ? `${name}-changed` : name}))});
      }
    } else {
      await provisioner.provision({imageId: IMAGE});
      const old = await runtime.images.getRecord(IMAGE, id);
      await runtime.images.putObject(IMAGE, {...objectInput(old), slots: {...old.slots, value: text('#000000')}});
    }
    const before = await snapshot(runtime.images);
    let lowerError;
    const capture = operation => async request => {
      try { return await operation(request); } catch (error) { lowerError = error; throw error; }
    };
    const tested = createEnvironmentProvisioner({...port,
      provisionShape: capture(port.provisionShape), provisionObject: capture(port.provisionObject)});
    await assert.rejects(tested.provision({imageId: IMAGE}), error => {
      assert.equal(error, lowerError);
      assert.ok(error instanceof graph.ProvisioningConflictError);
      assert.equal(error.objectId, id);
      return true;
    });
    assert.deepEqual(await snapshot(runtime.images), before);
  });
}

test('a pre-write interruption leaves a partial graph that resumes without rewriting earlier records', integration, async t => {
  const {runtime, port, provisioner} = await setup(t);
  const interrupted = new Error('controlled pre-write interruption');
  let calls = 0;
  const firstAttempt = createEnvironmentProvisioner({...port, provisionObject(request) {
    if (++calls === 5) throw interrupted;
    return port.provisionObject(request);
  }});
  await assert.rejects(firstAttempt.provision({imageId: IMAGE}), error => error === interrupted);
  const partial = await snapshot(runtime.images);
  assert.equal(partial.length, 8, 'four Shapes and four Tokens, no catalog or root');
  assert.equal(await runtime.images.getRecord(IMAGE, CATALOG), undefined);
  assert.equal(await runtime.images.getRecord(IMAGE, THEME), undefined);
  await provisioner.provision({imageId: IMAGE});
  const complete = await snapshot(runtime.images);
  assertGraph(complete);
  for (const old of partial) assert.deepEqual(complete.find(record => record.id === old.id), old);
});

test('a deliberate catalog default and stock-list change survive installation without dereferencing the default', integration, async t => {
  const {runtime, provisioner} = await setup(t);
  await provisioner.provision({imageId: IMAGE});
  const catalog = await runtime.images.getObject(IMAGE, CATALOG);
  // The target is deliberately absent: availability belongs to authorized resolution.
  await runtime.images.putObject(IMAGE, {...objectInput(catalog),
    slots: {...catalog.slots, defaultTheme: ref('personal/theme')},
    indexed: [ref('another/stock-theme'), ref(THEME)],
  });
  const before = await snapshot(runtime.images);
  await provisioner.provision({imageId: IMAGE});
  assert.deepEqual(await snapshot(runtime.images), before);
});

const invalidCatalogs = [
  ['wrong Shape', record => ({...record, shape: ref('different-catalog-shape')})],
  ['wrong marker', record => ({...record, slots: {...record.slots, format: text('environment-catalog/v2')}})],
  ['non-ref default', record => ({...record, slots: {...record.slots, defaultTheme: text(THEME)}})],
  ['cross-image default', record => ({...record, slots: {...record.slots, defaultTheme: {...ref(THEME), imageId: 'elsewhere'}}})],
  ['pinned default', record => ({...record, slots: {...record.slots, defaultTheme: {kind: 'pinned-ref', imageId: IMAGE, objectId: THEME, revision: '1'}}})],
  ['non-ref indexed entry', record => ({...record, indexed: [text(THEME)]})],
  ['cross-image indexed entry', record => ({...record, indexed: [{...ref(THEME), imageId: 'elsewhere'}]})],
  ['pinned indexed entry', record => ({...record, indexed: [{kind: 'pinned-ref', imageId: IMAGE, objectId: THEME, revision: '1'}]})],
];
for (const [name, corrupt] of invalidCatalogs) {
  test(`catalog ${name} refuses without overwriting the stored occupant`, integration, async t => {
    const {runtime, provisioner} = await setup(t);
    await provisioner.provision({imageId: IMAGE});
    await runtime.images.putShape(IMAGE, {id: 'different-catalog-shape',
      slots: [{id: 'format', name: 'format'}, {id: 'defaultTheme', name: 'defaultTheme'}], indexed: 'values'});
    await runtime.images.putObject(IMAGE, corrupt(objectInput(await runtime.images.getObject(IMAGE, CATALOG))));
    const before = await snapshot(runtime.images);
    await assert.rejects(provisioner.provision({imageId: IMAGE}), /invalid EnvironmentCatalog/);
    assert.deepEqual(await snapshot(runtime.images), before);
  });
}

test('a different record kind at the catalog id refuses without replacing it', integration, async t => {
  const {runtime, provisioner} = await setup(t);
  await runtime.images.putShape(IMAGE, {id: CATALOG, slots: []});
  const occupant = await runtime.images.getRecord(IMAGE, CATALOG);
  await assert.rejects(provisioner.provision({imageId: IMAGE}));
  assert.deepEqual(await runtime.images.getRecord(IMAGE, CATALOG), occupant);
});

test('catalog validation rejects malformed port records without attempting to repair them', integration, async t => {
  const {runtime, port, provisioner} = await setup(t);
  await provisioner.provision({imageId: IMAGE});
  const before = await snapshot(runtime.images);
  // Public storage already rejects noncanonical Values or mismatched slots. These
  // seam controls exercise the domain validator without corrupting lower storage.
  for (const corrupt of [
    record => ({...record, slots: {...record.slots, extra: text('unexpected')}}),
    record => ({...record, slots: {format: record.slots.format}}),
    record => ({...record, slots: {...record.slots, defaultTheme: {...ref(THEME), objectId: ''}}}),
    record => ({...record, slots: {...record.slots, defaultTheme: {...ref(THEME), revision: '1'}}}),
    record => ({...record, indexed: null}),
  ]) {
    const tested = createEnvironmentProvisioner({...port, async provisionObject(request) {
      const stored = await port.provisionObject(request);
      return request.object.id === CATALOG ? corrupt(stored) : stored;
    }});
    await assert.rejects(tested.provision({imageId: IMAGE}), /invalid EnvironmentCatalog/);
    assert.deepEqual(await snapshot(runtime.images), before);
  }
});
