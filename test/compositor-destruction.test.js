import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {RendererResourceLostError} from '../src/renderer-errors.js';
import {Session} from '../src/model.js';
import {createSessionThemeLifecycle} from '../src/session-theme-lifecycle.js';
import {createThemeResolver} from '../src/theme-resolver.js';

const descriptor = objectId => ({kind: 'inspector',
  subject: {kind: 'ref', imageId: 'drain-proof', objectId}, parameters: {}});
const view = viewId => ({viewId, viewDescriptor: {kind: 'surface', width: 80, height: 60},
  presentationDescriptor: descriptor(viewId)});
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// Observe rejections immediately, including the deliberately red baseline.
// Assertions run after every held operation has been released and retired.
function observe(promise) {
  const result = {status: 'pending'};
  const done = Promise.resolve(promise).then(value => {
    Object.assign(result, {status: 'fulfilled', value});
    return result;
  }, reason => {
    Object.assign(result, {status: 'rejected', reason});
    return result;
  });
  return {promise, result, done};
}

function snapshot(compositor, base, viewId, handle) {
  return {status: compositor.viewStatus(viewId), live: compositor.liveView(viewId),
    handle: compositor.surfaceHandleForView(viewId),
    fromHandle: handle ? compositor.viewForSurfaceHandle(handle) : null,
    focus: compositor.focusedView(), intent: compositor.durableIntent(),
    resources: base.liveResourceCount()};
}

function assertRetired(state) {
  assert.deepEqual(state, {status: null, live: null, handle: null, fromHandle: null,
    focus: null, intent: [], resources: 0}, 'destruction leaves no logical or concrete resource');
}

function assertLost(result) {
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof RendererResourceLostError);
}

// Hold one selected invocation inside the adapter, either before it allocates
// anything or after its effect but before its promise settles. Unarmed calls
// use the ordinary fake renderer and retain normal operation concurrency.
function heldRenderer(method, {effectBeforePause = true, failure = null} = {}) {
  const base = createFakeRendererAdapter();
  const entered = deferred();
  const release = deferred();
  const order = [];
  let armed = false;
  let destroys = 0;
  let compensations = 0;
  const adapter = {...base,
    async [method](...args) {
      if (!armed) return base[method](...args);
      armed = false;
      let result;
      if (effectBeforePause) result = await base[method](...args);
      order.push('held-entered');
      entered.resolve();
      try {
        await release.promise;
        if (failure) throw failure;
        if (!effectBeforePause) result = await base[method](...args);
        return result;
      } finally { order.push('held-retired'); }
    },
    destroyAll() {
      destroys++;
      order.push('destroyAll');
      return base.destroyAll();
    },
  };
  const destroySurface = adapter.destroySurface;
  adapter.destroySurface = (...args) => { compensations++; return destroySurface(...args); };
  return {base, adapter, entered, release, order, arm: () => { armed = true; },
    destroys: () => destroys, compensations: () => compensations};
}

test('3zx destroy drains held creation, refuses new work, and never attaches or republishes the late view', async () => {
  const f = heldRenderer('createSurface', {effectBeforePause: false});
  const compositor = createCompositor({rendererAdapter: f.adapter});
  f.arm();
  const opening = observe(compositor.openView(view('held-create')));
  const outcomes = [opening];
  let beforeRelease;
  let finalState;
  let focusError;
  try {
    await f.entered.promise;
    const closing = observe(compositor.destroy());
    outcomes.push(closing);
    const denied = [
      compositor.openView(view('after-close')),
      compositor.presentOn('held-create', descriptor('after-close')),
      compositor.resizeView('held-create', {width: 4, height: 4}),
      compositor.closeView('held-create'),
    ].map(observe);
    outcomes.push(...denied);
    try { compositor.focusView('held-create'); } catch (error) { focusError = error; }
    await turn();
    beforeRelease = {closing: closing.result.status, destroys: f.destroys()};
    f.release.resolve();
    await Promise.all(outcomes.map(outcome => outcome.done));
    finalState = snapshot(compositor, f.base, 'held-create');
  } finally {
    f.release.resolve();
    await Promise.all(outcomes.map(outcome => outcome.done));
    await f.base.destroyAll();
  }
  assert.deepEqual(beforeRelease, {closing: 'pending', destroys: 0});
  assertLost(opening.result);
  assert.equal(outcomes[1].result.status, 'fulfilled');
  for (const outcome of outcomes.slice(2)) assertLost(outcome.result);
  assert.ok(focusError instanceof RendererResourceLostError);
  assert.equal(f.base.calls().filter(call => call.method === 'attachPresentation').length, 0,
    'a create admitted before close cannot advance to attach afterward');
  assert.equal(f.compensations(), 1, 'the validated late-created handle is compensated exactly once');
  assert.equal(f.destroys(), 1);
  assertRetired(finalState);
});

