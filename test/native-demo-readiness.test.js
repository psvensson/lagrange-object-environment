import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {probeDemoReadiness} from '../examples/native-cluster/demo-readiness.js';
import {runDemoCohort} from '../examples/native-cluster/demo-cohort.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function serve(t, handler) {
  const server = createServer((request, response) => {
    response.on('error', () => {}); // A deliberately refused body may be cancelled by the client.
    handler(request, response);
  });
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return {configuration: {node: {restApiPort: server.address().port}}};
}

test('public readiness consumes only the canonical 200/true and 503/false verdicts', async t => {
  let requests = 0;
  const node = await serve(t, (request, response) => {
    assert.equal(request.url, '/readyz');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.accept, 'application/json');
    requests++;
    response.writeHead(requests === 1 ? 503 : 200, {'content-type': 'application/json'});
    response.end(JSON.stringify(requests === 1
      ? {ready: false, state: 'READY', phase: 'FORMED'}
      : {ready: true, arbitraryDiagnostic: {ready: false}}));
  });
  assert.equal(await probeDemoReadiness(node, {deadline: performance.now() + 5000}), false);
  assert.equal(await probeDemoReadiness(node, {deadline: performance.now() + 5000}), true);
});

for (const [name, status, body] of [
  ['200 with false', 200, '{"ready":false}'],
  ['503 with true', 503, '{"ready":true}'],
  ['missing verdict', 200, '{"state":"READY"}'],
  ['string verdict', 200, '{"ready":"true"}'],
  ['array body', 200, '[{"ready":true}]'],
  ['malformed JSON', 200, '{"ready":'],
  ['invalid UTF-8', 200, Buffer.from([123, 34, 114, 101, 97, 100, 121, 34, 58, 255, 125])],
  ['unexpected status', 404, '{"ready":false}'],
]) {
  test(`public readiness rejects ${name}`, async t => {
    const node = await serve(t, (_request, response) => {
      response.writeHead(status, {'content-type': 'application/json'});
      response.end(body);
    });
    await assert.rejects(probeDemoReadiness(node, {deadline: performance.now() + 5000}));
  });
}

for (const declared of [true, false]) {
  test(`public readiness rejects an oversized ${declared ? 'declared' : 'streamed'} body`, async t => {
    const body = JSON.stringify({ready: true, padding: 'x'.repeat(65_537)});
    const node = await serve(t, (_request, response) => {
      response.writeHead(200, {'content-type': 'application/json',
        ...(declared ? {'content-length': String(Buffer.byteLength(body))} : {})});
      response.write(body);
      response.end();
    });
    await assert.rejects(probeDemoReadiness(node, {deadline: performance.now() + 5000}), /oversized/i);
  });
}

test('public readiness refuses redirects instead of probing another endpoint', async t => {
  const paths = [];
  const node = await serve(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(302, {location: '/different-owner'});
    response.end('{"ready":true}');
  });
  await assert.rejects(probeDemoReadiness(node, {deadline: performance.now() + 5000}));
  assert.deepEqual(paths, ['/readyz']);
});

for (const cancellation of ['outer cancellation', 'shared deadline']) {
  test(`public readiness drains a held body on ${cancellation}`, {timeout: 5000}, async t => {
    const entered = deferred(), closed = deferred();
    const node = await serve(t, (request, response) => {
      request.socket.once('close', closed.resolve);
      response.writeHead(200, {'content-type': 'application/json'});
      response.write('{"ready":');
      entered.resolve();
    });
    const controller = new AbortController();
    const reason = new Error('caller stopped readiness');
    const pending = probeDemoReadiness(node, {deadline: performance.now() +
      (cancellation === 'shared deadline' ? 1000 : 4000), signal: controller.signal});
    // Attach rejection observation before the deadline or deliberate abort.
    const outcome = pending.then(value => ({value}), error => ({error}));
    try {
      await entered.promise;
      if (cancellation === 'outer cancellation') controller.abort(reason);
      const result = await outcome;
      assert.ok(result.error);
      if (cancellation === 'outer cancellation') assert.equal(result.error, reason);
      else assert.match(result.error.message, /deadline/);
      await closed.promise;
    } finally { controller.abort(reason); await outcome; }
  });
}

