import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {readFileSync} from 'node:fs';
import {createThemeResolver, ThemeResolutionError} from '../src/theme-resolver.js';

const IMAGE = 'theme-live';
const REF = id => ({kind: 'ref', imageId: IMAGE, objectId: id});
const textValue = value => ({kind: 'text', value});
const intValue = value => ({kind: 'integer', value: String(value)});
const STOCK = JSON.parse(readFileSync(new URL('./fixtures/theme/stock-tokens.json', import.meta.url)));
const tokens = Object.freeze(STOCK);
const TOKEN_ID = path => 'stock/' + path;
const changed = objectId => ({kind: 'object.put', type: 'record.put', objectId, cursor: 'opaque:event'});

function graph() {
  const records = new Map();
  for (const entry of tokens) records.set(TOKEN_ID(entry.path), {
    slots: {format: textValue('environment-design-token/v1'), path: textValue(entry.path),
      type: textValue(entry.type),
      value: entry.type === 'fontSize' || entry.type === 'dimension'
        ? intValue(entry.value) : textValue(entry.value)},
    indexed: [],
    versionToken: 'opaque:no-inspection',
  });
  records.set('root', {
    slots: {format: textValue('environment-theme/root/v1'), name: textValue('Root')},
    indexed: tokens.map(token => REF(TOKEN_ID(token.path))), versionToken: 'opaque:root',
  });
  records.set('child', {
    slots: {format: textValue('environment-theme/derived/v1'),
      name: textValue('Child'), baseTheme: REF('root')},
    indexed: [REF('overrides/accent')], versionToken: 'opaque:child',
  });
  records.set('overrides/accent', {
    slots: {format: textValue('environment-design-token/v1'), path: textValue('accent'),
      type: textValue('color'), value: textValue('#8899aa')},
    indexed: [], versionToken: 'opaque:accent',
  });
  records.set('environment/catalog', {
    slots: {format: textValue('environment-catalog/v1'), defaultTheme: REF('child')},
    indexed: [REF('root'), REF('child')], versionToken: 'opaque:catalog',
  });
  return records;
}

function gate() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return {pending, release};
}

function makeFixture({beforeRead} = {}) {
  const records = graph();
  const reads = [];
  const demands = [];
  const authority = {opaque: true};
  const observation = {seen: [], queue: [], waiting: [], afterCursor: null, pulls: []};
  let denied = new Set();
  const errors = [];
  const seen = [];
  const onUpdate = (resolved, cause) => { seen.push({resolved, cause}); };
  const onError = error => { errors.push(error); };
  const observePull = async options => {
    observation.pulls.push(options);
    return {events: [], cursor: 'obs-cursor/v1:anchor'};
  };
  const observe = (imageId, options) => {
    observation.afterCursor = options.afterCursor;
    observation.seen.push({imageId, options});
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (observation.queue.length) return Promise.resolve({value: observation.queue.shift(), done: false});
            return new Promise(resolve => observation.waiting.push(resolve));
          },
          async return() { return {done: true}; },
        };
      },
    };
  };
  const fixture = {
    records, authority, reads, demands, errors, seen, observation,
    setDenied(ids) {denied = new Set(ids);},
    emit(objectId, kind = 'object.put') {
      const event = {...changed(objectId), kind};
      const waiter = observation.waiting.shift();
      if (waiter) waiter({value: event, done: false});
      else observation.queue.push(event);
    },
    resolver: createThemeResolver({
      observe, observePull,
      async readObject({imageId, objectId, authority: context, blockId}) {
        assert.equal(imageId, IMAGE);
        assert.equal(context, authority);
        assert.equal(blockId, 'read');
        reads.push(objectId);
        demands.push({objectId, authority: context, blockId});
        // Capture the READ snapshot before the deliberate test hold: otherwise
        // a concurrent edit could be seen by the first read and the replay
        // check would pass without proving the cursor boundary.
        const record = structuredClone(records.get(objectId));
        if (beforeRead) await beforeRead(objectId);
        if (denied.has(objectId)) {
          const error = new Error('denied: ' + objectId);
          error.name = 'AuthorityError';
          throw error;
        }
        if (!records.has(objectId)) throw new TypeError('missing: ' + objectId);
        return record;
      },
    }),
    options: {imageId: IMAGE, authority, blockId: 'read',
      observationBlockId: 'observe', onUpdate, onError},
  };
  return fixture;
}