for (const rejects of [false, true]) {
  test(`3zx destroy waits for held open attach ${rejects ? 'failure' : 'success'} without resurrecting live or lost intent`, async () => {
    const primary = rejects ? new Error('held attach failed') : null;
    const f = heldRenderer('attachPresentation', {failure: primary});
    const compositor = createCompositor({rendererAdapter: f.adapter});
    f.arm();
    const opening = observe(compositor.openView(view('held-attach')));
    let closing;
    let beforeRelease;
    let finalState;
    try {
      await f.entered.promise;
      closing = observe(compositor.destroy());
      await turn();
      beforeRelease = {closing: closing.result.status, destroys: f.destroys(), resources: f.base.liveResourceCount()};
      f.release.resolve();
      await Promise.all([opening.done, closing.done]);
      finalState = snapshot(compositor, f.base, 'held-attach');
    } finally {
      f.release.resolve();
      await Promise.all([opening.done, closing?.done]);
      await f.base.destroyAll();
    }
    assert.deepEqual(beforeRelease, {closing: 'pending', destroys: 0, resources: 1});
    assertLost(opening.result);
    if (primary) assert.equal(opening.result.reason.cause, primary, 'the original adapter failure remains primary');
    assert.equal(closing.result.status, 'fulfilled', 'the caller owns its operation failure, not Session teardown');
    assert.equal(f.compensations(), 1);
    assert.deepEqual(f.order, ['held-entered', 'held-retired', 'destroyAll']);
    assertRetired(finalState);
  });
}

test('3zx destruction drains failed-open compensation, preserving the attach error when compensation also fails', async () => {
  const attachError = new Error('original attach failure');
  const compensationError = new Error('held compensation failure');
  const f = heldRenderer('destroySurface', {effectBeforePause: false, failure: compensationError});
  const compositor = createCompositor({rendererAdapter: {...f.adapter,
    attachPresentation() { return Promise.reject(attachError); },
  }});
  f.arm();
  const opening = observe(compositor.openView(view('failed-open')));
  let closing;
  let beforeRelease;
  let finalState;
  try {
    await f.entered.promise;
    closing = observe(compositor.destroy());
    await turn();
    beforeRelease = {opening: opening.result.status, closing: closing.result.status, destroys: f.destroys()};
    f.release.resolve();
    await Promise.all([opening.done, closing.done]);
    finalState = snapshot(compositor, f.base, 'failed-open');
  } finally {
    f.release.resolve();
    await Promise.all([opening.done, closing?.done]);
    await f.base.destroyAll();
  }
  assert.deepEqual(beforeRelease, {opening: 'pending', closing: 'pending', destroys: 0});
  assertLost(opening.result);
  assert.equal(opening.result.reason.cause, attachError);
  assert.equal(closing.result.status, 'fulfilled');
  assert.equal(f.compensations(), 1, 'failed compensation is not retried per surface');
  assert.deepEqual(f.order, ['held-entered', 'held-retired', 'destroyAll']);
  assertRetired(finalState);
});

