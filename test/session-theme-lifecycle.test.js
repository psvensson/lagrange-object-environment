import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  Session, createThemeResolver, createFakeRendererAdapter, RENDERER_ADAPTER_METHODS,
  createSessionThemeLifecycle, SessionThemeCancelledError, RendererResourceLostError,
} from '../src/index.js';

const IMAGE = 'session-theme-lifecycle';
const ref = objectId => ({kind: 'ref', imageId: IMAGE, objectId});
const text = value => ({kind: 'text', value});
const STOCK = JSON.parse(readFileSync(new URL('./fixtures/theme/stock-tokens.json', import.meta.url)));
const VIEW = {viewDescriptor: {kind: 'surface', width: 100, height: 100},
  presentationDescriptor: {kind: 'inspector', subject: ref('subject'), parameters: {}}};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function until(predicate, label) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`did not reach ${label}`);
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('lifecycle did not settle while lower operation stayed held')), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture() {
  const records = new Map(STOCK.map(token => [`token/${token.path}`, {
    slots: {format: text('environment-design-token/v1'), path: text(token.path), type: text(token.type),
      value: typeof token.value === 'number' ? {kind: 'integer', value: String(token.value)} : text(token.value)},
    indexed: [], versionToken: 'opaque',
  }]));
  records.set('root', {slots: {format: text('environment-theme/root/v1'), name: text('Root')},
    indexed: STOCK.map(token => ref(`token/${token.path}`)), versionToken: 'opaque'});
  records.set('environment/catalog', {slots: {format: text('environment-catalog/v1'), defaultTheme: ref('root')},
    indexed: [ref('root')], versionToken: 'opaque'});
  const hooks = {};
  const styles = [];
  const reports = [];
  const reads = [];
  const anchors = [];
  const observations = [];
  const order = [];
  const queue = [];
  let waiter;
  let destroyCount = 0;
  const authority = {opaque: 'caller grant'};
  const session = new Session({principal: 'descriptive principal', state: {typed: 'preserve me'}});
  const fake = createFakeRendererAdapter();
  const rendererAdapter = Object.freeze({...fake,
    setResolvedTokens(tokens) {
      order.push(tokens === null ? 'withdraw' : 'style');
      styles.push(tokens);
      return hooks.style?.(tokens);
    },
    async destroyAll() {
      destroyCount++;
      order.push('destroy');
      await hooks.destroy?.();
      await fake.destroyAll();
    },
  });
  const resolver = createThemeResolver({
    async readObject(request) {
      reads.push(request);
      const record = structuredClone(records.get(request.objectId));
      await hooks.read?.(request);
      return record;
    },
    async observePull(request) {
      anchors.push(request);
      await hooks.anchor?.(request);
      return {events: [], cursor: 'opaque:anchor'};
    },
    observe(imageId, options) {
      observations.push({imageId, options});
      options.signal.addEventListener('abort', () => { order.push('stop'); }, {once: true});
      return {[Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length) return Promise.resolve({value: queue.shift(), done: false});
            return new Promise(resolve => { waiter = resolve; });
          },
          return() {
            order.push('retire');
            waiter?.({done: true});
            waiter = null;
            hooks.retire?.();
            return Promise.resolve({done: true});
          },
        };
      }};
    },
  });
  const lifecycle = createSessionThemeLifecycle({session, rendererAdapter, themeResolver: resolver,
    onThemeError(error) { reports.push(error); return hooks.report?.(error); }});
  return {records, hooks, styles, reports, reads, anchors, observations, order,
    authority, session, fake, rendererAdapter, resolver, lifecycle,
    destroyCount: () => destroyCount,
    options: {selection: {kind: 'catalog-default', imageId: IMAGE}, authority,
      blockId: 'read-binding', observationBlockId: 'observe-binding'},
    emit(objectId) {
      const event = {kind: 'object.put', objectId, cursor: 'opaque:event'};
      if (waiter) { const notify = waiter; waiter = null; notify({value: event, done: false}); }
      else queue.push(event);
    },
  };
}

