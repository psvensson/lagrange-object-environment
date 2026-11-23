import test from 'node:test';
import assert from 'node:assert/strict';
import {createServiceLifecycle} from './native-cluster/service-lifecycle.js';
import {ownedProcess} from './native-cluster/process-owner.js';

test('cluster custody: stop awaits late deployment, prevents listen/ready and closes it once', async () => {
  const acquired = Promise.withResolvers();
  let closes = 0, created = 0, ready = 0;
  const owner = createServiceLifecycle({createDeployment: () => acquired.promise,
    createService() { created++; }, ready() { ready++; }});
  const start = owner.start();
  let stopped = false;
  const stop = owner.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  acquired.resolve({close: async () => { closes++; }});
  await Promise.all([start, stop]);
  await owner.stop();
  assert.deepEqual({closes, created, ready}, {closes: 1, created: 0, ready: 0});
});

test('cluster custody: stop during listen suppresses snapshot/ready and drains both acquisitions', async () => {
  const listening = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const events = [];
  const owner = createServiceLifecycle({
    createDeployment: async () => ({service: {}, snapshot() { events.push('snapshot'); }, close() { events.push('deployment-close'); }}),
    createService: async () => ({listen() { entered.resolve(); return listening.promise; }, close() { events.push('service-close'); }}),
    ready() { events.push('ready'); },
  });
  const start = owner.start(); await entered.promise;
  const stop = owner.stop(); listening.resolve({port: 1});
  await Promise.all([start, stop]);
  assert.deepEqual(events, ['service-close', 'deployment-close']);
});

test('cluster custody: service failure cannot skip deployment close or hide cleanup errors', async () => {
  const first = new Error('service-close'); const second = new Error('deployment-close');
  const owner = createServiceLifecycle({
    createDeployment: async () => ({service: {}, snapshot: async () => ({}), close() { throw second; }}),
    createService: async () => ({listen: async () => ({}), close() { throw first; }}), ready() {},
  });
  await owner.start();
  await assert.rejects(owner.stop(), (error) => {
    assert.deepEqual(error.errors, [first, second]); return true;
  });
});

test('cluster custody: startup failure and stop do not await each other', async () => {
  const failure = new Error('acquisition failed');
  const owner = createServiceLifecycle({createDeployment: async () => { throw failure; }, createService() {}, ready() {}});
  await assert.rejects(owner.start(), (error) => error === failure);
  await owner.stop();
});

test('cluster custody: a post-spawn IPC error does not release a live process', {timeout: 20_000}, async () => {
  const owner = ownedProcess(process.execPath, ['-e', 'console.log("owned-ready"); setInterval(() => {}, 1000);']);
  try {
    await owner.until(({stdout}) => stdout.includes('owned-ready'), 5_000, 'fixture ready');
    owner.child.emit('error', new Error('simulated IPC failure'));
    const status = await owner.terminate();
    assert.equal(status.signal, 'SIGTERM');
    assert.equal(status.error, 'simulated IPC failure');
    assert.throws(() => process.kill(owner.child.pid, 0), {code: 'ESRCH'});
  } finally { await owner.terminate(); }
});

test('cluster custody: close evidence includes final buffered output', {timeout: 10_000}, async () => {
  // Parent exit precedes the descendant's final write/pipe close. An exit-based
  // custody owner therefore loses this output deterministically.
  const owner = ownedProcess(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("final-output"), 100)'],
      {stdio: ['ignore', process.stdout, 'ignore']}).unref();
    process.exit(0);
  `]);
  try {
    const result = await owner.until(({exited, stdout, status}) => exited && {stdout, status}, 5_000, 'fixture close');
    assert.deepEqual(result, {stdout: 'final-output', status: {code: 0, signal: null}});
  } finally { await owner.terminate(); }
});