for (const method of ['detachPresentation', 'attachPresentation', 'resize', 'destroySurface']) {
  test(`3zx destruction drains an admitted ${method} and the caller cannot publish success after close`, async () => {
    const f = heldRenderer(method);
    const compositor = createCompositor({rendererAdapter: f.adapter});
    await compositor.openView(view('existing'));
    const handle = compositor.surfaceHandleForView('existing');
    compositor.focusView('existing');
    f.arm();
    const operation = observe(method === 'resize'
      ? compositor.resizeView('existing', {width: 40, height: 30})
      : method === 'destroySurface' ? compositor.closeView('existing')
        : compositor.presentOn('existing', descriptor('replacement')));
    let closing;
    let beforeRelease;
    let finalState;
    try {
      await f.entered.promise;
      closing = observe(compositor.destroy());
      const logicalStateAtClose = {view: compositor.liveView('existing'),
        handle: compositor.surfaceHandleForView('existing'), focus: compositor.focusedView(),
        intent: compositor.durableIntent()};
      await turn();
      beforeRelease = {closing: closing.result.status, destroys: f.destroys(), logicalStateAtClose};
      f.release.resolve();
      await Promise.all([operation.done, closing.done]);
      finalState = snapshot(compositor, f.base, 'existing', handle);
    } finally {
      f.release.resolve();
      await Promise.all([operation.done, closing?.done]);
      await f.base.destroyAll();
    }
    assert.deepEqual(beforeRelease, {closing: 'pending', destroys: 0,
      logicalStateAtClose: {view: null, handle: null, focus: null, intent: []}});
    assertLost(operation.result);
    assert.equal(closing.result.status, 'fulfilled');
    assert.deepEqual(f.order, ['held-entered', 'held-retired', 'destroyAll']);
    if (method === 'detachPresentation') {
      assert.equal(f.base.calls().filter(call => call.method === 'attachPresentation').length, 1,
        'only initial open attaches: replacement cannot start after the held detach returns');
    }
    assertRetired(finalState);
  });
}

test('3zx destruction waits for every independently admitted operation without serializing their normal admission', async () => {
  const base = createFakeRendererAdapter();
  const gates = [deferred(), deferred()];
  const entered = [];
  let destroys = 0;
  const compositor = createCompositor({rendererAdapter: {...base,
    async createSurface(descriptor) {
      const ordinal = entered.length;
      entered.push(ordinal);
      await gates[ordinal].promise;
      return base.createSurface(descriptor);
    },
    destroyAll() { destroys++; return base.destroyAll(); },
  }});
  const first = observe(compositor.openView(view('first')));
  const second = observe(compositor.openView(view('second')));
  const independentlyEntered = entered.slice();
  const closing = observe(compositor.destroy());
  let afterOne;
  let finalState;
  try {
    gates[0].resolve();
    await turn();
    afterOne = {first: first.result.status, second: second.result.status,
      closing: closing.result.status, destroys};
    gates[1].resolve();
    await Promise.all([first.done, second.done, closing.done]);
    finalState = snapshot(compositor, base, 'second');
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.all([first.done, second.done, closing.done]);
    await base.destroyAll();
  }
  assert.deepEqual(independentlyEntered, [0, 1], 'each renderer operation is invoked before either other operation settles');
  assert.deepEqual(afterOne, {first: 'rejected', second: 'pending', closing: 'pending', destroys: 0});
  assertLost(first.result);
  assertLost(second.result);
  assert.equal(closing.result.status, 'fulfilled');
  assert.equal(destroys, 1);
  assertRetired(finalState);
});

test('3zx a renderer synchronously reentering destroy during create is already included in the drain', async () => {
  const base = createFakeRendererAdapter();
  let compositor;
  let reentrant;
  let destroys = 0;
  const order = [];
  compositor = createCompositor({rendererAdapter: {...base,
    createSurface(descriptor) {
      order.push('create-entered');
      reentrant = compositor.destroy();
      order.push('create-returning');
      return base.createSurface(descriptor);
    },
    destroyAll() { destroys++; order.push('destroyAll'); return base.destroyAll(); },
  }});
  const opening = observe(compositor.openView(view('reentrant-create')));
  const closing = observe(reentrant);
  const repeated = compositor.destroy();
  const destroysBeforeCreateRetires = destroys;
  await Promise.all([opening.done, closing.done]);
  const finalState = snapshot(compositor, base, 'reentrant-create');
  await base.destroyAll();
  assert.equal(destroysBeforeCreateRetires, 0);
  assert.equal(repeated, reentrant, 'reentrant and outer callers receive the same terminal Promise');
  assertLost(opening.result);
  assert.equal(closing.result.status, 'fulfilled');
  assert.deepEqual(order, ['create-entered', 'create-returning', 'destroyAll']);
  assert.equal(base.calls().filter(call => call.method === 'attachPresentation').length, 0);
  assertRetired(finalState);
});

