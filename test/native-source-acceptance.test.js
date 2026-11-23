import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createNativeAcceptance} from './native-cluster/native-acceptance.js';
import {createDemoSnapshotWriter} from '../examples/native-cluster/demo-snapshot-evidence.js';
import {SOURCE_DEVELOPMENT, PUBLISHED_PACKAGE} from '../examples/native-cluster/runtime-selection.js';
import {startDemoProcess} from '../examples/native-cluster/demo-process.js';
import {runDemoCohort} from '../examples/native-cluster/demo-cohort.js';

const clean = {code: 0, signal: null};
const selection = Object.freeze({...SOURCE_DEVELOPMENT, specifier: 'file:///admitted/lagrange/src/public-api.js'});
const provenance = {backend: 'lagrange', durable: true, lagrangeVersion: selection.version,
  lagrangeRevision: selection.revision, expectedImagesRevision: selection.imagesRevision, runtimeSelection: selection};
const graph = {descriptor: {name: 'Project', members: ['root', 'denied']}, project: {id: 'project'},
  root: {id: 'root'}, target: {id: 'target'},
  history: Array.from({length: 600}, (_, index) => ({index, value: 'complete-history'.repeat(5)}))};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

async function fixture(t, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oe-native-acceptance-'));
  await mkdir(join(root, 'evidence'), {mode: 0o700});
  const writer = createDemoSnapshotWriter(join(root, 'evidence'));
  const events = [], failures = [], stages = new Map(), stageHistory = [];
  const readyGate = changes.readyGate ?? deferred();
  if (!changes.readyGate) readyGate.resolve();
  const cliExit = deferred(), actionExit = deferred();
  const state = {snapshots: 0, revokes: 0, cliStarts: 0, actionStarts: 0,
    cliStops: 0, actionStops: 0, markers: 0, stdout: '', exited: false, status: null};
  const waits = new Set();
  function notify() { for (const check of [...waits]) check(); }
  function output(text) { state.stdout += text; notify(); }
  function actionClose(status = clean) {
    if (state.exited) return;
    state.exited = true; state.status = status; notify(); actionExit.resolve(status);
  }
  const action = {
    exit: actionExit.promise,
    until(predicate, timeout, label) {
      events.push(['wait', label, timeout]);
      return new Promise((resolve, reject) => {
        const check = () => {
          const value = predicate(state);
          if (value) { waits.delete(check); resolve(value); }
          else if (state.exited) { waits.delete(check); reject(new Error(`${label}: early process exit`)); }
        };
        waits.add(check); check();
      });
    },
    terminate() {
      state.actionStops++; events.push('action-stop');
      if (changes.actionStopError) throw changes.actionStopError;
      actionClose(changes.actionStopStatus ?? clean);
      return actionExit.promise;
    },
  };
  const cli = {
    ready(end) { events.push(['cli-ready', end]); return readyGate.promise; },
    assertAlive() {}, closed: cliExit.promise,
    stop() {
      state.cliStops++; events.push('cli-stop');
      readyGate.reject(new Error('CLI stopped'));
      if (changes.cliStopError) throw changes.cliStopError;
      if (changes.cliCloseGate) return changes.cliCloseGate.promise;
      cliExit.resolve(changes.cliStopStatus ?? clean);
      return cliExit.promise;
    },
  };
  let owner;
  const config = {endpoint: 'http://127.0.0.1:1234', nativeBinary: '/admitted/cli', testBinary: '/admitted/test',
    credentialFile: join(root, 'credential'), runDirectory: root, selection,
    deadline: performance.now() + 30_000,
    onFailure(error) { failures.push(error); changes.onFailure?.(error); },
    onStage(stage, receipt) {
      stageHistory.push({stage, receipt}); events.push(stage); stages.get(stage)?.resolve();
      changes.onStage?.(stage, owner);
    },
    seedControl: {
      async snapshot(deadline) {
        state.snapshots++; events.push(['snapshot', state.snapshots, deadline]);
        if (changes.snapshot) return changes.snapshot(state.snapshots, {writer, deadline});
        const value = state.snapshots === 2 && changes.after ? changes.after : graph;
        return writer.write(value, changes.provenance ?? provenance);
      },
      async revoke(deadline) {
        state.revokes++; events.push(['revoke', deadline]);
        if (changes.revoke) return changes.revoke();
        return {revoked: true};
      },
    },
    async fetchImpl(url, options) {
      events.push('unauthenticated'); assert.equal(url, 'http://127.0.0.1:1234/v1/read');
      assert.equal(options.headers.authorization, undefined); assert.equal(options.redirect, 'error');
      if (changes.fetchImpl) return changes.fetchImpl(url, options);
      return new Response('{}', {status: changes.refusalStatus ?? 401});
    },
    startNative(options) {
      state.cliStarts++; events.push('cli-start');
      assert.deepEqual(options.args, ['view', '--endpoint', 'http://127.0.0.1:1234', '--image', 'native-cluster-demo',
        '--project', 'integration', '--credential-file', config.credentialFile, '--member', 'root']);
      if (changes.startNative) return changes.startNative(options, owner);
      return cli;
    },
    startAction(file, args, options) {
      state.actionStarts++; events.push('action-start');
      assert.equal(file, '/admitted/test');
      assert.deepEqual(args, ['--ignored', '--exact', 'real_cluster_native_navigation', '--nocapture', '--test-threads=1']);
      assert.equal(options.env.OE_CLUSTER_ORACLE, join(root, 'evidence', 'snapshot-1.json'));
      if (changes.actionStart) changes.actionStart(owner);
      if (changes.actionOutput !== null) queueMicrotask(() => {
        output(changes.actionOutput ?? 'test real_cluster_native_navigation ... NATIVE_CLUSTER_REVOKE\n');
        if (changes.earlyExit) actionClose(changes.earlyExit);
      });
      return action;
    },
    async writeMarker(path, value, options) {
      state.markers++; events.push('marker');
      assert.equal(path, join(root, 'revoked')); assert.equal(value, 'revoked\n');
      if (changes.writeMarker) return changes.writeMarker(path, value, options);
      await writeFile(path, value, options);
      output(changes.successOutput ?? 'NATIVE_CLUSTER_ACTIONS_PASSED\n');
      actionClose(changes.actionStatus ?? clean);
    },
  };
  if (changes.makeReader) config.makeReader = changes.makeReader;
  if (changes.now) config.now = changes.now;
  owner = createNativeAcceptance(config);
  t.after(async () => { await owner.stop(); await rm(root, {recursive: true, force: true}); });
  return {root, config, owner, state, events, failures, stageHistory, output, actionClose,
    at(stage) {
      if (stageHistory.some((record) => record.stage === stage)) return Promise.resolve();
      if (!stages.has(stage)) stages.set(stage, deferred());
      return stages.get(stage).promise;
    },
    start: (startupMs = 5000) => owner.ready(performance.now() + startupMs),
  };
}

