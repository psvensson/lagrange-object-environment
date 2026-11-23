import assert from 'node:assert/strict';
import test from 'node:test';
import {Session} from '../src/model.js';
import {createCompositor} from '../src/compositor.js';
import {createSessionThemeLifecycle, SessionThemeStartupCancelledError} from '../src/session-theme-lifecycle.js';

const IMAGE = 'theme-session';
const REF = {kind: 'ref', imageId: IMAGE, objectId: 'theme/root'};
const STOCK = Object.freeze([{path: 'accent', type: 'color', value: '#112233'}]);
const DERIVED = Object.freeze([{path: 'accent', type: 'color', value: '#445566'}]);
const START = Object.freeze({
  selection: {kind: 'catalog-default', imageId: IMAGE},
  authority: Object.freeze({principal: 'user', opaque: 'grant'}),
  blockId: 'read-block', observationBlockId: 'observe-block',
});
const flush = async () => {for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));};

function gate() {
  let release;
  const held = new Promise(resolve => {release = resolve;});
  return {held, release};
}

function mockEnvironment({holdStartup, failStartup, reportError, customSetter} = {}) {
  const calls = [];
  const errors = [];
  const session = new Session({principal: {principalRef: 'authenticated-user'}});
  let options;
  const c = new AbortController();
  let resolveDone;
  const done = new Promise(resolve => {resolveDone = resolve;});
  const follow = Object.freeze({
    signal: c.signal,
    done,
    stop() {
      if (!c.signal.aborted) {
        calls.push(['stop']);
        c.abort();
        resolveDone();
      }
    },
  });
  const renderer = {
    async createSurface() {return 'tool';},
    async attachPresentation() {},
    async detachPresentation() {},
    async resize() {},
    async destroySurface() {},
    async destroyAll() {calls.push(['destroyAll']);},
  };
  const compositor = createCompositor({rendererAdapter: renderer});
  const themeResolver = {
    async followCatalogDefault(args) {
      options = args;
      calls.push(['catalog', args]);
      if (holdStartup) await holdStartup.held;
      if (failStartup) throw failStartup;
      args.onUpdate({themeRef: REF, tokens: STOCK}, null);
      return follow;
    },
    async followTheme(args) {
      options = args;
      calls.push(['explicit', args]);
      if (holdStartup) await holdStartup.held;
      if (failStartup) throw failStartup;
      args.onUpdate({themeRef: REF, tokens: STOCK}, null);
      return follow;
    },
  };
  const lifecycle = createSessionThemeLifecycle({
    session, compositor, themeResolver,
    setResolvedTokens: customSetter ?? (tokens => calls.push(['style', tokens])),
    onThemeError: reportError ?? (error => errors.push(error)),
  });
  return {session, compositor, lifecycle, follow, calls, errors,
    get options() {return options;}};
}

test('T6 requires exact existing owners and one external Session', () => {
  assert.throws(() => createSessionThemeLifecycle(), /requires a Session/);
  const session = new Session({principal: 's'});
  assert.throws(() => createSessionThemeLifecycle({session}), /its Compositor/);
  assert.throws(() => createSessionThemeLifecycle({session, compositor: {destroy() {}}}), /existing ThemeResolver/);
  assert.throws(() => createSessionThemeLifecycle({session, compositor: {destroy() {}},
    themeResolver: {followCatalogDefault() {}, followTheme() {}}}), /host style and error callbacks/);
});

test('T6 starts one explicit catalog follow and closes it before compositor teardown exactly once', async () => {
  const f = mockEnvironment();
  assert.equal(f.lifecycle.status(), 'new');
  const started = await f.lifecycle.start(START);
  assert.deepEqual(started, {status: 'active'});
  assert.equal(f.lifecycle.status(), 'active');
  assert.equal(f.options.authority, START.authority);
  assert.equal(f.options.blockId, START.blockId);
  assert.equal(f.options.observationBlockId, START.observationBlockId);
  assert.equal(f.options.imageId, IMAGE);
  assert.deepEqual(f.calls.filter(c => c[0] === 'style'), [['style', STOCK]]);
  assert.equal(f.session.get('theme'), undefined, 'no Theme enters Session.state');
  assert.throws(() => f.lifecycle.start(START), /exactly once/);
  const closing = f.lifecycle.close();
  assert.equal(closing, f.lifecycle.close(), 'close must be single-flight');
  await closing;
  assert.equal(f.lifecycle.status(), 'closed');
  assert.deepEqual(f.calls.filter(c => ['stop', 'destroyAll'].includes(c[0])),
    [['stop'], ['destroyAll']], 'stop observation BEFORE compositor.destroy exactly once');
  assert.deepEqual(f.errors, []);
  assert.throws(() => f.lifecycle.start(START), /exactly once/);
});

test('T6 an explicitly selected ref is passed to the SAME ThemeResolver owner unchanged', async () => {
  const f = mockEnvironment();
  const selection = {kind: 'explicit', themeRef: REF};
  await f.lifecycle.start({...START, selection});
  assert.equal(f.calls[0][0], 'explicit');
  assert.equal(f.options.themeRef, REF, 'a locator is forwarded, never copied or treated as a grant');
  assert.equal(f.options.authority, START.authority);
  await f.lifecycle.close();
});

