import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDemoNodeLifecycle} from '../examples/native-cluster/demo-node-lifecycle.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fixture(overrides = {}) {
  const events = [];
  const runtime = {async start() { events.push('start'); }, async stop() { events.push('runtime-close'); },
    openApplicationDatabase(options) {
      events.push(['database', options.applicationId]);
      return {async query(sql) { events.push(sql); return {rows: [{node_id: 'seed', status: 'active'}]}; }};
    }};
  const deployment = {service: {}, async close() { events.push('deployment-close'); }};
  const service = {async listen(options) { events.push(['listen', options]); return {host: '127.0.0.1', port: 1234, secure: false}; },
    async close() { events.push('service-close'); }};
  const lifecycle = createDemoNodeLifecycle({configuration: {node: {id: 'seed'}}, role: 'seed',
    createRuntime() { events.push('create-runtime'); return runtime; },
    async createDeployment(input) { assert.deepEqual(Object.keys(input), ['start', 'openApplicationDatabase', 'stop']); events.push('install'); return deployment; },
    async createService(input) { assert.equal(input, deployment.service); events.push('create-service'); return service; },
    ...overrides});
  return {lifecycle, events, runtime, deployment, service};
}

test('one worker uses public runtime then one installation; closes in dependency order', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.run('install'), /expected started/);
  assert.deepEqual(await f.lifecycle.run('start'), {started: true});
  assert.deepEqual(await f.lifecycle.run('members'), [{nodeId: 'seed', status: 'active'}]);
  assert.deepEqual(await f.lifecycle.run('install'), {host: '127.0.0.1', port: 1234, secure: false});
  await assert.rejects(f.lifecycle.run('install'), /expected started/);
  await f.lifecycle.stop(); await f.lifecycle.stop();
  assert.deepEqual(f.events, ['create-runtime', 'start', ['database', 'oe-native-demo-operator'],
    'SELECT node_id, status FROM nodes', 'install', 'create-service',
    ['listen', {host: '127.0.0.1', port: 0}], 'service-close', 'deployment-close', 'runtime-close']);
  await assert.rejects(f.lifecycle.run('start'), /stopping/);
});

test('joiners cannot install and concurrent requests refuse without acquiring another runtime', async () => {
  const gate = deferred();
  const f = fixture({role: 'joiner'});
  f.runtime.start = () => gate.promise;
  const start = f.lifecycle.run('start');
  await assert.rejects(f.lifecycle.run('start'), /already pending/);
  gate.resolve(); await start;
  await assert.rejects(f.lifecycle.run('install'), /Only the seed/);
  await f.lifecycle.stop();
  assert.equal(f.events.filter((event) => event === 'create-runtime').length, 1);
  assert.equal(f.events.includes('install'), false);
});

test('shutdown during start retains late runtime and prevents installation', async () => {
  const gate = deferred(); const f = fixture();
  f.runtime.start = () => gate.promise;
  const started = f.lifecycle.run('start');
  const rejection = assert.rejects(started, /stopping/);
  let closed = false;
  const stop = f.lifecycle.stop().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.lifecycle.run('install'), /stopping/);
  gate.resolve(); await rejection; await stop;
  assert.deepEqual(f.events, ['create-runtime', 'runtime-close']);
});

test('shutdown during deployment acquisition closes late result without opening service', async () => {
  const gate = deferred();
  const f = fixture({createDeployment: () => gate.promise});
  await f.lifecycle.run('start');
  const install = f.lifecycle.run('install');
  const rejection = assert.rejects(install, /stopping/);
  const stop = f.lifecycle.stop();
  gate.resolve(f.deployment); await rejection; await stop;
  assert.deepEqual(f.events.slice(-2), ['deployment-close', 'runtime-close']);
  assert.equal(f.events.includes('create-service'), false);
});

test('rejected installation is never retried; retained raw runtime is still stopped', async () => {
  const failure = new Error('first schema refusal'); let attempts = 0;
  const f = fixture({async createDeployment() { attempts++; throw failure; }});
  await f.lifecycle.run('start');
  await assert.rejects(f.lifecycle.run('install'), (error) => error === failure);
  await assert.rejects(f.lifecycle.run('install'), /expected started/);
  await f.lifecycle.stop();
  assert.equal(attempts, 1);
  assert.equal(f.events.at(-1), 'runtime-close');
});