async function settleUntil(check, label) {
  // Scheduling is deterministic through the injected observation iterator;
  // this merely bounds a failing test rather than sleeping to avoid a race.
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('did not observe ' + label);
}

test('T5 bootstraps an opaque cursor before the initial authorized catalog read', async () => {
  const f = makeFixture();
  const subscription = await f.resolver.followCatalogDefault(f.options);
  assert.deepEqual(f.observation.pulls, [{
    imageId: IMAGE, authority: f.authority,
    afterCursor: '', blockId: 'observe',
  }]);
  assert.equal(f.observation.afterCursor, 'obs-cursor/v1:anchor');
  assert.equal(f.reads[0], 'environment/catalog');
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].resolved.themeRef.objectId, 'child');
  assert.deepEqual(f.seen[0].resolved.tokens.find(v => v.path === 'accent').value, '#8899aa');
  assert.equal('dependencies' in f.seen[0].resolved, false);
  assert.ok(Object.isFrozen(f.seen[0].resolved));
  subscription.stop();
  await subscription.done;
});

test('T5 ignores unrelated and future invalidation kinds; refreshes inherited and shadowed tokens', async () => {
  const f = makeFixture();
  const subscription = await f.resolver.followCatalogDefault(f.options);
  const readCount = f.reads.length;
  f.emit('not-the-current-theme');
  f.emit('root', 'shape.put');
  await settleUntil(() => f.observation.waiting.length > 0, 'irrelevant events drained');
  assert.equal(f.reads.length, readCount);
  assert.equal(f.seen.length, 1);
  // Root accent is SHADOWED by child, yet the owner must reauthorize/revalidate
  // the base token and treat it as a dependency.
  f.records.get('stock/accent').slots.value = textValue('#aabbcc');
  f.emit('stock/accent');
  await settleUntil(() => f.seen.length === 2, 'shadowed token invalidation');
  assert.equal(f.seen[1].resolved.tokens.find(v => v.path === 'accent').value, '#8899aa');
  f.records.get('root').slots.name = textValue('Root edited');
  f.emit('root');
  await settleUntil(() => f.seen.length === 3, 'inherited Theme invalidation');
  assert.equal(f.observation.afterCursor, 'obs-cursor/v1:anchor');
  assert.ok(f.demands.every(d => d.authority === f.authority && d.blockId === 'read'));
  subscription.stop();
  await subscription.done;
});

test('T5 catalog retargeting replaces the dependency set and stops following old overrides', async () => {
  const f = makeFixture();
  const subscription = await f.resolver.followCatalogDefault(f.options);
  f.records.get('environment/catalog').slots.defaultTheme = REF('root');
  f.emit('environment/catalog');
  await settleUntil(() => f.seen.length === 2, 'catalog retarget');
  assert.equal(f.seen[1].resolved.themeRef.objectId, 'root');
  assert.equal(f.seen[1].resolved.tokens.find(v => v.path === 'accent').value, '#245a81');
  const count = f.reads.length;
  f.emit('overrides/accent');
  await settleUntil(() => f.observation.waiting.length > 0, 'retired dependency ignored');
  assert.equal(f.reads.length, count);
  f.emit('stock/accent');
  await settleUntil(() => f.seen.length === 3, 'new dependency still active');
  subscription.stop();
  await subscription.done;
});

test('T5 explicit Theme subscription does not subscribe to catalog switches', async () => {
  const f = makeFixture();
  const sub = await f.resolver.followTheme({...f.options, themeRef: REF('root')});
  const count = f.reads.length;
  f.emit('environment/catalog');
  await settleUntil(() => f.observation.waiting.length > 0, 'catalog ignored for explicit Theme');
  assert.equal(f.reads.length, count);
  f.emit('stock/focus');
  await settleUntil(() => f.seen.length === 2, 'explicit Theme dependency');
  assert.equal(f.seen[1].resolved.themeRef.objectId, 'root');
  sub.stop();
  await sub.done;
});