test('T6 publishes the canonical view methods with one follow-before-destroy operation', async () => {
  const f = fixture();
  assert.equal(f.lifecycle.compositor.destroy, f.lifecycle.close);
  assert.equal(RENDERER_ADAPTER_METHODS.length, 6);
  const id = await f.lifecycle.compositor.openView(VIEW);
  const handle = f.lifecycle.compositor.surfaceHandleForView(id);
  await f.lifecycle.start(f.options);
  assert.deepEqual(f.styles, [STOCK]);
  assert.ok(f.reads.every(read => read.authority === f.authority && read.blockId === 'read-binding'));
  assert.equal(f.anchors[0].authority, f.authority);
  assert.equal(f.anchors[0].blockId, 'observe-binding');
  assert.equal(f.observations[0].options.authority, f.authority);
  assert.equal(f.observations[0].options.blockId, 'observe-binding');
  assert.equal(f.lifecycle.compositor.surfaceHandleForView(id), handle);
  assert.deepEqual(f.session.state, {typed: 'preserve me'});

  const held = deferred();
  f.hooks.destroy = () => held.promise;
  const close = f.lifecycle.compositor.destroy();
  let closed = false;
  close.then(() => { closed = true; });
  await until(() => f.destroyCount() === 1, 'held renderer teardown');
  assert.equal(f.lifecycle.close(), close);
  assert.equal(closed, false, 'a second close cannot return before real teardown');
  await f.lifecycle.done; // follow-only completion deliberately precedes held renderer teardown
  assert.ok(f.order.indexOf('stop') < f.order.indexOf('destroy'));
  assert.ok(f.order.indexOf('retire') < f.order.indexOf('destroy'));
  held.resolve();
  await close;
  assert.equal(f.destroyCount(), 1);
  assert.equal(f.fake.liveResourceCount(), 0);
  assert.equal(f.lifecycle.close(), close);
});

test('T6 claims actual Session and adapter identities across factory instances', async () => {
  const f = fixture();
  const anotherAdapter = {...createFakeRendererAdapter(), setResolvedTokens() {}};
  const anotherSession = new Session({principal: 'another'});
  const common = {themeResolver: f.resolver, onThemeError() {}};
  assert.throws(() => createSessionThemeLifecycle({...common, session: f.session,
    rendererAdapter: anotherAdapter}), /already belongs/);
  assert.throws(() => createSessionThemeLifecycle({...common, session: anotherSession,
    rendererAdapter: f.rendererAdapter}), /already belongs/);
  // Neither rejected construction may consume its otherwise valid counterpart.
  assert.throws(() => createSessionThemeLifecycle({session: anotherSession,
    rendererAdapter: anotherAdapter, onThemeError() {}}), /ThemeResolver/);
  const other = createSessionThemeLifecycle({...common, session: anotherSession, rendererAdapter: anotherAdapter});
  await other.close();
  await f.lifecycle.close();
  assert.throws(() => createSessionThemeLifecycle({...common, session: f.session,
    rendererAdapter: {...createFakeRendererAdapter(), setResolvedTokens() {}}}), /already belongs/);
});

test('T6 duplicate start is inert and close-before-start cannot dispatch a follow', async () => {
  const f = fixture();
  await f.lifecycle.start(f.options);
  const reads = f.reads.length;
  await assert.rejects(f.lifecycle.start(f.options), TypeError);
  assert.equal(f.reads.length, reads);
  assert.equal(f.styles.length, 1);
  assert.deepEqual(f.reports, []);
  assert.equal(f.destroyCount(), 0);
  await f.lifecycle.close();
  await assert.rejects(f.lifecycle.start(f.options), TypeError);

  const idle = fixture();
  await idle.lifecycle.close();
  await idle.lifecycle.done;
  await assert.rejects(idle.lifecycle.start(idle.options), TypeError);
  assert.deepEqual(idle.anchors, []);
  assert.deepEqual(idle.styles, []);
  assert.equal(idle.destroyCount(), 1);
});

for (const stage of ['anchor', 'catalog read', 'explicit read', 'refresh read']) {
  test(`T6 close retires a held ${stage} before its lower operation is released`, async () => {
    const f = fixture();
    const held = deferred();
    let entered = false;
    const hold = () => { entered = true; return held.promise; };
    let startup;
    if (stage === 'refresh read') {
      await f.lifecycle.start(f.options);
      f.hooks.read = hold;
      f.emit('root');
    } else {
      if (stage === 'anchor') f.hooks.anchor = hold;
      else f.hooks.read = hold;
      startup = f.lifecycle.start(stage === 'explicit read'
        ? {...f.options, selection: {kind: 'explicit', themeRef: ref('root')}} : f.options);
    }
    await until(() => entered, `held ${stage}`);
    const before = {reads: f.reads.length, styles: f.styles.length};
    await bounded(f.lifecycle.close());
    if (startup) await assert.rejects(startup, SessionThemeCancelledError);
    await f.lifecycle.done;
    assert.deepEqual(f.reports, []);
    assert.equal(f.destroyCount(), 1);
    // A late lower rejection is observed but cannot start further reads/styles.
    held.reject(new Error(`late ${stage} error`));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({reads: f.reads.length, styles: f.styles.length}, before);
    assert.deepEqual(f.reports, []);
  });
}

test('T6 an independent lower AbortError fails startup and keeps the pane until close', async () => {
  const f = fixture();
  const original = new Error('independent read abort');
  original.name = 'AbortError';
  f.hooks.read = () => { throw original; };
  const view = await f.lifecycle.compositor.openView(VIEW);
  const handle = f.lifecycle.compositor.surfaceHandleForView(view);
  await assert.rejects(f.lifecycle.start(f.options), error => error === original);
  await assert.rejects(f.lifecycle.done, error => error === original);
  assert.deepEqual(f.reports, [original]);
  assert.deepEqual(f.styles, [null]);
  assert.equal(f.lifecycle.compositor.surfaceHandleForView(view), handle);
  assert.equal(f.fake.liveResourceCount(), 1);
  assert.equal(f.destroyCount(), 0);
  await assert.rejects(f.lifecycle.close(), error => error === original);
  assert.equal(f.destroyCount(), 1);
  assert.equal(f.fake.liveResourceCount(), 0);
});

