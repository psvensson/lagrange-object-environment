import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createThemeResolver, ThemeResolutionError, createEnvironmentProvisioner} from '../src/index.js';
import {createImageClientAdapter, createImageProvisioningPort} from '../src/image-client-adapter.js';

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
} catch (error) { loadError = error; }
const integration = {skip: loadError && 'pinned Images public graph entry unavailable'};
const IMAGE = 'theme-resolution';
const THEME = 'environment/themes/smalltalk-workbench/v1';
const BLOCK = 'theme-reader';
const ref = objectId => ({kind: 'ref', imageId: IMAGE, objectId});
const text = value => ({kind: 'text', value});
const integer = value => ({kind: 'integer', value: String(value)});
const stockToken = path => `${THEME}/tokens/${path}`;
// Independent expected release values, not imported from resolver/provisioner.
const STOCK = [
  ['accent', 'color', '#245a81'], ['focus', 'color', '#b45a16'], ['radius.normal', 'dimension', 0],
  ['selection.background', 'color', '#245a81'], ['selection.text', 'color', '#ffffff'],
  ['spacing.compact', 'dimension', 2], ['spacing.normal', 'dimension', 6],
  ['surface.base', 'color', '#e6e6e2'], ['surface.raised', 'color', '#f5f5f0'],
  ['text.muted', 'color', '#56616a'], ['text.primary', 'color', '#1c2428'],
  ['typography.code.family', 'fontFamily', 'monospace'], ['typography.code.size', 'fontSize', 13],
  ['typography.ui.family', 'fontFamily', 'sans-serif'], ['typography.ui.size', 'fontSize', 13],
].map(([path, type, value]) => ({path, type, value}));

async function setup(t, provision = true) {
  const runtime = await api.createRuntime({backend: {mode: 'mock'}});
  t.after(() => runtime.close());
  await runtime.images.createImage({id: IMAGE});
  if (provision) await createEnvironmentProvisioner(createImageProvisioningPort({...api, ...graph,
    images: runtime.images})).provision({imageId: IMAGE});
  // Public generic object-read binding; no Smalltalk kernel or private APIs.
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
  const callable = await api.installCallableInterfaceV2({images: runtime.images, imageId: IMAGE,
    interfaceId: 'theme-reader-interface', functionName: 'read-object', parameters: ['string'],
    result: 'object-read-result', types});
  await api.installImageObjectReadBinding({images: runtime.images, callableInterface: ref(callable.id),
    bindingId: 'theme-reader-binding', blockId: BLOCK});
  const adapter = createImageClientAdapter({...api, ...runtime});
  const calls = [];
  const errors = [];
  const resolver = createThemeResolver({async readObject(request) {
    calls.push(request);
    try { return await adapter.readObject(request); }
    catch (error) { errors.push(error); throw error; }
  }});
  const authorityFor = ids => runtime.authority.issue({principal: 'theme-reader',
    grants: ids.map(id => ({operation: 'object/read', resource: api.objectResource(IMAGE, id)}))});
  const allAuthority = async (except = []) => authorityFor((await runtime.images.listRecords(IMAGE))
    .map(record => record.id).filter(id => !except.includes(id)));
  const snapshot = async () => (await runtime.images.listRecords(IMAGE)).sort((a, b) => a.id < b.id ? -1 : 1);
  return {runtime, adapter, resolver, calls, errors, authorityFor, allAuthority, snapshot};
}

async function putToken(runtime, id, path, type, value) {
  await runtime.images.putObject(IMAGE, {id, shape: ref('environment/shapes/design-token/v1'), slots: {
    format: text('environment-design-token/v1'), path: text(path), type: text(type), value,
  }});
}

async function putTheme(runtime, id, base, tokens) {
  await runtime.images.putObject(IMAGE, {id,
    shape: ref(`environment/shapes/${base === null ? 'root' : 'derived'}-theme/v1`),
    slots: {format: text(`environment-theme/${base === null ? 'root' : 'derived'}/v1`), name: text(id),
      ...(base === null ? {} : {baseTheme: ref(base)})}, indexed: tokens.map(ref),
  });
}

async function resolveUnchanged(f, themeId = THEME, authority) {
  const before = await f.snapshot();
  try {
    return await f.resolver.resolve({themeRef: ref(themeId), authority: authority ?? await f.allAuthority(), blockId: BLOCK});
  } finally { assert.deepEqual(await f.snapshot(), before, 'resolution changes no records or stored versions'); }
}

