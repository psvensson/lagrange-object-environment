import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {
  Session, createThemeResolver, ThemeResolutionError, createEnvironmentProvisioner,
  createFakeRendererAdapter, createSessionThemeLifecycle,
} from '../src/index.js';
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
const OBSERVATION_BLOCK = 'theme-observer';
const SECOND_BINDINGS = Object.freeze({blockId: 'other-theme-reader', observationBlockId: 'other-theme-observer'});
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

async function setup(t, provision = true, withObservation = false, extraBindings = []) {
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
  const bindings = [{blockId: BLOCK, observationBlockId: OBSERVATION_BLOCK}, ...extraBindings];
  for (const [index, binding] of bindings.entries()) {
    await api.installImageObjectReadBinding({images: runtime.images, callableInterface: ref(callable.id),
      bindingId: 'theme-reader-binding' + (index ? '/' + index : ''), blockId: binding.blockId});
  }
  if (withObservation) {
    // Public Images ADR 0070 observation binding. The Theme owner consumes
    // this SAME authorized lane as the generic EnvironmentShell/ProjectBrowser,
    // never an image.history read or separate Theme watch channel.
    const obsTypes = api.normalizeTypeDeclarations({
      'obs-event': {kind: 'record', fields: [
        {name: 'object-id', type: 'string'}, {name: 'kind', type: 'string'},
        {name: 'cursor', type: 'string'},
      ]},
      'obs-result': {kind: 'record', fields: [
        {name: 'events', type: {kind: 'list', element: 'obs-event'}},
        {name: 'cursor', type: 'string'},
      ]},
    });
    const obs = await api.installCallableInterfaceV2({images: runtime.images, imageId: IMAGE,
      interfaceId: 'theme-observer-interface', functionName: 'observe',
      parameters: ['string'], result: 'obs-result', types: obsTypes});
    for (const [index, binding] of bindings.entries()) {
      await api.installImageObservationBinding({images: runtime.images, imageId: IMAGE,
        callableInterface: ref(obs.id), bindingId: 'theme-observer-binding' + (index ? '/' + index : ''),
        blockId: binding.observationBlockId});
    }
  }
  const adapter = createImageClientAdapter({...api, ...runtime});
  const calls = [];
  const errors = [];
  const observationCalls = [];
  const consumedChanges = [];
  const resolver = createThemeResolver({
    observe(imageId, options) {
      observationCalls.push({kind: 'follow', imageId, ...options});
      return {async *[Symbol.asyncIterator]() {
        for await (const change of adapter.observe(imageId, options)) {
          yield change;
          // The consumer requests the next event only after it finished this
          // one. This is an event-processing barrier, not a second poller.
          consumedChanges.push({authority: options.authority, change});
        }
      }};
    },
    observePull(request) {
      observationCalls.push({kind: 'anchor', ...request});
      return adapter.observePull(request);
    },
    async readObject(request) {
      calls.push(request);
      try { return await adapter.readObject(request); }
      catch (error) { errors.push(error); throw error; }
    },
  });
  const authorityFor = ids => runtime.authority.issue({principal: 'theme-reader',
    grants: ids.map(id => ({operation: 'object/read', resource: api.objectResource(IMAGE, id)}))});
  const allAuthority = async (except = []) => authorityFor((await runtime.images.listRecords(IMAGE))
    .map(record => record.id).filter(id => !except.includes(id)));
  const snapshot = async () => (await runtime.images.listRecords(IMAGE)).sort((a, b) => a.id < b.id ? -1 : 1);
  return {runtime, adapter, resolver, calls, errors, observationCalls, consumedChanges,
    authorityFor, allAuthority, snapshot};
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
  // The exact cross-host T4 appearance fixture is an observed, authorized
  // ThemeResolver result, not a second hardcoded runtime palette.
  const renderedStock = JSON.parse(await readFile(new URL('./fixtures/theme/stock-tokens.json', import.meta.url), 'utf8'));
  assert.deepEqual(resolved.tokens, renderedStock);
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


test('catalog default resolves through authorized catalog and preserves read-only output', integration, async t => {
  const f = await setup(t);
  const authority = await f.allAuthority();
  const before = await f.snapshot();
  const result = await f.resolver.resolveCatalogDefault({imageId: IMAGE, authority, blockId: BLOCK});
  assert.deepEqual(result, {themeRef: ref(THEME), tokens: STOCK});
  assert.deepEqual(f.calls.map(call => call.objectId),
    ['environment/catalog', THEME, ...STOCK.map(token => stockToken(token.path))]);
  assert.ok(f.calls.every(call => call.authority === authority && call.blockId === BLOCK && call.imageId === IMAGE));
  assert.deepEqual(await f.snapshot(), before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.themeRef) && Object.isFrozen(result.tokens));
});