test('3zx a custom thenable can reenter destruction from its getter and invocation without escaping operation or compensation retirement', async () => {
  const base = createFakeRendererAdapter();
  const creationRelease = deferred();
  const compensationRelease = deferred();
  const thenEntered = deferred();
  let compositor;
  let getterDestruction;
  let invocationDestruction;
  let getterCalls = 0;
  let invocationCalls = 0;
  let compensations = 0;
  let destroys = 0;
  const order = [];
  compositor = createCompositor({rendererAdapter: {...base,
    createSurface(descriptor) {
      return {get then() {
        getterCalls++;
        getterDestruction = compositor.destroy();
        return (resolve, reject) => {
          invocationCalls++;
          invocationDestruction = compositor.destroy();
          thenEntered.resolve();
          creationRelease.promise.then(() => base.createSurface(descriptor)).then(resolve, reject);
        };
      }};
    },
    destroySurface(handle) {
      compensations++;
      order.push('compensation-entered');
      return compensationRelease.promise.then(() => base.destroySurface(handle)).then(() => {
        order.push('compensation-retired');
      });
    },
    destroyAll() { destroys++; order.push('destroyAll'); return base.destroyAll(); },
  }});
  const opening = observe(compositor.openView(view('thenable-create')));
  const closing = observe(getterDestruction);
  let beforeCreation;
  let duringCompensation;
  let finalState;
  try {
    await thenEntered.promise;
    await turn();
    beforeCreation = {closing: closing.result.status, destroys, compensations};
    creationRelease.resolve();
    // The baseline never compensates this late successful creation. Observe
    // a whole turn instead of waiting for an event the wrong code cannot emit.
    await turn();
    duringCompensation = {opening: opening.result.status, closing: closing.result.status,
      destroys, compensations, resources: base.liveResourceCount()};
    compensationRelease.resolve();
    await Promise.all([opening.done, closing.done]);
    finalState = snapshot(compositor, base, 'thenable-create');
  } finally {
    creationRelease.resolve();
    compensationRelease.resolve();
    await Promise.all([opening.done, closing.done]);
    await base.destroyAll();
  }
  assert.equal(getterCalls, 1);
  assert.equal(invocationCalls, 1);
  assert.equal(getterDestruction, invocationDestruction);
  assert.equal(compositor.destroy(), getterDestruction);
  assert.deepEqual(beforeCreation, {closing: 'pending', destroys: 0, compensations: 0});
  assert.deepEqual(duringCompensation, {opening: 'pending', closing: 'pending',
    destroys: 0, compensations: 1, resources: 1});
  assertLost(opening.result);
  assert.equal(closing.result.status, 'fulfilled');
  assert.deepEqual(order, ['compensation-entered', 'compensation-retired', 'destroyAll']);
  assert.equal(base.calls().filter(call => call.method === 'attachPresentation').length, 0);
  assertRetired(finalState);
});

for (const typed of [false, true]) {
  test(`3zx held ${typed ? 'typed' : 'raw'} teardown failure is one shared result, including synchronous reentry and later calls`, async () => {
    const base = createFakeRendererAdapter();
    const release = deferred();
    const failure = typed ? new RendererResourceLostError('typed teardown') : new Error('raw teardown');
    let compositor;
    let reentrant;
    let destroys = 0;
    compositor = createCompositor({rendererAdapter: {...base,
      destroyAll() {
        destroys++;
        reentrant = compositor.destroy();
        return release.promise.then(async () => { await base.destroyAll(); throw failure; });
      },
    }});
    const first = observe(compositor.destroy());
    const second = observe(compositor.destroy());
    const nested = observe(reentrant);
    let beforeRelease;
    try {
      await turn();
      beforeRelease = [first.result.status, second.result.status, nested.result.status];
    } finally {
      release.resolve();
      await Promise.all([first.done, second.done, nested.done]);
    }
    const later = observe(compositor.destroy());
    await later.done;
    assert.equal(destroys, 1, 'an idle compositor invokes concrete teardown immediately and only once');
    assert.deepEqual(beforeRelease, ['pending', 'pending', 'pending']);
    assert.equal(first.promise, second.promise);
    assert.equal(first.promise, nested.promise);
    assert.equal(first.promise, later.promise);
    assertLost(first.result);
    for (const result of [second.result, nested.result, later.result]) {
      assertLost(result);
      assert.equal(result.reason, first.result.reason, 'teardown rejection is retained, never replaced by success');
    }
    if (typed) assert.equal(first.result.reason, failure);
    else assert.equal(first.result.reason.cause, failure);
  });
}