test('Theme resolver integration requires pinned Images in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('stock resolution uses only authorized projections and produces complete immutable semantic values', integration, async t => {
  const f = await setup(t);
  const authority = await f.allAuthority();
  const resolved = await resolveUnchanged(f, THEME, authority);
  assert.deepEqual(resolved, {themeRef: ref(THEME), tokens: STOCK});
  assert.deepEqual(f.calls.map(call => call.objectId), [THEME, ...STOCK.map(token => stockToken(token.path))]);
  for (const call of f.calls) {
    assert.equal(call.authority, authority);
    assert.equal(call.blockId, BLOCK);
    assert.equal(call.imageId, IMAGE);
  }
  for (const value of [resolved, resolved.themeRef, resolved.tokens, ...resolved.tokens]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { resolved.tokens[0].value = '#ffffff'; }, TypeError);
  assert.equal('versionToken' in resolved, false);
  assert.deepEqual(Object.keys(resolved), ['themeRef', 'tokens']);
});

test('nearest overrides win, unrelated paths survive, shared refs stay authorized and fresh calls reread', integration, async t => {
  const f = await setup(t);
  await putToken(f.runtime, 'base/accent', 'accent', 'color', text('#112233'));
  await putToken(f.runtime, 'child/accent', 'accent', 'color', text('#445566'));
  await putToken(f.runtime, 'base/spacing', 'spacing.normal', 'dimension', integer(3));
  await putTheme(f.runtime, 'base', THEME, ['base/accent', 'base/spacing']);
  await putTheme(f.runtime, 'child', 'base', ['child/accent', stockToken('focus')]);
  const resolved = await resolveUnchanged(f, 'child');
  const expected = STOCK.map(token => ({...token,
    value: token.path === 'accent' ? '#445566' : token.path === 'spacing.normal' ? 3 : token.value}));
  assert.deepEqual(resolved.tokens, expected);
  assert.equal(f.calls.filter(call => call.objectId === stockToken('focus')).length, 2,
    'shared child refs do not bypass authorized traversal');
  // The intentional fixture mutation is outside the write-free snapshot pair.
  await putToken(f.runtime, 'child/accent', 'accent', 'color', text('#778899'));
  f.calls.length = 0;
  const reread = await resolveUnchanged(f, 'child');
  assert.equal(reread.tokens.find(token => token.path === 'accent').value, '#778899');
  assert.equal(resolved.tokens.find(token => token.path === 'accent').value, '#445566');
  assert.ok(f.calls.some(call => call.objectId === 'child/accent'));
});

for (const denied of ['base', 'base/accent']) {
  test(`denied ${denied} fails the whole graph even behind a complete child override`, integration, async t => {
    const f = await setup(t);
    await putToken(f.runtime, 'base/accent', 'accent', 'color', text('#112233'));
    await putTheme(f.runtime, 'base', THEME, ['base/accent']);
    await putTheme(f.runtime, 'child', 'base', STOCK.map(token => stockToken(token.path)));
    await assert.rejects(resolveUnchanged(f, 'child', await f.allAuthority([denied])), error => {
      assert.equal(error, f.errors.at(-1));
      assert.equal(error.name, 'AuthorityError');
      return true;
    });
    assert.equal(f.calls.at(-1).objectId, denied);
  });
}

test('an authorized missing Theme fails unchanged without creating defaults', integration, async t => {
  const f = await setup(t, false);
  await assert.rejects(resolveUnchanged(f, THEME, f.authorityFor([THEME])), error => {
    assert.equal(error, f.errors.at(-1));
    assert.ok(error instanceof TypeError);
    return true;
  });
  assert.deepEqual(f.calls.map(call => call.objectId), [THEME]);
  assert.equal(await f.runtime.images.getRecord(IMAGE, 'environment/catalog'), undefined);
});

test('a valid graph missing a required token fails with no stock-value fill', integration, async t => {
  const f = await setup(t);
  await putTheme(f.runtime, 'incomplete', null, STOCK.filter(token => token.path !== 'focus').map(token => stockToken(token.path)));
  await assert.rejects(resolveUnchanged(f, 'incomplete'), {name: 'ThemeResolutionError', message: 'Theme is missing required token paths'});
  assert.equal(f.calls.some(call => call.objectId === THEME || call.objectId === stockToken('focus')), false);
});

