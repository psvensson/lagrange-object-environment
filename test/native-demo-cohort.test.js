import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {startDemoProcess} from '../examples/native-cluster/demo-process.js';
import {createDemoTopology, demoNodeProcessOptions} from '../examples/native-cluster/demo-config.js';
import {runDemoCohort, exactDemoMembership} from '../examples/native-cluster/demo-cohort.js';

const WORKER = new URL('./fixtures/native-demo/cohort-worker.mjs', import.meta.url);
const NATIVE = fileURLToPath(new URL('./fixtures/native-demo/native.mjs', import.meta.url));
const IDS = ['a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000',
  'c0000000-0000-4000-8000-000000000000'];

async function fixture(t, {mode = 'normal', nativeMode = 'close', startupMs = 2000} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-cohort-'));
  const events = join(root, 'events'); await writeFile(events, '');
  const nodes = createDemoTopology({runDirectory: root, nodeIds: IDS,
    ports: [18000, 18001, 18002, 18003, 18004, 18005, 18006, 18007, 18008]});
  const owners = [], stages = [], failures = [], cleanup = [];
  const controller = new AbortController();
  for (const node of nodes) {
    await writeFile(join(root, `config-${node.index}`), JSON.stringify({index: node.index,
      ids: IDS, events, mode: node.index === 0 ? mode : 'normal'}));
  }
  t.after(async () => { await Promise.all(owners.map((owner) => owner.stop()));
    await rm(root, {recursive: true, force: true}); });
  const options = {nodes, startupMs, pollMs: 5, signal: controller.signal,
    onStage: (stage) => stages.push(stage), onCleanupFailure: (value) => cleanup.push(value),
    startWorker(node, onFailure) {
      const childOptions = demoNodeProcessOptions(process.env, node);
      childOptions.cwd = root; // Fixture has no storage; production allocates each directory.
      const owner = startDemoProcess({file: WORKER, args: [join(root, `config-${node.index}`)],
        worker: true, label: `node-${node.index}`, options: childOptions,
        logFile: join(root, `node-${node.index}.log`), graceMs: 80,
        onFailure(error) { failures.push(error); onFailure(error); }});
      owners.push(owner); return owner;
    },
    startNative(endpoint, onFailure) {
      assert.equal(endpoint, 'http://127.0.0.1:1234');
      const owner = startDemoProcess({file: process.execPath, args: [NATIVE, nativeMode],
        label: 'native', options: {cwd: root}, logFile: join(root, 'native.log'), graceMs: 80,
        onFailure(error) { failures.push(error); onFailure(error); }});
      owners.push(owner); return owner;
    },
  };
  return {root, nodes, owners, options, controller, stages, failures, cleanup,
    events: async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)};
}

test('formation requires the three exact distinct active identities', () => {
  const rows = IDS.map((nodeId) => ({nodeId, status: 'active'}));
  assert.equal(exactDemoMembership(rows, IDS), true);
  assert.equal(exactDemoMembership(rows.slice(0, 2), IDS), false);
  assert.equal(exactDemoMembership(rows.map((row, i) => ({...row, status: i ? 'joining' : 'active'})), IDS), false);
  assert.throws(() => exactDemoMembership([rows[0], rows[0], rows[2]], IDS), /identity/);
  assert.throws(() => exactDemoMembership([...rows.slice(0, 2), {nodeId: 'foreign', status: 'active'}], IDS), /identity/);
  assert.throws(() => exactDemoMembership([...rows, rows[0]], IDS), /membership/);
});