test('T6 refresh failure withdraws once, preserves views and exposes done failure', async () => {
  const f = fixture();
  const view = await f.lifecycle.compositor.openView(VIEW);
  await f.lifecycle.start(f.options);
  const original = new Error('read denied after invalidation');
  f.hooks.read = () => { throw original; };
  f.emit('token/accent');
  await assert.rejects(bounded(f.lifecycle.done), error => error === original);
  assert.deepEqual(f.reports, [original]);
  assert.deepEqual(f.styles, [STOCK, null]);
  assert.ok(f.lifecycle.compositor.liveView(view));
  assert.equal(f.destroyCount(), 0);
  await assert.rejects(f.lifecycle.compositor.destroy(), error => error === original);
  assert.equal(f.destroyCount(), 1);
});

test('T6 original, withdrawal, reporter and typed teardown failures all survive one close', async () => {
  const f = fixture();
  const original = new Error('style apply failed');
  const withdrawal = new Error('style removal failed');
  const reporter = new Error('reporter failed');
  const teardown = new Error('renderer destroy failed');
  f.hooks.style = tokens => { throw tokens === null ? withdrawal : original; };
  f.hooks.report = () => { throw reporter; };
  f.hooks.destroy = () => { throw teardown; };
  await f.lifecycle.compositor.openView(VIEW);
  let followFailure;
  await assert.rejects(f.lifecycle.start(f.options), error => {
    followFailure = error;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, withdrawal, reporter]);
    return true;
  });
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].errors, [original, withdrawal]);
  await assert.rejects(f.lifecycle.done, error => error === followFailure);
  const close = f.lifecycle.close();
  assert.equal(f.lifecycle.compositor.destroy(), close);
  let closeFailure;
  await assert.rejects(close, error => {
    closeFailure = error;
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors.slice(0, 3), [original, withdrawal, reporter]);
    assert.ok(error.errors[3] instanceof RendererResourceLostError);
    assert.equal(error.errors[3].cause, teardown);
    return true;
  });
  assert.equal(f.lifecycle.close(), close);
  await assert.rejects(f.lifecycle.close(), error => error === closeFailure);
  assert.equal(f.destroyCount(), 1);
  assert.deepEqual(f.lifecycle.compositor.durableIntent(), []);
});

test('T6 reporter-triggered close preserves the recorded startup failure without a wait cycle', async () => {
  const f = fixture();
  const original = new Error('initial read denied');
  let reentrant;
  f.hooks.read = () => { throw original; };
  f.hooks.report = () => { reentrant = f.lifecycle.close(); };
  await assert.rejects(bounded(f.lifecycle.start(f.options)), error => error === original);
  // Intentionally attach the consumer's close rejection handler on a later
  // turn: the supported fire-and-forget reporter must not leak a rejection.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reentrant, f.lifecycle.close());
  await assert.rejects(bounded(reentrant), error => error === original);
  await assert.rejects(f.lifecycle.done, error => error === original);
  assert.equal(f.destroyCount(), 1);
  assert.deepEqual(f.reports, [original]);
});

for (const callback of ['style', 'reporter']) {
  test(`T6 an invalid async ${callback} cannot strand retirement and its late rejection is handled`, async () => {
    const f = fixture();
    const held = deferred();
    const original = new Error('read failed');
    if (callback === 'style') {
      f.hooks.style = tokens => tokens === null ? undefined : held.promise;
    } else {
      f.hooks.read = () => { throw original; };
      f.hooks.report = () => held.promise;
    }
    let failure;
    await assert.rejects(bounded(f.lifecycle.start(f.options)), error => {
      failure = error;
      const violation = callback === 'style' ? error : error.errors[1];
      assert.ok(violation instanceof TypeError);
      assert.match(violation.message, /synchronous/);
      if (callback === 'reporter') assert.equal(error.errors[0], original);
      return true;
    });
    await assert.rejects(f.lifecycle.done, error => error === failure);
    await assert.rejects(bounded(f.lifecycle.close()), error => error === failure);
    assert.equal(f.destroyCount(), 1);
    held.reject(new Error('late unsupported callback rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reports.length, 1);
  });
}

test('T6 worker retirement failure still attempts compositor destruction', async () => {
  const f = fixture();
  const original = new Error('iterator cleanup failed');
  await f.lifecycle.start(f.options);
  f.hooks.retire = () => { throw original; };
  await assert.rejects(bounded(f.lifecycle.close()), error => error === original);
  await assert.rejects(f.lifecycle.done, error => error === original);
  assert.equal(f.destroyCount(), 1);
});