test('inheritance cycles fail before repeating an object read', integration, async t => {
  const f = await setup(t);
  await putTheme(f.runtime, 'a', 'b', []);
  await putTheme(f.runtime, 'b', 'a', []);
  await assert.rejects(resolveUnchanged(f, 'a'), /Theme inheritance cycle/);
  assert.deepEqual(f.calls.map(call => call.objectId), ['a', 'b']);
});

for (const duplicate of ['ref', 'path']) {
  test(`duplicate token ${duplicate} fails within one Theme`, integration, async t => {
    const f = await setup(t);
    await putToken(f.runtime, 'other-accent', 'accent', 'color', text('#112233'));
    await putTheme(f.runtime, 'duplicates', THEME, [stockToken('accent'),
      duplicate === 'ref' ? stockToken('accent') : 'other-accent']);
    await assert.rejects(resolveUnchanged(f, 'duplicates'), new RegExp(`Duplicate token ${duplicate}`));
  });
}

const invalidTokens = [
  ['incompatible type', 'accent', 'dimension', integer(1)],
  ['unknown path', 'css.background', 'color', text('#112233')],
  ['uppercase color', 'accent', 'color', text('#AABBCC')],
  ['alpha color', 'accent', 'color', text('#11223344')],
  ['wrong Value kind', 'spacing.normal', 'dimension', text('3')],
  ['negative dimension', 'spacing.normal', 'dimension', integer(-1)],
  ['unsafe integer', 'spacing.normal', 'dimension', integer('9007199254740992')],
  ['zero font size', 'typography.code.size', 'fontSize', integer(0)],
  ['unsupported family', 'typography.code.family', 'fontFamily', text('custom font')],
];
for (const [name, path, type, value] of invalidTokens) {
  test(`${name} fails even when a child shadows the invalid base token`, integration, async t => {
    const f = await setup(t);
    await putToken(f.runtime, 'invalid', path, type, value);
    await putTheme(f.runtime, 'base', THEME, ['invalid']);
    await putTheme(f.runtime, 'child', 'base', STOCK.map(token => stockToken(token.path)));
    await assert.rejects(resolveUnchanged(f, 'child'), ThemeResolutionError);
    assert.ok(f.calls.some(call => call.objectId === 'invalid'));
  });
}

test('malformed projections and graph refs fail without interpreting opaque version tokens', integration, async t => {
  const f = await setup(t);
  const authority = await f.allAuthority();
  for (const corrupt of [
    record => ({...record, kind: 'object'}),
    record => ({...record, slots: {...record.slots, extra: text('unexpected')}}),
    record => ({...record, slots: {...record.slots, format: text('environment-theme/unknown')}}),
    record => ({...record, indexed: [{...ref('x'), imageId: 'elsewhere'}]}),
    record => ({...record, indexed: [{...ref('x'), revision: '1'}]}),
    record => ({...record, indexed: [{...ref('x'), kind: 'pinned-ref', revision: '1'}]}),
    record => ({...record, indexed: null}),
  ]) {
    const tested = createThemeResolver({async readObject(request) { return corrupt(await f.adapter.readObject(request)); }});
    await assert.rejects(tested.resolve({themeRef: ref(THEME), authority, blockId: BLOCK}), ThemeResolutionError);
  }
  const opaque = new Proxy({}, {get() { throw new Error('opaque token was inspected'); }});
  const tested = createThemeResolver({async readObject(request) {
    return {...await f.adapter.readObject(request), versionToken: opaque};
  }});
  assert.deepEqual((await tested.resolve({themeRef: ref(THEME), authority, blockId: BLOCK})).tokens, STOCK);
});

test('invalid caller refs are refused before any read', async () => {
  let reads = 0;
  const resolver = createThemeResolver({readObject() { reads++; }});
  for (const themeRef of [null, {}, {...ref('x'), kind: 'pinned-ref'}, {...ref('x'), objectId: ''}, {...ref('x'), revision: '1'}]) {
    await assert.rejects(resolver.resolve({themeRef}), ThemeResolutionError);
  }
  assert.equal(reads, 0);
  assert.throws(() => createThemeResolver(), TypeError);
});