function errors(status) { return status.error instanceof AggregateError ? status.error.errors : [status.error]; }

test('constructor acquires nothing; retained ready is single-flight and complete history is freshly reread', {timeout: 5000}, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.owner), ['ready', 'assertAlive', 'closed', 'stop']);
  assert.deepEqual(f.events, []);
  const ready = f.start(); assert.equal(f.start(), ready);
  await ready; f.owner.assertAlive();
  assert.deepEqual(await f.owner.closed, {...clean, killed: false, error: null});
  assert.equal(f.state.snapshots, 2); assert.equal(f.state.revokes, 1); assert.equal(f.state.markers, 1);
  assert.equal(f.state.cliStarts, 1); assert.equal(f.state.actionStarts, 1);
  assert.equal(f.state.cliStops, 1); assert.equal(f.state.actionStops, 1);
  assert.equal(f.failures.length, 0);
  assert.ok(f.events.indexOf('cli-stop') < f.events.indexOf('action-start'));
  assert.ok(f.events.indexOf('native-revoked') < f.events.indexOf('after-snapshot'));
  assert.equal(f.stageHistory.find((record) => record.stage === 'baseline-verified').receipt.sequence, 1);
  assert.equal(f.stageHistory.find((record) => record.stage === 'after-verified').receipt.sequence, 2);
  const stop = f.owner.stop(); assert.equal(f.owner.stop(), stop); await stop;
  assert.equal(f.state.cliStops, 1); assert.equal(f.state.actionStops, 1);
});