test('T5 a mutation between cursor anchoring and initial Theme read is replayed', async () => {
  const held = gate();
  let releaseWasReached = false;
  const f = makeFixture({beforeRead: async id => {
    if (id === 'stock/focus' && !releaseWasReached) {
      releaseWasReached = true;
      await held.pending;
    }
  }});
  const started = f.resolver.followCatalogDefault(f.options);
  await settleUntil(() => releaseWasReached, 'held initial read');
  assert.equal(f.observation.pulls.length, 1, 'anchor already established');
  // Mutation after the bootstrap cursor, while initial read is still pending.
  f.records.get('stock/focus').slots.value = textValue('#224466');
  f.emit('stock/focus');
  held.release();
  const sub = await started;
  assert.equal(f.seen[0].resolved.tokens.find(t => t.path === 'focus').value, '#b45a16',
    'initial held read must show the OLD value or this race proof is vacuous');
  await settleUntil(() => f.seen.length === 2, 'startup-change replay');
  assert.equal(f.seen[1].resolved.tokens.find(t => t.path === 'focus').value, '#224466');
  sub.stop();
  await sub.done;
});

test('T5 denied refresh reports the exact error and terminates without a fallback', async () => {
  const f = makeFixture();
  const sub = await f.resolver.followCatalogDefault(f.options);
  f.setDenied(['stock/accent']);
  f.emit('child');
  await sub.done;
  assert.equal(f.seen.length, 1, 'no stale or invented Theme is republished');
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].name, 'AuthorityError');
  assert.match(f.errors[0].message, /stock\/accent/);
  assert.equal(sub.signal.aborted, true);
});

test('T5 stop interrupts an uncancellable in-flight read; no late style is published', async () => {
  const delayed = gate();
  let delayReads = false;
  let blocked = false;
  const f = makeFixture({beforeRead: async id => {
    if (delayReads && id === 'root') {
      blocked = true;
      await delayed.pending;
    }
  }});
  const sub = await f.resolver.followCatalogDefault(f.options);
  delayReads = true;
  f.emit('root');
  await settleUntil(() => blocked, 'blocked fresh read');
  sub.stop();
  await sub.done;
  const previous = f.seen.length;
  const readsAtStop = f.reads.length;
  delayed.release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.seen.length, previous);
  assert.equal(f.reads.length, readsAtStop,
    'releasing the held root after stop must NOT launch any of its 15 token reads');
  assert.deepEqual(f.errors, []);
});

test('T5 aborting a held catalog read cannot launch a selected Theme traversal', async () => {
  const held = gate();
  const external = new AbortController();
  let paused = false;
  const f = makeFixture({beforeRead: async objectId => {
    if (objectId === 'environment/catalog') {
      paused = true;
      await held.pending;
    }
  }});
  const starting = f.resolver.followCatalogDefault({...f.options, signal: external.signal});
  await settleUntil(() => paused, 'held catalog read');
  assert.deepEqual(f.reads, ['environment/catalog']);
  external.abort();
  const sub = await starting;
  await sub.done;
  const readsAtStop = f.reads.length;
  held.release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.reads, ['environment/catalog']);
  assert.equal(f.reads.length, readsAtStop,
    'a stopped initial catalog read must never issue the selected Theme read');
  assert.deepEqual(f.seen, []);
});

test('T5 a lower AbortError while still active is reported, not mistaken for stop', async () => {
  const records = graph();
  const failure = new Error('observation transport failed independently');
  failure.name = 'AbortError';
  const faults = [];
  const reader = createThemeResolver({
    readObject: async ({objectId}) => structuredClone(records.get(objectId)),
    observePull: async () => ({events: [], cursor: 'obs-cursor/v1:starting'}),
    observe: () => ({async *[Symbol.asyncIterator]() {throw failure;}}),
  });
  const sub = await reader.followTheme({
    themeRef: REF('root'), authority: {}, blockId: 'read',
    observationBlockId: 'observe', onUpdate() {}, onError(error) {faults.push(error);},
  });
  await sub.done;
  assert.deepEqual(faults, [failure],
    'only a caller-requested stop can suppress AbortError; transport errors are real errors');
  assert.equal(sub.signal.aborted, true);
});