test('three real worker processes precede one install and mapped-native readiness; window close reaps all', {timeout: 5000}, async (t) => {
  const f = await fixture(t); await runDemoCohort(f.options);
  assert.equal(f.owners.length, 4);
  assert.equal(new Set(f.owners.map((owner) => owner.child.pid)).size, 4);
  const events = await f.events();
  assert.deepEqual(events.filter((e) => e.event === 'start').map((e) => e.node), [0, 1, 2]);
  assert.equal(events.filter((e) => e.event === 'install').length, 1);
  const installed = events.findIndex((e) => e.event === 'install');
  assert.ok(events.findIndex((e) => e.node === 2 && e.event === 'start') < installed);
  assert.equal(events.filter((e) => e.event === 'stop').length, 3);
  assert.ok(f.stages.some((s) => s.startsWith('Ready:')));
  assert.equal(f.cleanup.length, 0); assert.equal(f.failures.length, 0);
  for (const owner of f.owners) {
    const result = await owner.closed; assert.equal(result.code, 0); assert.equal(result.killed, false);
  }
});

for (const mode of ['start-fail', 'members-fail', 'install-fail', 'missing-member']) {
  test(`${mode} refuses native launch and stops every acquired worker without retrying writes`, {timeout: 5000}, async (t) => {
    const f = await fixture(t, {mode, startupMs: mode === 'missing-member' ? 250 : 2000});
    await assert.rejects(runDemoCohort(f.options));
    assert.ok(f.owners.length <= 3);
    assert.equal(f.stages.some((s) => s.startsWith('Ready:')), false);
    const events = await f.events();
    assert.ok(events.filter((e) => e.event === 'install').length <= 1);
    if (mode !== 'install-fail') assert.equal(events.some((e) => e.event === 'install'), false);
    for (const owner of f.owners) assert.notEqual((await owner.closed).code, null);
  });
}

for (const nativeMode of ['early-exit', 'never-ready']) {
  test(`${nativeMode} cannot count as native startup success`, {timeout: 5000}, async (t) => {
    const f = await fixture(t, {nativeMode, startupMs: 300});
    await assert.rejects(runDemoCohort(f.options));
    assert.equal(f.stages.some((s) => s.startsWith('Ready:')), false);
    for (const owner of f.owners) await owner.closed;
  });
}

test('cancellation keeps the first cause; TERM-resistant owned group requires reported SIGKILL', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {nativeMode: 'term-resistant'}); const reason = new Error('operator cancelled');
  f.options.onStage = (stage) => { f.stages.push(stage); if (stage.startsWith('Ready:')) f.controller.abort(reason); };
  await assert.rejects(runDemoCohort(f.options), (error) => error === reason);
  assert.ok(f.cleanup.length);
  assert.equal((await f.owners.at(-1).closed).killed, true);
  assert.equal((await f.owners.at(-1).closed).signal, 'SIGKILL');
});

test('already-cancelled cohort spawns nothing', async (t) => {
  const f = await fixture(t); const reason = new Error('already stopped'); f.controller.abort(reason);
  await assert.rejects(runDemoCohort(f.options), (error) => error === reason);
  assert.equal(f.owners.length, 0);
});

test('failed spawn settles separately from the exit and pipe custody path', {timeout: 5000}, async (t) => {
  const f = await fixture(t); const failures = [];
  const owner = startDemoProcess({file: join(f.root, 'absent'), args: [], options: {},
    logFile: join(f.root, 'absent.log'), label: 'absent', onFailure: (error) => failures.push(error), graceMs: 80});
  f.owners.push(owner);
  await assert.rejects(owner.ready(performance.now() + 1000), {code: 'ENOENT'});
  const status = await owner.stop(); assert.equal(status.error.code, 'ENOENT');
  assert.equal(failures.length, 1);
});

test('process exit alone does not release custody while an owned descendant holds output pipes', {timeout: 5000}, async (t) => {
  const f = await fixture(t); const owner = startDemoProcess({file: process.execPath,
    args: [NATIVE, 'held-pipe'], options: {}, logFile: join(f.root, 'held.log'), label: 'held',
    onFailure: (error) => f.failures.push(error), graceMs: 200});
  f.owners.push(owner); let closed = false; owner.closed.then(() => { closed = true; });
  await owner.ready(performance.now() + 1000);
  await sleep(15); assert.equal(closed, false);
  const status = await owner.closed; assert.equal(status.code, 0);
  assert.match(await readFile(join(f.root, 'held.log'), 'utf8'), /descendant-finished/);
});