test('stop before ready forbids the entire journey and preserves a failed closed status', async (t) => {
  const f = await fixture(t), stop = f.owner.stop();
  assert.equal(f.owner.stop(), stop);
  await assert.rejects(f.start(), /stopped before completion/);
  assert.equal((await stop).code, 1); assert.deepEqual(f.events, []);
});

test('an expired original startup budget refuses CLI acquisition instead of granting a fresh 20 seconds', {timeout: 5000}, async (t) => {
  let clock = performance.now();
  const f = await fixture(t, {now: () => clock,
    onStage(stage) { if (stage === 'native-cli') clock += 10_000; }});
  await assert.rejects(f.start(1000), /stage deadline/);
  assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.cliStarts, 0);
});

test('stop during baseline acquisition settles without a late native child', {timeout: 5000}, async (t) => {
  const gate = deferred(); const f = await fixture(t, {snapshot: () => gate.promise});
  const ready = f.start(); await f.at('baseline-snapshot');
  const stopped = await f.owner.stop();
  await assert.rejects(ready, /stopped before completion/); assert.equal(stopped.code, 1);
  gate.resolve({sequence: 1}); await Promise.resolve();
  assert.equal(f.state.cliStarts, 0); assert.equal(f.state.actionStarts, 0);
});

for (const stage of ['native-cli', 'native-actions']) {
  test(`cancellation at ${stage} forbids the next acquisition`, {timeout: 5000}, async (t) => {
    const f = await fixture(t, {onStage(value, owner) { if (value === stage) void owner.stop(); }});
    await f.start().catch(() => {});
    assert.equal((await f.owner.closed).code, 1);
    assert.equal(f.state.cliStarts, stage === 'native-cli' ? 0 : 1);
    assert.equal(f.state.actionStarts, 0); assert.equal(f.state.cliStops, f.state.cliStarts);
  });
}

test('cancellation inside native acquisition retains and closes its late returned owner once', {timeout: 5000}, async (t) => {
  let closed = 0;
  const f = await fixture(t, {startNative(_options, owner) {
    void owner.stop();
    return {ready() { throw new Error('late client cannot become ready'); },
      stop() { closed++; return Promise.resolve(clean); }};
  }});
  await assert.rejects(f.start(), /stopped before completion/);
  assert.equal((await f.owner.closed).code, 1); assert.equal(closed, 1); assert.equal(f.state.actionStarts, 0);
});

test('stop immediately closes CLI during a held readiness wait before awaiting journey unwind', {timeout: 5000}, async (t) => {
  const readyGate = deferred(), f = await fixture(t, {readyGate});
  const ready = f.start(); await f.at('native-cli');
  const stop = f.owner.stop();
  assert.equal(f.state.cliStops, 1);
  await assert.rejects(ready); assert.equal((await stop).code, 1);
  assert.equal(f.state.actionStarts, 0);
});

test('stop during CLI closure cannot start action after the closure eventually succeeds', {timeout: 5000}, async (t) => {
  const cliCloseGate = deferred(), f = await fixture(t, {cliCloseGate});
  await f.start(); const stop = f.owner.stop();
  assert.equal(f.state.cliStops, 1); assert.equal(f.state.actionStarts, 0);
  cliCloseGate.resolve(clean); assert.equal((await stop).code, 1);
  assert.equal(f.state.actionStarts, 0); assert.equal(f.state.cliStops, 1);
});

test('cancellation inside action acquisition retains and immediately terminates the late owner', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {actionOutput: null, actionStart(owner) { void owner.stop(); }});
  await f.start(); assert.equal((await f.owner.closed).code, 1);
  assert.equal(f.state.actionStarts, 1); assert.equal(f.state.actionStops, 1); assert.equal(f.state.revokes, 0);
});