test('an expired or already-aborted readiness request acquires no connection', async t => {
  let requests = 0;
  const node = await serve(t, (_request, response) => { requests++; response.end('{"ready":true}'); });
  await assert.rejects(probeDemoReadiness(node, {deadline: performance.now() - 1}), /deadline/);
  const controller = new AbortController();
  const reason = new Error('already cancelled'); controller.abort(reason);
  await assert.rejects(probeDemoReadiness(node, {deadline: performance.now() + 5000,
    signal: controller.signal}), error => error === reason);
  assert.equal(requests, 0);
});

// These controlled owners prove the cohort's interaction policy. Actual node
// startup, Images installation and mapped GTK are the separate live CI gate.
function cohortFixture({probeReadiness, membership, installError, startupMs = 2000} = {}) {
  const nodes = ['seed', 'joiner-a', 'joiner-b'].map((id, index) => ({index,
    configuration: {node: {id, restApiPort: 18000 + index}}}));
  const calls = [], deadlines = [], failures = [], stopped = [];
  const controller = new AbortController();
  let installed = 0, nativeStarts = 0, memberReads = 0;
  const options = {nodes, signal: controller.signal, probeReadiness, pollMs: 1, startupMs,
    startWorker(node, fail) {
      failures.push(fail);
      return {
        assertAlive() {},
        async ready(deadline) { deadlines.push(deadline); calls.push(`worker-ready:${node.index}`); },
        async request(command, deadline) {
          deadlines.push(deadline); calls.push(`${command}:${node.index}`);
          if (command === 'start') return {started: true};
          if (command === 'members') {
            memberReads++;
            return membership ? membership(memberReads, nodes)
              : nodes.map(node => ({nodeId: node.configuration.node.id, status: 'active'}));
          }
          if (command === 'install') {
            installed++;
            if (installError) throw installError;
            return {host: '127.0.0.1', port: 1234, secure: false};
          }
          throw new Error('Unexpected fixture command');
        },
        async stop() { stopped.push(node.index); return {code: 0, signal: null}; },
      };
    },
    startNative() {
      nativeStarts++;
      return {assertAlive() {}, async ready(deadline) { deadlines.push(deadline); },
        closed: Promise.resolve({code: 0, signal: null}),
        async stop() { stopped.push('native'); return {code: 0, signal: null}; }};
    },
  };
  return {options, nodes, calls, deadlines, failures, stopped, controller,
    installed: () => installed, nativeStarts: () => nativeStarts, memberReads: () => memberReads};
}

function captureStartupObservation(fixture) {
  let observation;
  fixture.options.onStage = (stage, details) => {
    if (stage !== 'Stopping the demo processes') return;
    assert.equal(observation, undefined, 'startup evidence is emitted only once');
    observation = details.startupObservation;
  };
  return () => observation;
}

test('startup evidence distinguishes incomplete membership from an unattempted readiness probe', async () => {
  const entered = deferred(), held = deferred();
  let probes = 0;
  const rows = [{nodeId: 'seed', status: 'active'}, {nodeId: 'joiner-a', status: 'joining'}];
  const f = cohortFixture({membership(round) {
    if (round === 3) { entered.resolve(); return held.promise; }
    return rows;
  }, probeReadiness: async () => { probes++; return false; }});
  const evidence = captureStartupObservation(f);
  const reason = new Error('stop while the third membership request is held');
  const running = runDemoCohort(f.options), observed = running.catch(error => error);
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw new Error('Cohort closed before the held membership request');
    })]);
    // The retained result must not alias data still owned by a worker/delegate.
    rows[1].status = 'active'; rows.push({nodeId: 'joiner-b', status: 'active'});
    f.controller.abort(reason);
    assert.equal(await observed, reason);
  } finally { held.resolve([]); f.controller.abort(reason); await observed; }
  await assert.rejects(running, error => error === reason);
  const record = evidence();
  assert.equal(record.membershipAttempts, 3);
  assert.equal(record.lastMembership.round, 2);
  assert.equal(record.lastMembership.complete, false);
  assert.deepEqual(record.lastMembership.rows,
    [{nodeId: 'seed', status: 'active'}, {nodeId: 'joiner-a', status: 'joining'}]);
  assert.equal(record.readinessAttempts, 0);
  assert.equal(record.lastReadiness, null);
  assert.equal(probes, 0);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.lastMembership)
    && Object.isFrozen(record.lastMembership.rows) && Object.isFrozen(record.lastMembership.rows[0]));
  assert.throws(() => { record.lastMembership.rows[0].status = 'changed'; }, TypeError);
  assert.deepEqual(f.stopped, [0, 1, 2]);
  assert.equal(f.installed(), 0);
});