test('node failure during native interaction closes the native client and every other node', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {nativeMode: 'stay'});
  f.options.onStage = (stage) => {
    f.stages.push(stage);
    if (stage.startsWith('Ready:')) f.owners[1].child.kill('SIGTERM');
  };
  await assert.rejects(runDemoCohort(f.options), /node-1/);
  assert.equal(f.owners.length, 4);
  for (const owner of f.owners) await owner.closed;
});

test('cancellation from a stage observer cannot start another node', async (t) => {
  const f = await fixture(t); const reason = new Error('stopped before acquisition');
  f.options.onStage = (stage) => { if (stage.startsWith('Starting')) f.controller.abort(reason); };
  await assert.rejects(runDemoCohort(f.options), (error) => error === reason);
  assert.equal(f.owners.length, 0);
});

for (const stage of ['Installing', 'Opening']) {
  test(`observer cancellation at ${stage} suppresses its acquisition`, async (t) => {
    const f = await fixture(t); const reason = new Error('observer cancelled');
    const requests = []; const originalStart = f.options.startWorker;
    f.options.startWorker = (...args) => {
      const owner = originalStart(...args); const originalRequest = owner.request;
      owner.request = (command, ...rest) => { requests.push(command); return originalRequest(command, ...rest); };
      return owner;
    };
    f.options.onStage = (value) => { if (value.startsWith(stage)) f.controller.abort(reason); };
    await assert.rejects(runDemoCohort(f.options), (error) => error === reason);
    assert.equal(f.owners.length, 3);
    if (stage === 'Installing') assert.equal(requests.includes('install'), false);
  });
}

for (const mode of ['descendant-resistant-exit', 'descendant-resistant-stay',
  'descendant-graceful-exit', 'descendant-abnormal-exit']) {
  test(`subreaper retains pipe-free ${mode} after payload closure`, {timeout: 5000}, async (t) => {
    const f = await fixture(t); const heartbeat = join(f.root, 'heartbeat');
    const owner = startDemoProcess({file: process.execPath, args: [NATIVE, mode, heartbeat],
      options: {}, logFile: join(f.root, 'descendant.log'), label: 'descendant',
      onFailure: (error) => f.failures.push(error), graceMs: 150});
    f.owners.push(owner);
    await owner.ready(performance.now() + 1000);
    const status = mode.includes('-exit') ? await owner.closed : await owner.stop();
    if (mode.includes('resistant')) { assert.equal(status.killed, true); assert.equal(status.signal, 'SIGKILL'); }
    else if (mode.includes('abnormal')) { assert.equal(status.code, 1); assert.ok(status.error); }
    else { assert.equal(status.code, 0); assert.equal(status.killed, false); assert.equal(status.error, null); }
    const before = await readFile(heartbeat, 'utf8').catch(() => '');
    await sleep(50);
    assert.equal(await readFile(heartbeat, 'utf8').catch(() => ''), before, 'no surviving workload heartbeat');
  });
}

test('saturated ordinary logs cannot hide first operation and cleanup diagnostics', {timeout: 5000}, async (t) => {
  const f = await fixture(t, {mode: 'saturated-failure'});
  await assert.rejects(runDemoCohort(f.options));
  const log = await readFile(join(f.root, 'node-0.log'));
  assert.equal(log.length, 4 * 1024 * 1024);
  assert.match(log.toString('utf8'), /ordinary demo log truncated/);
  const records = (await readFile(join(f.root, 'node-0.log.diagnostics'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter((record) => record.phase === 'operation').length, 1);
  assert.equal(records.filter((record) => record.phase === 'cleanup').length, 1);
  assert.match(JSON.stringify(records), /saturated-operation/);
  assert.match(JSON.stringify(records), /saturated-cleanup/);
});