test('catalog default can deliberately change without a code-palette fallback', integration, async t => {
  const f = await setup(t);
  const old = await f.resolver.resolveCatalogDefault({
    imageId: IMAGE, authority: await f.allAuthority(), blockId: BLOCK,
  });
  await putToken(f.runtime, 'custom/accent', 'accent', 'color', text('#112233'));
  await putTheme(f.runtime, 'custom', THEME, ['custom/accent']);
  await f.runtime.images.putObject(IMAGE, {
    id: 'environment/catalog', shape: ref('environment/shapes/catalog/v1'),
    slots: {format: text('environment-catalog/v1'), defaultTheme: ref('custom')},
    indexed: [ref(THEME), ref('custom')],
  });
  f.calls.length = 0;
  const before = await f.snapshot();
  const result = await f.resolver.resolveCatalogDefault({
    imageId: IMAGE, authority: await f.allAuthority(), blockId: BLOCK,
  });
  assert.equal(result.themeRef.objectId, 'custom');
  assert.equal(result.tokens.find(token => token.path === 'accent').value, '#112233');
  assert.equal(old.tokens.find(token => token.path === 'accent').value, '#245a81');
  assert.deepEqual(f.calls.slice(0, 3).map(call => call.objectId),
    ['environment/catalog', 'custom', 'custom/accent']);
  assert.deepEqual(await f.snapshot(), before);
});

for (const denied of ['environment/catalog', THEME, stockToken('accent')]) {
  test('catalog selection denies '+denied+' without fallback', integration, async t => {
    const f = await setup(t);
    const before = await f.snapshot();
    await assert.rejects(f.resolver.resolveCatalogDefault({
      imageId: IMAGE, authority: await f.allAuthority([denied]), blockId: BLOCK,
    }), error => {
      assert.equal(error, f.errors.at(-1));
      assert.equal(error.name, 'AuthorityError');
      return true;
    });
    assert.equal(f.calls.at(-1).objectId, denied);
    assert.deepEqual(await f.snapshot(), before);
  });
}

test('missing catalog cannot select stock or provision defaults', integration, async t => {
  const f = await setup(t, false);
  const before = await f.snapshot();
  await assert.rejects(f.resolver.resolveCatalogDefault({
    imageId: IMAGE, authority: f.authorityFor(['environment/catalog']), blockId: BLOCK,
  }), error => error === f.errors.at(-1));
  assert.deepEqual(f.calls.map(call => call.objectId), ['environment/catalog']);
  assert.deepEqual(await f.snapshot(), before);
});

test('catalog stock-list multiplicity does not invent a second default-selection policy', integration, async t => {
  const f = await setup(t);
  const authority = await f.allAuthority();
  const calls = [];
  const resolver = createThemeResolver({async readObject(request) {
    calls.push(request.objectId);
    const record = await f.adapter.readObject(request);
    return request.objectId === 'environment/catalog'
      ? {...record, indexed: [ref(THEME), ref(THEME)]} : record;
  }});
  const result = await resolver.resolveCatalogDefault({imageId: IMAGE, authority, blockId: BLOCK});
  assert.equal(result.themeRef.objectId, THEME);
  assert.deepEqual(calls.slice(0, 2), ['environment/catalog', THEME]);
});