test('startup evidence records a held first probe separately from a validated pending response', async () => {
  const entered = deferred(), held = deferred();
  const f = cohortFixture({probeReadiness(_node, {signal}) {
    signal.addEventListener('abort', () => held.reject(signal.reason), {once: true});
    entered.resolve(); return held.promise;
  }});
  const evidence = captureStartupObservation(f);
  const reason = new Error('stop while the first readiness probe is held');
  const running = runDemoCohort(f.options), observed = running.catch(error => error);
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw new Error('Cohort closed before the held readiness probe');
    })]);
    f.controller.abort(reason);
    assert.equal(await observed, reason);
  } finally { held.reject(reason); f.controller.abort(reason); await observed; }
  const record = evidence();
  assert.equal(record.membershipAttempts, 1);
  assert.equal(record.lastMembership.round, 1);
  assert.equal(record.lastMembership.complete, true);
  assert.equal(record.readinessAttempts, 1);
  assert.equal(record.lastReadiness, null);
  assert.equal(f.installed(), 0);
  assert.deepEqual(f.stopped, [0, 1, 2]);
});

test('startup evidence keeps an older pending verdict tied to its own membership round', async () => {
  const entered = deferred(), held = deferred();
  const f = cohortFixture({membership(round, nodes) {
    if (round === 3) { entered.resolve(); return held.promise; }
    return nodes.map((node, index) => ({nodeId: node.configuration.node.id,
      status: round === 2 && index === 2 ? 'joining' : 'active'}));
  }, probeReadiness: async () => false});
  const evidence = captureStartupObservation(f);
  const reason = new Error('stop after membership changed');
  const running = runDemoCohort(f.options), observed = running.catch(error => error);
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw new Error('Cohort closed before the later membership request');
    })]);
    f.controller.abort(reason);
    assert.equal(await observed, reason);
  } finally { held.resolve([]); f.controller.abort(reason); await observed; }
  const record = evidence();
  assert.equal(record.membershipAttempts, 3);
  assert.equal(record.lastMembership.round, 2);
  assert.equal(record.lastMembership.complete, false);
  assert.equal(record.readinessAttempts, 1);
  assert.equal(record.lastReadiness.round, 1);
  assert.equal(record.lastReadiness.ready, false);
  assert.ok(record.lastReadiness.elapsedMs <= record.lastMembership.elapsedMs);
  assert.ok(Object.isFrozen(record.lastReadiness));
  assert.equal(f.installed(), 0);
  assert.deepEqual(f.stopped, [0, 1, 2]);
});

test('three active IDs cannot install before seed readiness, and every stage shares the original deadline', async () => {
  const entered = deferred(), release = deferred();
  const probes = [];
  let f;
  f = cohortFixture({
    membership(round, nodes) {
      return nodes.map((node, index) => ({nodeId: node.configuration.node.id,
        status: round === 2 && index === 2 ? 'joining' : 'active'}));
    },
    async probeReadiness(node, {deadline}) {
      probes.push({node, deadline});
      if (probes.length === 1) { entered.resolve(); await release.promise; return false; }
      return true;
    },
  });
  const running = runDemoCohort(f.options);
  const observed = running.then(() => null, error => error);
  try {
    await entered.promise;
    assert.equal(f.installed(), 0);
    assert.equal(f.nativeStarts(), 0);
  } finally { release.resolve(); await observed; }
  await running;
  assert.equal(probes.length, 2);
  assert.ok(probes.every(probe => probe.node === f.nodes[0]), 'unused joiners are not serving prerequisites');
  assert.equal(f.memberReads(), 3, 'membership is observed again after a pending public verdict');
  assert.equal(new Set([...f.deadlines, ...probes.map(probe => probe.deadline)]).size, 1);
  assert.equal(f.installed(), 1);
  assert.equal(f.nativeStarts(), 1);
  assert.deepEqual(f.stopped, [0, 1, 2, 'native']);
});

test('pending serving readiness consumes the original startup budget and never installs', async () => {
  const deadlines = [];
  const f = cohortFixture({startupMs: 500, async probeReadiness(_node, {deadline}) {
    deadlines.push(deadline); return false;
  }});
  const safety = setTimeout(() => f.controller.abort(new Error('proof safety ceiling')), 2000);
  try { await assert.rejects(runDemoCohort(f.options), /startup deadline/); }
  finally { clearTimeout(safety); f.controller.abort(); }
  assert.ok(deadlines.length > 0);
  assert.equal(new Set([...f.deadlines, ...deadlines]).size, 1);
  assert.equal(f.installed(), 0);
  assert.equal(f.nativeStarts(), 0);
  assert.deepEqual(f.stopped, [0, 1, 2]);
});