test('3zx Session close aborts and retires Theme following while an admitted renderer operation remains held', async () => {
  const imageId = 'drain-proof';
  const ref = objectId => ({kind: 'ref', imageId, objectId});
  const text = value => ({kind: 'text', value});
  const tokens = JSON.parse(readFileSync(new URL('./fixtures/theme/stock-tokens.json', import.meta.url)));
  const records = new Map(tokens.map(token => [token.path, {slots: {
    format: text('environment-design-token/v1'), path: text(token.path), type: text(token.type),
    value: typeof token.value === 'number' ? {kind: 'integer', value: String(token.value)} : text(token.value),
  }, indexed: [], versionToken: 'opaque'}]));
  records.set('theme', {slots: {format: text('environment-theme/root/v1'), name: text('Drain proof')},
    indexed: tokens.map(token => ref(token.path)), versionToken: 'opaque'});
  const authority = {opaque: 'session-specific authority'};
  let signal;
  let waiter;
  let retired = false;
  const requests = [];
  const resolver = createThemeResolver({
    async readObject(request) { requests.push(request); return records.get(request.objectId); },
    async observePull(request) { requests.push(request); return {events: [], cursor: 'opaque:anchor'}; },
    observe(_imageId, options) {
      signal = options.signal;
      requests.push(options);
      return {[Symbol.asyncIterator]() { return {
        next() { return new Promise(resolve => { waiter = resolve; }); },
        return() { retired = true; waiter?.({done: true}); return Promise.resolve({done: true}); },
      }; }};
    },
  });
  const f = heldRenderer('createSurface', {effectBeforePause: false});
  const styles = [];
  const reports = [];
  const lifecycle = createSessionThemeLifecycle({session: new Session({principal: 'descriptive-principal'}),
    rendererAdapter: {...f.adapter, setResolvedTokens(values) { styles.push(values); }},
    themeResolver: resolver, onThemeError(error) { reports.push(error); }});
  await lifecycle.start({selection: {kind: 'explicit', themeRef: ref('theme')}, authority,
    blockId: 'read-binding', observationBlockId: 'observe-binding'});
  const following = observe(lifecycle.done);
  f.arm();
  const opening = observe(lifecycle.compositor.openView(view('theme-held')));
  let closing;
  let beforeRelease;
  let finalState;
  try {
    await f.entered.promise;
    closing = observe(lifecycle.close());
    const abortedSynchronously = signal.aborted;
    await turn();
    beforeRelease = {abortedSynchronously, retired, following: following.result.status,
      closing: closing.result.status, destroys: f.destroys()};
    f.release.resolve();
    await Promise.all([opening.done, following.done, closing.done]);
    finalState = snapshot(lifecycle.compositor, f.base, 'theme-held');
  } finally {
    f.release.resolve();
    await Promise.all([opening.done, following.done, closing?.done]);
    await f.base.destroyAll();
  }
  assert.deepEqual(beforeRelease, {abortedSynchronously: true, retired: true,
    following: 'fulfilled', closing: 'pending', destroys: 0});
  assertLost(opening.result);
  assert.equal(closing.result.status, 'fulfilled');
  assert.equal(f.destroys(), 1);
  assert.equal(styles.length, 1);
  assert.deepEqual(reports, []);
  assert.ok(requests.length > tokens.length);
  assert.ok(requests.every(request => request.authority === authority), 'every controlled read/follow retains the caller authority');
  assertRetired(finalState);
});