test('T5 stopping in the same turn prevents a queued bootstrap operation from starting', async () => {
  const external = new AbortController();
  const f = makeFixture();
  const pending = f.resolver.followCatalogDefault({...f.options, signal: external.signal});
  // The original implementation tested before queuing a Promise.then().
  // That callback ran even though the cancellation arrived first.
  external.abort();
  const subscription = await pending;
  assert.equal(subscription.signal.aborted, true);
  assert.deepEqual(f.observation.pulls, [],
    'the observation anchor must not start after stop');
  assert.deepEqual(f.reads, [], 'no Theme read may follow stop');
  assert.deepEqual(f.seen, [], 'no rendered Theme may be published');
  await subscription.done;
});

test('T5 independent AbortErrors in each startup phase reject instead of pretending stop succeeded', async () => {
  for (const phase of ['anchor', 'read', 'render']) {
    const failure = new Error('independent startup failure: ' + phase);
    failure.name = 'AbortError';
    const records = graph();
    let readCount = 0;
    let renderCount = 0;
    let errorCount = 0;
    const resolver = createThemeResolver({
      async observePull() {
        if (phase === 'anchor') throw failure;
        return {events: [], cursor: 'obs-cursor/v1:start'};
      },
      async readObject({objectId}) {
        readCount += 1;
        if (phase === 'read') throw failure;
        return structuredClone(records.get(objectId));
      },
      observe: () => {throw new Error('startup failed; follow must not begin');},
    });
    await assert.rejects(resolver.followTheme({
      themeRef: REF('root'), authority: {}, blockId: 'read', observationBlockId: 'observe',
      onUpdate() {
        renderCount += 1;
        if (phase === 'render') throw failure;
      },
      onError() {errorCount += 1;},
    }), error => error === failure,
    'independent '+phase+' AbortError must preserve identity at startup');
    assert.equal(errorCount, 0, 'startup rejection cannot be disguised as later callback failure');
    assert.equal(renderCount, phase === 'render' ? 1 : 0);
    assert.equal(readCount, phase === 'anchor' ? 0 : phase === 'read' ? 1 : 16);
  }
});

test('T5 a long-lived follow retains only one detachable abort listener per pending operation', async () => {
  const f = makeFixture();
  const sub = await f.resolver.followCatalogDefault(f.options);
  await settleUntil(() => f.observation.waiting.length > 0, 'first observation wait');
  assert.equal(getEventListeners(sub.signal, 'abort').length, 1,
    'the one in-flight Images operation has exactly one cancellation listener');
  const initialReads = f.reads.length;
  for (let i = 0; i < 100; i++) {
    // Each ignored invalidation must still retire its old cancellable wait;
    // an indefinitely pending stopped Promise would retain 100 reactions.
    f.emit('unrelated/' + i);
    await settleUntil(() => f.observation.waiting.length > 0, 'next observation wait ' + i);
    assert.equal(getEventListeners(sub.signal, 'abort').length, 1,
      'listener count must be constant regardless of observation history');
  }
  assert.equal(f.reads.length, initialReads, 'unrelated invalidations must not trigger rereads');
  sub.stop();
  await sub.done;
  assert.equal(getEventListeners(sub.signal, 'abort').length, 0,
    'no listener may survive termination');
});

test('T5 invalid arguments and missing observation surface fail before any read', async () => {
  const f = makeFixture();
  const noStream = createThemeResolver({readObject: () => {throw new Error('read wrongly started');}});
  await assert.rejects(noStream.followCatalogDefault(f.options), /requires ImageClientAdapter/);
  await assert.rejects(f.resolver.followCatalogDefault({...f.options, observationBlockId: ''}), ThemeResolutionError);
  await assert.rejects(f.resolver.followCatalogDefault({...f.options, onError: null}), TypeError);
  await assert.rejects(f.resolver.followCatalogDefault({...f.options, intervalMs: -1}), TypeError);
  assert.deepEqual(f.reads, []);
});