test('malformed catalog fails before reading its default', integration, async t => {
  const f = await setup(t);
  const authority = await f.allAuthority();
  const corruptions = [
    v => ({...v, slots: {...v.slots, format: text('wrong')}}),
    v => ({...v, slots: {...v.slots, defaultTheme: null}}),
    v => ({...v, slots: {...v.slots, defaultTheme: {...ref(THEME), imageId: 'other'}}}),
    v => ({...v, slots: {...v.slots, defaultTheme: {...ref(THEME), kind: 'pinned-ref'}}}),
    v => ({...v, slots: {...v.slots, extra: text('unexpected')}}),
    v => ({...v, indexed: [{...ref(THEME), revision: '1'}]}),
  ];
  for (const corrupt of corruptions) {
    const reads = [];
    const resolver = createThemeResolver({async readObject(request) {
      reads.push(request.objectId);
      const record = await f.adapter.readObject(request);
      return request.objectId === 'environment/catalog' ? corrupt(record) : record;
    }});
    await assert.rejects(resolver.resolveCatalogDefault({imageId: IMAGE, authority, blockId: BLOCK}),
      ThemeResolutionError);
    assert.deepEqual(reads, ['environment/catalog']);
  }
});

test('catalog selection rejects invalid image ids without reading', async () => {
  let count = 0;
  const resolver = createThemeResolver({readObject() {count++;}});
  for (const imageId of [undefined, null, '', 1]) {
    await assert.rejects(resolver.resolveCatalogDefault({imageId}), ThemeResolutionError);
  }
  assert.equal(count, 0);
});

test('the T4 derived appearance fixture is produced by actual authorized Theme inheritance', integration, async t => {
  const f = await setup(t);
  const derived = JSON.parse(await readFile(new URL('./fixtures/theme/derived-tokens.json', import.meta.url), 'utf8'));
  const overrides = [];
  for (const token of derived) {
    const stock = STOCK.find(item => item.path === token.path);
    if (token.value === stock.value) continue;
    const id = 'appearance/' + token.path;
    await putToken(f.runtime, id, token.path, token.type,
      token.type === 'dimension' || token.type === 'fontSize'
        ? integer(token.value) : text(token.value));
    overrides.push(id);
  }
  await putTheme(f.runtime, 'appearance/derived', THEME, overrides);
  const result = await resolveUnchanged(f, 'appearance/derived');
  assert.deepEqual(result.tokens, derived);
  assert.notDeepEqual(result.tokens, STOCK);
});

test('T5 real Images authorized observations update the live catalog and DesignToken values', integration, async t => {
  const f = await setup(t, true, true);
  // Install an authorized candidate derived Theme BEFORE minting read grants:
  // references (even in a catalog) do not grant access to new objects.
  await putToken(f.runtime, 'live/accent', 'accent', 'color', text('#112233'));
  await putTheme(f.runtime, 'live', THEME, ['live/accent']);
  const authority = await f.allAuthority();
  const updates = [];
  const errors = [];
  const waiting = new Map();
  const onUpdate = (resolved, change) => {
    updates.push({resolved, change});
    for (const [n, wake] of waiting) {
      if (updates.length >= n) {
        waiting.delete(n);
        wake();
      }
    }
  };
  const waitFor = count => {
    if (updates.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(count);
        reject(new Error('live Images observation did not reach update ' + count));
      }, 15_000);
      waiting.set(count, () => { clearTimeout(timer); resolve(); });
    });
  };
  const follow = await f.resolver.followCatalogDefault({
    imageId: IMAGE, authority, blockId: BLOCK, observationBlockId: OBSERVATION_BLOCK,
    intervalMs: 10, onUpdate, onError: error => { errors.push(error); },
  });
  t.after(() => follow.stop());
  assert.deepEqual(updates[0].resolved, {themeRef: ref(THEME), tokens: STOCK});
  assert.equal(updates[0].change, null);
  assert.equal(updates[0].resolved.tokens.find(t => t.path === 'accent').value, '#245a81');
  // A deliberate ordinary-image write retargets the canonical catalog.
  await f.runtime.images.putObject(IMAGE, {
    id: 'environment/catalog', shape: ref('environment/shapes/catalog/v1'),
    slots: {format: text('environment-catalog/v1'), defaultTheme: ref('live')},
    indexed: [ref(THEME), ref('live')],
  });
  await waitFor(2);
  assert.equal(updates.at(-1).resolved.themeRef.objectId, 'live');
  assert.equal(updates.at(-1).resolved.tokens.find(t => t.path === 'accent').value, '#112233');
  assert.equal(updates.at(-1).change.objectId, 'environment/catalog');
  assert.deepEqual(Object.keys(updates.at(-1).change).sort(), ['cursor', 'kind', 'objectId', 'type'],
    'the feed must disclose only opaque metadata, never records or revisions');
  // A second ordinary write changes a selected DesignToken. One actual Images
  // invalidation -> a fresh authorized full Theme traversal -> new scalar.
  await putToken(f.runtime, 'live/accent', 'accent', 'color', text('#334455'));
  await waitFor(3);
  assert.equal(updates.at(-1).resolved.tokens.find(t => t.path === 'accent').value, '#334455');
  assert.equal(updates.at(-1).change.objectId, 'live/accent');
  assert.ok(f.calls.every(call => call.authority === authority && call.blockId === BLOCK));
  follow.stop();
  await follow.done;
  assert.deepEqual(errors, [], 'no alternate fetch or hidden fallback was needed');
});