test('stop during revoke closes action before the pending seed request and creates no late marker', {timeout: 5000}, async (t) => {
  const revoke = deferred(), f = await fixture(t, {revoke: () => revoke.promise});
  await f.start(); await f.at('authority-revocation');
  const stop = f.owner.stop(); assert.equal(f.state.actionStops, 1);
  assert.equal((await stop).code, 1);
  revoke.resolve({revoked: true}); await Promise.resolve();
  assert.equal(f.state.markers, 0); assert.equal(f.state.snapshots, 1);
});

test('stop during fresh after-snapshot cannot emit accepted evidence or acquire another child', {timeout: 5000}, async (t) => {
  const after = deferred();
  const f = await fixture(t, {snapshot: (sequence, {writer}) => sequence === 1
    ? writer.write(graph, provenance) : after.promise});
  await f.start(); await f.at('after-snapshot');
  assert.equal((await f.owner.stop()).code, 1); after.resolve({sequence: 2}); await Promise.resolve();
  assert.equal(f.stageHistory.some(({stage}) => stage === 'after-verified'), false);
  assert.equal(f.state.cliStarts, 1); assert.equal(f.state.actionStarts, 1);
});

test('a semantic failure and failing cleanup preserve both causes with one failure callback', {timeout: 5000}, async (t) => {
  const semantic = new Error('revocation refused'), cleanup = new Error('action closure refused');
  const f = await fixture(t, {revoke: async () => { throw semantic; }, actionStopError: cleanup});
  await f.start(); const status = await f.owner.closed;
  assert.deepEqual(errors(status), [semantic, cleanup]); assert.equal(status.error.cause, semantic);
  assert.deepEqual(f.failures, [semantic]); assert.equal((await f.owner.stop()).code, 1);
  assert.equal(f.state.actionStops, 1);
});

for (const changes of [{cliStopStatus: {code: 1, signal: null}},
  {actionStopError: new Error('cleanup-only failure')}, {actionStatus: {code: null, signal: 'SIGKILL'}}]) {
  test('cleanup-only or forced termination cannot turn semantic progress into acceptance', {timeout: 5000}, async (t) => {
    const f = await fixture(t, changes); await f.start();
    assert.equal((await f.owner.closed).code, 1); assert.equal((await f.owner.stop()).code, 1);
    assert.equal(f.failures.length, 1);
  });
}

test('source and package provenance cannot be interchanged even at version 0.4.0', {timeout: 5000}, async (t) => {
  const packageSelection = {...PUBLISHED_PACKAGE, specifier: 'file:///installed/lagrange-server/src/public-api.js'};
  const f = await fixture(t, {provenance: {...provenance, runtimeSelection: packageSelection,
    lagrangeRevision: packageSelection.revision, expectedImagesRevision: packageSelection.imagesRevision}});
  await assert.rejects(f.start(), /provenance/);
  assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.cliStarts, 0);
});

test('a wrong unauthenticated status and rejecting body cancellation preserve the first refusal cause', {timeout: 5000}, async (t) => {
  const cleanup = new Error('response cancellation refused');
  const f = await fixture(t, {fetchImpl: async () => ({status: 200,
    body: {async cancel() { throw cleanup; }}})});
  await assert.rejects(f.start());
  const status = await f.owner.closed;
  assert.equal(status.code, 1); assert.equal(status.error instanceof AggregateError, true);
  assert.match(status.error.errors[0].message, /must reject an absent credential/);
  assert.equal(status.error.errors[1], cleanup); assert.equal(status.error.cause, status.error.errors[0]);
  assert.equal(f.state.cliStarts, 0); assert.equal(f.failures.length, 1);
});

for (const after of [{...graph, history: graph.history.slice(1)}, {...graph, target: {id: 'changed'}}]) {
  test('a changed record or any missing history entry fails the independent full reread', {timeout: 5000}, async (t) => {
    const f = await fixture(t, {after}); await f.start();
    const status = await f.owner.closed; assert.equal(status.code, 1);
    assert.match(status.error.message, /complete records and history/); assert.equal(f.state.snapshots, 2);
  });
}

test('reusing the first receipt cannot pass the second independent snapshot', {timeout: 5000}, async (t) => {
  let receipt;
  const f = await fixture(t, {snapshot: async (_sequence, {writer}) => receipt ??= await writer.write(graph, provenance)});
  await f.start(); const status = await f.owner.closed;
  assert.equal(status.code, 1); assert.match(status.error.message, /sequence/); assert.equal(f.state.snapshots, 2);
});