test('a first-write FORMATION_PENDING stays the first failure and is never retried', async () => {
  const failure = Object.assign(new Error('real formation gate refused the write'), {code: 'FORMATION_PENDING'});
  const f = cohortFixture({probeReadiness: async () => true, installError: failure});
  await assert.rejects(runDemoCohort(f.options), error => error === failure);
  assert.equal(f.installed(), 1);
  assert.equal(f.nativeStarts(), 0);
  assert.deepEqual(f.stopped, [0, 1, 2]);
});

test('worker failure cancels and retires a held readiness body before cohort completion', async () => {
  const entered = deferred(), held = deferred();
  let retired = false, settled = false, beforeCleanup;
  const f = cohortFixture({probeReadiness(_node, {signal}) {
    entered.resolve();
    signal.addEventListener('abort', () => held.reject(signal.reason), {once: true});
    return held.promise.finally(() => { retired = true; });
  }});
  const running = runDemoCohort(f.options);
  const observed = running.then(() => { settled = true; return null; }, error => { settled = true; return error; });
  const failure = new Error('joiner failed while the seed probe was held');
  try {
    await entered.promise;
    f.failures[1](failure);
    await new Promise(resolve => setImmediate(resolve));
    beforeCleanup = {retired, settled};
  } finally {
    // Also release a competing implementation that forgot to abort the probe,
    // so the test can report its observation instead of hanging in cleanup.
    held.reject(failure); f.controller.abort(failure); await observed;
  }
  await assert.rejects(running, error => error === failure);
  assert.deepEqual(beforeCleanup, {retired: true, settled: true});
  assert.equal(retired, true);
  assert.equal(f.installed(), 0);
  assert.equal(f.nativeStarts(), 0);
  assert.deepEqual(f.stopped, [0, 1, 2]);
});

test('a throwing shutdown-stage observer cannot prevent any owned process from stopping', async () => {
  const f = cohortFixture({probeReadiness: async () => true});
  const reporting = new Error('shutdown observer failed');
  let observation;
  f.options.onStage = (stage, details) => {
    if (stage !== 'Stopping the demo processes') return;
    observation = details.startupObservation;
    throw reporting;
  };
  await assert.rejects(runDemoCohort(f.options), error => error === reporting);
  assert.equal(observation.membershipAttempts, 1);
  assert.equal(observation.lastMembership.complete, true);
  assert.equal(observation.readinessAttempts, 1);
  assert.equal(observation.lastReadiness.ready, true);
  assert.equal(observation.lastMembership.round, observation.lastReadiness.round);
  assert.deepEqual(f.stopped, [0, 1, 2, 'native']);
});

test('a synchronous stop failure still initiates shutdown of every later delegate', async () => {
  const f = cohortFixture({probeReadiness: async () => true});
  const start = f.options.startWorker;
  const failure = new Error('first delegate stop threw synchronously');
  const attempts = [];
  f.options.startWorker = (node, fail) => {
    const owner = start(node, fail), stop = owner.stop;
    owner.stop = () => {
      attempts.push(node.index);
      if (node.index === 0) throw failure;
      return stop();
    };
    return owner;
  };
  await assert.rejects(runDemoCohort(f.options), error =>
    /cleanup was incomplete/.test(error.message) && error.cause === failure);
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(f.stopped, [1, 2, 'native']);
});

test('a throwing cleanup reporter retains the semantic cause and actual cleanup failure', async () => {
  const primary = new Error('image install refused');
  const cleanup = new Error('worker could not close');
  const reporting = new Error('cleanup observer failed');
  const f = cohortFixture({probeReadiness: async () => true, installError: primary});
  const start = f.options.startWorker;
  f.options.startWorker = (node, fail) => {
    const owner = start(node, fail), stop = owner.stop;
    owner.stop = async () => { const result = await stop(); if (node.index === 0) throw cleanup; return result; };
    return owner;
  };
  f.options.onCleanupFailure = () => { throw reporting; };
  await assert.rejects(runDemoCohort(f.options), error => error instanceof AggregateError
    && error.cause === primary && error.errors[0] === primary
    && error.errors.some(item => item.cause === cleanup) && error.errors.includes(reporting));
  assert.deepEqual(f.stopped, [0, 1, 2]);
  assert.equal(f.nativeStarts(), 0);
});