function themeSession(resolver) {
  const renderer = createFakeRendererAdapter();
  const styles = [];
  const errors = [];
  // This lane proves the real Images boundary. The real BrowserRendererAdapter
  // and DOM identity are covered by the canonical browser proof page.
  const rendererAdapter = Object.freeze({...renderer,
    setResolvedTokens(tokens) { styles.push(tokens); },
  });
  // Equal descriptive principal keys must not turn two separate authority
  // contexts into a shared Theme result or a shared Session lifetime.
  const session = new Session({principal: 'same-descriptive-principal', state: {selection: 'retained'}});
  const lifecycle = createSessionThemeLifecycle({session, rendererAdapter, themeResolver: resolver,
    onThemeError(error) { errors.push(error); },
  });
  return {session, renderer, styles, errors, lifecycle};
}

async function waitForThemeProof(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('real Images Theme proof did not reach ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function assertSessionBindings(f, contexts) {
  const expected = new Map(contexts.map(([authority, blockId, observationBlockId]) =>
    [authority, {blockId, observationBlockId}]));
  for (const call of f.calls) {
    assert.ok(expected.has(call.authority), 'read uses exactly one supplied authority context');
    assert.equal(call.imageId, IMAGE);
    assert.equal(call.blockId, expected.get(call.authority).blockId);
  }
  for (const call of f.observationCalls) {
    assert.ok(expected.has(call.authority), 'observation uses exactly one supplied authority context');
    assert.equal(call.imageId, IMAGE);
    assert.equal(call.blockId, expected.get(call.authority).observationBlockId);
  }
  for (const [authority] of contexts) {
    assert.ok(f.calls.some(call => call.authority === authority));
    assert.ok(f.observationCalls.some(call => call.kind === 'anchor' && call.authority === authority));
  }
}

const openThemePane = lifecycle => lifecycle.compositor.openView({
  viewDescriptor: {kind: 'tool-pane'},
  presentationDescriptor: {kind: 'inspector', subject: ref('theme-proof-pane'), parameters: {}},
});

test('T6 one real Images graph and resolver isolate a denied shadowed token from a permitted Session', integration, async t => {
  const f = await setup(t, true, true, [SECOND_BINDINGS]);
  await putToken(f.runtime, 'session/accent', 'accent', 'color', text('#112233'));
  await putTheme(f.runtime, 'session/derived', THEME, ['session/accent']);
  await putToken(f.runtime, 'unrelated-token', 'accent', 'color', text('#aabbcc'));
  await f.runtime.images.putObject(IMAGE, {
    id: 'environment/catalog', shape: ref('environment/shapes/catalog/v1'),
    slots: {format: text('environment-catalog/v1'), defaultTheme: ref('session/derived')},
    indexed: [ref(THEME), ref('session/derived')],
  });
  const permittedAuthority = await f.allAuthority();
  const deniedAuthority = await f.allAuthority([stockToken('accent')]);
  assert.notEqual(permittedAuthority, deniedAuthority);
  const permitted = themeSession(f.resolver);
  const denied = themeSession(f.resolver);
  const selection = {kind: 'catalog-default', imageId: IMAGE};
  let deniedFailure;
  try {
    const permittedView = await openThemePane(permitted.lifecycle);
    const deniedView = await openThemePane(denied.lifecycle);
    await permitted.lifecycle.start({selection, authority: permittedAuthority,
      blockId: BLOCK, observationBlockId: OBSERVATION_BLOCK, intervalMs: 10});
    assert.deepEqual(permitted.styles, [STOCK.map(token => token.path === 'accent'
      ? {...token, value: '#112233'} : token)]);
    // Resolve the SAME selected graph after the first Session has populated
    // its renderer. A result cached by image, Theme or principal would leak.
    await assert.rejects(denied.lifecycle.start({selection, authority: deniedAuthority,
      ...SECOND_BINDINGS, intervalMs: 10}), error => {
      deniedFailure = error;
      assert.equal(error, f.errors.at(-1));
      assert.equal(error.name, 'AuthorityError');
      return true;
    });
    await assert.rejects(denied.lifecycle.done, error => error === deniedFailure);
    assert.deepEqual(denied.errors, [deniedFailure]);
    assert.deepEqual(denied.styles, [null], 'denial withdraws without receiving any permitted scalar values');
    assert.equal(f.calls.filter(call => call.authority === deniedAuthority).at(-1).objectId,
      stockToken('accent'), 'even the overridden base token is independently authorized');
    assert.ok(denied.lifecycle.compositor.liveView(deniedView), 'Theme failure preserves the existing pane');
    assert.equal(denied.renderer.liveResourceCount(), 1);
    assert.equal(denied.lifecycle.compositor.destroy, denied.lifecycle.close);
    await assert.rejects(denied.lifecycle.compositor.destroy(), error => error === deniedFailure);
    assert.equal(denied.renderer.liveResourceCount(), 0);
    assert.ok(permitted.lifecycle.compositor.liveView(permittedView));
    assert.equal(permitted.renderer.liveResourceCount(), 1);

    // Closing the failed Session cannot stop the permitted follow. This token
    // is inherited by the selected child and uses the real authorized feed.
    await putToken(f.runtime, stockToken('surface.base'), 'surface.base', 'color', text('#0f1e2d'));
    await waitForThemeProof(() => permitted.styles.at(-1)?.some(token =>
      token.path === 'surface.base' && token.value === '#0f1e2d'), 'inherited token refresh');
    assert.equal(permitted.styles.length, 2);
    assert.deepEqual(denied.styles, [null]);

    // Prove that a readable but unrelated invalidation really traversed the
    // feed and was consumed; no sleep-based absence assertion is needed.
    const readsBeforeUnrelated = f.calls.length;
    await putToken(f.runtime, 'unrelated-token', 'accent', 'color', text('#ddeeff'));
    await waitForThemeProof(() => f.consumedChanges.some(({authority, change}) =>
      authority === permittedAuthority && change.objectId === 'unrelated-token'), 'ignored metadata');
    assert.equal(f.calls.length, readsBeforeUnrelated);
    assert.equal(permitted.styles.length, 2);
    assert.deepEqual(permitted.errors, []);
    assertSessionBindings(f, [
      [permittedAuthority, BLOCK, OBSERVATION_BLOCK],
      [deniedAuthority, SECOND_BINDINGS.blockId, SECOND_BINDINGS.observationBlockId],
    ]);
    for (const fixture of [permitted, denied]) {
      assert.deepEqual(fixture.session.state, {selection: 'retained'});
      assert.equal(fixture.session.perspective, null);
    }
  } finally {
    const cleanup = await Promise.allSettled([permitted.lifecycle.close(), denied.lifecycle.close()]);
    assert.equal(cleanup[0].status, 'fulfilled');
    if (deniedFailure) {
      assert.equal(cleanup[1].status, 'rejected');
      assert.equal(cleanup[1].reason, deniedFailure, 'repeated close preserves the recorded failure');
    } else {
      assert.equal(cleanup[1].status, 'fulfilled');
    }
  }
  assert.equal(denied.renderer.calls().filter(call => call.method === 'destroyAll').length, 1);
  assert.equal(permitted.renderer.calls().filter(call => call.method === 'destroyAll').length, 1);
});

for (const firstToClose of [0, 1]) {
  test(`T6 closing Session ${firstToClose} leaves the other real Images follow and renderer live`, integration, async t => {
    const f = await setup(t, true, true, [SECOND_BINDINGS]);
    const authorities = [await f.allAuthority(), await f.allAuthority()];
    assert.notEqual(authorities[0], authorities[1]);
    const bindings = [{blockId: BLOCK, observationBlockId: OBSERVATION_BLOCK}, SECOND_BINDINGS];
    const sessions = [themeSession(f.resolver), themeSession(f.resolver)];
    const views = [];
    try {
      for (const [index, fixture] of sessions.entries()) {
        views.push(await openThemePane(fixture.lifecycle));
        await fixture.lifecycle.start({
          selection: index === 0 ? {kind: 'catalog-default', imageId: IMAGE}
            : {kind: 'explicit', themeRef: ref(THEME)},
          authority: authorities[index], ...bindings[index], intervalMs: 10,
        });
        assert.deepEqual(fixture.styles, [STOCK]);
      }
      const closed = sessions[firstToClose];
      const liveIndex = 1 - firstToClose;
      const live = sessions[liveIndex];
      assert.equal(closed.lifecycle.compositor.destroy, closed.lifecycle.close);
      await closed.lifecycle.compositor.destroy();
      await closed.lifecycle.done;
      const closedStyles = closed.styles.slice();
      const closedReads = f.calls.filter(call => call.authority === authorities[firstToClose]).length;
      assert.equal(closed.renderer.liveResourceCount(), 0);
      assert.equal(live.renderer.liveResourceCount(), 1);
      const liveView = live.lifecycle.compositor.liveView(views[liveIndex]);
      assert.ok(liveView);
      const closedObservation = f.observationCalls.find(call =>
        call.kind === 'follow' && call.authority === authorities[firstToClose]);
      assert.equal(closedObservation.signal.aborted, true);

      await putToken(f.runtime, stockToken('text.primary'), 'text.primary', 'color', text('#102030'));
      await waitForThemeProof(() => f.consumedChanges.some(({authority, change}) =>
        authority === authorities[liveIndex] && change.objectId === stockToken('text.primary')),
      'surviving Session refresh');
      assert.deepEqual(live.styles, [STOCK, STOCK.map(token => token.path === 'text.primary'
        ? {...token, value: '#102030'} : token)]);
      assert.deepEqual(closed.styles, closedStyles, 'closed renderer receives no subsequent token delivery');
      assert.equal(f.calls.filter(call => call.authority === authorities[firstToClose]).length, closedReads,
        'closed follow issues no later authorized read');
      assert.equal(live.lifecycle.compositor.liveView(views[liveIndex]).presentationDescriptor,
        liveView.presentationDescriptor, 'live edit does not re-present the semantic pane');
      assertSessionBindings(f, authorities.map((authority, index) =>
        [authority, bindings[index].blockId, bindings[index].observationBlockId]));
      for (const fixture of sessions) {
        assert.deepEqual(fixture.errors, []);
        assert.deepEqual(fixture.session.state, {selection: 'retained'});
      }
    } finally {
      await Promise.all(sessions.map(fixture => fixture.lifecycle.compositor.destroy()));
    }
    for (const fixture of sessions) {
      assert.equal(fixture.renderer.calls().filter(call => call.method === 'destroyAll').length, 1);
    }
  });
}

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