test('T6 input validation never creates a follow or silently selects a default', async () => {
  const f = mockEnvironment();
  for (const selection of [null, undefined, {}, {kind: 'guess'},
    {kind: 'catalog-default', imageId: ''},
    {kind: 'catalog-default', imageId: IMAGE, fallback: 'hardcoded'},
    {kind: 'explicit', themeRef: REF, defaultTheme: REF}]) {
    assert.throws(() => f.lifecycle.start({...START, selection}), TypeError);
  }
  assert.throws(() => f.lifecycle.start({...START, authority: null}), TypeError);
  assert.equal(f.calls.length, 0);
  await f.lifecycle.close();
});

test('T6 a failed authorized refresh withdraws Theme and reports the original error exactly once', async () => {
  const f = mockEnvironment();
  await f.lifecycle.start(START);
  const denied = Object.assign(new Error('read denied'), {name: 'AuthorityError'});
  f.options.onError(denied);
  assert.equal(f.lifecycle.status(), 'failed');
  assert.deepEqual(f.calls.filter(x => x[0] === 'style'), [['style', STOCK], ['style', null]]);
  assert.deepEqual(f.errors, [denied]);
  f.options.onError(denied); // later callbacks cannot double-report/withdraw
  assert.equal(f.errors.length, 1);
  await f.lifecycle.close();
  assert.equal(f.calls.filter(x => x[0] === 'destroyAll').length, 1);
});

test('T6 failed initial authorized read rejects startup and reports without a fallback', async () => {
  const error = Object.assign(new Error('catalog not readable'), {name: 'AuthorityError'});
  const f = mockEnvironment({failStartup: error});
  await assert.rejects(f.lifecycle.start(START), e => e === error);
  assert.equal(f.lifecycle.status(), 'failed');
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.calls.filter(x => x[0] === 'style'), [['style', null]]);
  await f.lifecycle.close();
});

test('T6 close wins a held startup; startup rejects distinctly with no Theme error or late styling', async () => {
  const held = gate();
  const f = mockEnvironment({holdStartup: held});
  const starting = f.lifecycle.start(START);
  await flush();
  assert.equal(f.lifecycle.status(), 'starting');
  const closing = f.lifecycle.close();
  held.release();
  await assert.rejects(starting, SessionThemeStartupCancelledError);
  await closing;
  assert.deepEqual(f.errors, [], 'intentional cancellation is not a lower Theme failure');
  assert.deepEqual(f.calls.filter(x => x[0] === 'style'), [],
    'the queued initial update cannot style the closed Session');
  assert.equal(f.lifecycle.status(), 'closed');
  assert.equal(f.calls.filter(x => x[0] === 'destroyAll').length, 1);
});

test('T6 no late callbacks style a closed Session after held refresh or teardown', async () => {
  const f = mockEnvironment();
  await f.lifecycle.start(START);
  await f.lifecycle.close();
  f.options.onUpdate({tokens: DERIVED}, {kind: 'object.put', objectId: 'root'});
  f.options.onError(new Error('late lower failure'));
  assert.deepEqual(f.calls.filter(x => x[0] === 'style'), [['style', STOCK]]);
  assert.deepEqual(f.errors, []);
});

test('T6 two simultaneous Sessions own isolated Theme and close lifetimes', async () => {
  const a = mockEnvironment();
  const b = mockEnvironment();
  await a.lifecycle.start(START);
  await b.lifecycle.start(START);
  a.options.onUpdate({tokens: DERIVED}, {kind: 'object.put', objectId: 'a'});
  assert.deepEqual(a.calls.filter(x => x[0] === 'style').at(-1), ['style', DERIVED]);
  assert.deepEqual(b.calls.filter(x => x[0] === 'style').at(-1), ['style', STOCK]);
  await a.lifecycle.close();
  b.options.onUpdate({tokens: DERIVED}, {kind: 'object.put', objectId: 'b'});
  assert.equal(b.lifecycle.status(), 'active');
  assert.deepEqual(b.calls.filter(x => x[0] === 'style').at(-1), ['style', DERIVED]);
  assert.equal(b.calls.filter(x => x[0] === 'destroyAll').length, 0);
  await b.lifecycle.close();
});

test('T6 a synchronous error reporter can trigger close without deadlocking its own callback', async () => {
  let f;
  let closing;
  const errors = [];
  f = mockEnvironment({reportError(error) {
    errors.push(error);
    closing = f.lifecycle.close(); // explicitly not awaited by the reporter
  }});
  await f.lifecycle.start(START);
  f.options.onError(new Error('invalid Theme'));
  await closing;
  assert.equal(f.lifecycle.status(), 'closed');
  assert.equal(errors.length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'destroyAll').length, 1);
});

test('T6 an async error reporter is rejected without awaiting it or deadlocking close', async () => {
  const reporterError = new Error('asynchronous reporter rejected');
  const f = mockEnvironment({reportError() {
    return Promise.reject(reporterError);
  }});
  await f.lifecycle.start(START);
  assert.throws(() => f.options.onError(new Error('read failure')), AggregateError);
  await assert.rejects(f.lifecycle.close(), AggregateError);
  await flush();
  assert.equal(f.calls.filter(x => x[0] === 'destroyAll').length, 1);
});

test('T6 failing style withdrawal preserves BOTH original Theme and withdrawal failures', async () => {
  const withdrawalError = new Error('browser cannot withdraw CSS');
  const f = mockEnvironment({customSetter(tokens) {
    if (tokens === null) throw withdrawalError;
  }});
  await f.lifecycle.start(START);
  const original = new Error('permission revoked');
  f.options.onError(original);
  assert.equal(f.errors.length, 1);
  assert.ok(f.errors[0] instanceof AggregateError);
  assert.equal(f.errors[0].errors[0], original);
  assert.equal(f.errors[0].errors[1], withdrawalError);
  await f.lifecycle.close();
});