test('cleanup preserves failures and continues remaining closures', async () => {
  const a = new Error('service close'); const b = new Error('Images close');
  const f = fixture(); await f.lifecycle.run('start'); await f.lifecycle.run('install');
  f.service.close = async () => { f.events.push('service-failed'); throw a; };
  f.deployment.close = async () => { f.events.push('deployment-failed'); throw b; };
  await assert.rejects(f.lifecycle.stop(), (error) => {
    assert.deepEqual(error.errors, [a, b]); return true;
  });
  assert.deepEqual(f.events.slice(-3), ['service-failed', 'deployment-failed', 'runtime-close']);
});

test('shutdown during service acquisition closes late service before Images and runtime', async () => {
  const gate = deferred(); const acquired = deferred();
  const f = fixture({async createService() { acquired.resolve(); return gate.promise; }});
  await f.lifecycle.run('start');
  const install = f.lifecycle.run('install');
  const rejection = assert.rejects(install, /stopping/);
  await acquired.promise;
  const stop = f.lifecycle.stop(); gate.resolve(f.service);
  await rejection; await stop;
  assert.deepEqual(f.events.slice(-3), ['service-close', 'deployment-close', 'runtime-close']);
  assert.equal(f.events.some((event) => Array.isArray(event) && event[0] === 'listen'), false);
});

test('membership failures propagate once without a write or retry', async () => {
  const failure = new Error('membership refused'); const f = fixture(); let reads = 0;
  f.runtime.openApplicationDatabase = () => ({async query(sql) {
    assert.equal(sql, 'SELECT node_id, status FROM nodes'); reads++; throw failure;
  }});
  await f.lifecycle.run('start');
  await assert.rejects(f.lifecycle.run('members'), (error) => error === failure);
  await f.lifecycle.stop(); assert.equal(reads, 1);
});

for (const synchronous of [false, true]) {
  test(`suppressed ${synchronous ? 'synchronous' : 'asynchronous'} provider cleanup failure survives later successful stop`, async () => {
    const semantic = new Error('schema refused'); const cleanup = new Error('hidden cleanup');
    const failedStop = Promise.reject(cleanup); failedStop.catch(() => {});
    let calls = 0;
    const f = fixture({async createDeployment(port) {
      try {
        if (synchronous) assert.throws(() => port.stop('argument'), (error) => error === cleanup);
        else {
          const result = port.stop('argument'); assert.equal(result, failedStop);
          await result;
        }
      } catch (error) { assert.equal(error, cleanup); }
      throw semantic;
    }});
    f.runtime.stop = function (...args) {
      assert.equal(this, f.runtime); calls++;
      if (calls > 1) { assert.deepEqual(args, []); return Promise.resolve(); }
      assert.deepEqual(args, ['argument']);
      if (synchronous) throw cleanup;
      return failedStop;
    };
    await f.lifecycle.run('start');
    await assert.rejects(f.lifecycle.run('install'), (error) => error === semantic);
    await assert.rejects(f.lifecycle.stop(), (error) => {
      assert.deepEqual(error.errors, [cleanup]); return true;
    });
    assert.equal(calls, 2);
  });
}

test('sideband deployment cleanup failure survives preserved semantic error', async () => {
  const semantic = new Error('graph refused'); const cleanup = new Error('Images close failed');
  const f = fixture({async createDeployment(_port, record) { record(cleanup); throw semantic; }});
  await f.lifecycle.run('start');
  await assert.rejects(f.lifecycle.run('install'), (error) => error === semantic);
  await assert.rejects(f.lifecycle.stop(), (error) => {
    assert.deepEqual(error.errors, [cleanup]); return true;
  });
});

test('late listen resolution during shutdown cannot become a ready address', async () => {
  const gate = deferred(); const listening = deferred(); const f = fixture();
  f.service.listen = () => { listening.resolve(); return gate.promise; };
  await f.lifecycle.run('start'); const install = f.lifecycle.run('install');
  const rejected = assert.rejects(install, /stopping/); await listening.promise;
  const stopped = f.lifecycle.stop(); gate.resolve({host: '127.0.0.1', port: 1234, secure: false});
  await rejected; await stopped;
  assert.deepEqual(f.events.slice(-3), ['service-close', 'deployment-close', 'runtime-close']);
});