for (const actionOutput of ['NATIVE_CLUSTER_REVOKE\nNATIVE_CLUSTER_REVOKE\n',
  'prefix-NATIVE_CLUSTER_REVOKE\n', 'NATIVE_CLUSTER_ACTIONS_PASSED\n', '']) {
  test('duplicate, embedded, unrelated or missing revoke text cannot release authority controls', {timeout: 5000}, async (t) => {
    const f = await fixture(t, {actionOutput, earlyExit: clean});
    await f.start(); assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.revokes, 0);
  });
}

test('duplicate revoke markers from a still-running child fail before any revoke request', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {actionOutput: 'NATIVE_CLUSTER_REVOKE\nNATIVE_CLUSTER_REVOKE\n'});
  await f.start(); const status = await f.owner.closed;
  assert.equal(status.code, 1); assert.match(status.error.message, /Exactly one native revoke marker/);
  assert.equal(f.state.revokes, 0); assert.equal(f.state.markers, 0); assert.equal(f.state.actionStops, 1);
});

for (const successOutput of ['', 'prefix-NATIVE_CLUSTER_ACTIONS_PASSED\n',
  'NATIVE_CLUSTER_ACTIONS_PASSED\nNATIVE_CLUSTER_ACTIONS_PASSED\n',
  'NATIVE_CLUSTER_REVOKE\nNATIVE_CLUSTER_ACTIONS_PASSED\n']) {
  test('missing, embedded or duplicate final markers fail without a second revoke', {timeout: 5000}, async (t) => {
    const f = await fixture(t, {successOutput}); await f.start();
    assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.revokes, 1); assert.equal(f.state.snapshots, 1);
  });
}

test('early nonzero action exit is never repaired by a later successful terminate result', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {actionOutput: '', earlyExit: {code: 7, signal: null}});
  await f.start(); assert.equal((await f.owner.closed).code, 1); assert.equal(f.failures.length, 1);
  assert.equal((await f.owner.stop()).code, 1);
});

for (const mode of ['never-ready', 'rust-only', 'early-exit']) {
  test(`actual process-owner ${mode} output cannot satisfy composite startup readiness`, {timeout: 5000}, async (t) => {
    const native = new URL('./fixtures/native-demo/native.mjs', import.meta.url);
    const f = await fixture(t, {startNative(options) {
      return startDemoProcess({...options, file: process.execPath, args: [native.pathname, mode], graceMs: 80});
    }});
    await assert.rejects(f.start(250));
    assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.actionStarts, 0);
  });
}

test('one worker failure while actions wait stops all cohort workers and the retained adapter together', {timeout: 5000}, async (t) => {
  let failWorker, failNative;
  const f = await fixture(t, {actionOutput: null, onFailure(error) { failNative?.(error); }});
  const nodes = ['seed', 'joiner-1', 'joiner-2'].map((id, index) => ({index,
    configuration: {node: {id}}, role: index ? 'joiner' : 'seed'}));
  const stops = [];
  const cohort = runDemoCohort({nodes, signal: new AbortController().signal, startupMs: 3000,
    startWorker(node, fail) {
      failWorker = fail;
      return {ready: async () => {}, assertAlive() {}, stop() { stops.push(node.index); return Promise.resolve(clean); },
        async request(command) {
          if (command === 'start') return {started: true};
          if (command === 'members') return nodes.map(({configuration}) => ({nodeId: configuration.node.id, status: 'active'}));
          return {host: '127.0.0.1', port: 1234, secure: false};
        }};
    },
    startNative(_endpoint, fail) {
      failNative = fail;
      return f.owner;
    },
  });
  const rejected = assert.rejects(cohort, /worker lost/);
  await f.at('native-actions'); failWorker(new Error('worker lost'));
  await rejected;
  assert.deepEqual(stops, [0, 1, 2]); assert.equal(f.state.cliStops, 1); assert.equal(f.state.actionStops, 1);
  assert.equal((await f.owner.closed).code, 1); assert.equal(f.state.revokes, 0);
});
