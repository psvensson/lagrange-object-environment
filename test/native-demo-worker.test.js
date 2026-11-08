import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const fixture = new URL('./fixtures/native-demo/worker.mjs', import.meta.url);
async function ownedWorker(t, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-worker-'));
  const log = join(root, 'events');
  const child = fork(fixture, [mode, log], {cwd: root, execArgv: [],
    env: {PATH: process.env.PATH, LC_ALL: 'C'}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const messages = []; let stderr = '', stdout = '', closed = false;
  child.on('message', (message) => messages.push(message));
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
  child.on('error', () => {});
  // Node 22 can omit ChildProcess.close after a parent-initiated IPC
  // disconnect. Observe all public custody facts, never exit alone.
  const close = new Promise((resolve) => {
    let status, outputClosed = false, errorClosed = false, ipcClosed = false;
    const settle = () => {
      if (status && outputClosed && errorClosed && ipcClosed) {
        closed = true; resolve(status);
      }
    };
    child.once('exit', (code, signal) => { status = {code, signal}; settle(); });
    child.stdout.once('close', () => { outputClosed = true; settle(); });
    child.stderr.once('close', () => { errorClosed = true; settle(); });
    child.once('disconnect', () => { ipcClosed = true; settle(); });
  });
  t.after(async () => { if (!closed) child.kill('SIGKILL'); await close;
    await rm(root, {recursive: true, force: true}); });
  async function events() { try { return (await readFile(log, 'utf8')).trim().split('\n'); } catch { return []; } }
  async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = await predicate(); if (found) return found;
      if (closed) throw new Error('Early child close: ' + stderr);
      await sleep(5);
    }
    throw new Error('Worker fixture deadline: ' + stderr);
  }
  return {child, close, events, until, messages,
    get stderr() { return stderr; }, get stdout() { return stdout; },
    async ready() { await until(() => messages.some((m) => m.event === 'worker-ready')); },
    async request(id, command) {
      child.send({id, command});
      return until(() => messages.find((m) => m.id === id));
    },
  };
}

for (const mode of ['slow-init', 'slow-start', 'slow-listen']) {
  test(`parent disconnect during ${mode} retains acquisitions and never disconnects twice`, {timeout: 5000}, async (t) => {
    const worker = await ownedWorker(t, mode);
    if (mode === 'slow-init') await worker.until(async () => (await worker.events()).includes('initialize'));
    else {
      await worker.ready();
      if (mode === 'slow-start') worker.child.send({id: 1, command: 'start'});
      else { await worker.request(1, 'start'); worker.child.send({id: 2, command: 'install'}); }
      await worker.until(async () => (await worker.events()).includes(mode === 'slow-start' ? 'start-enter' : 'listen-enter'));
    }
    worker.child.disconnect();
    const status = await worker.close;
    assert.equal(status.signal, null);
    assert.equal(worker.stderr.includes('ERR_IPC_DISCONNECTED'), false);
    assert.equal(worker.stderr.includes('unhandled'), false);
    const events = await worker.events();
    if (mode === 'slow-init') assert.deepEqual(events, ['initialize', 'initialized']);
    else assert.equal(events.at(-1), 'runtime-close');
    if (mode === 'slow-listen') {
      assert.deepEqual(events.slice(-3), ['service-close', 'deployment-close', 'runtime-close']);
      assert.equal(worker.messages.some((m) => m.id === 2 && m.ok), false);
    }
  });
}

test('SIGTERM during pending startup closes the late runtime', {timeout: 5000}, async (t) => {
  const worker = await ownedWorker(t, 'slow-start'); await worker.ready();
  worker.child.send({id: 1, command: 'start'});
  await worker.until(async () => (await worker.events()).includes('start-enter'));
  worker.child.kill('SIGTERM'); await worker.close;
  assert.equal((await worker.events()).at(-1), 'runtime-close');
  assert.equal(worker.messages.some((m) => m.id === 1 && m.ok), false);
});

for (const command of ['unknown', 'duplicate']) {
  test(`invalid ${command} command fails and closes the worker`, {timeout: 5000}, async (t) => {
    const worker = await ownedWorker(t); await worker.ready(); await worker.request(1, 'start');
    worker.child.send(command === 'duplicate' ? {id: 1, command: 'members'} : {id: 2, command});
    assert.equal((await worker.close).code, 1);
    assert.match(worker.stderr, /Invalid demo command/);
    assert.equal((await worker.events()).at(-1), 'runtime-close');
  });
}

for (const mode of ['send-throw', 'send-callback']) {
  test(`${mode} is fatal and closes all acquired resources`, {timeout: 5000}, async (t) => {
    const worker = await ownedWorker(t, mode); await worker.ready(); await worker.request(1, 'start');
    worker.child.send({id: 2, command: 'install'});
    assert.equal((await worker.close).code, 1);
    assert.match(worker.stderr, /send-failure/);
    assert.deepEqual((await worker.events()).slice(-3), ['service-close', 'deployment-close', 'runtime-close']);
  });
}

test('bounded worker diagnostics retain separate cleanup errors and tolerate cause cycles', {timeout: 5000}, async (t) => {
  const worker = await ownedWorker(t, 'cleanup-errors'); await worker.ready();
  await worker.request(1, 'start'); await worker.request(2, 'install');
  worker.child.kill('SIGTERM'); assert.equal((await worker.close).code, 1);
  const line = worker.stderr.trim(); assert.ok(Buffer.byteLength(line) < 16384);
  const report = JSON.parse(line); assert.ok(report.errors.length <= 8);
  for (const text of ['service-cleanup', 'image-cleanup', 'raw-cleanup']) assert.match(line, new RegExp(text));
  assert.equal(worker.stdout, '');
});


test('worst-case escaped diagnostic fields remain below the process boundary byte limit', {timeout: 5000}, async (t) => {
  const worker = await ownedWorker(t, 'diagnostic-bounds'); await worker.ready();
  await worker.request(1, 'start'); await worker.request(2, 'install');
  worker.child.kill('SIGTERM'); assert.equal((await worker.close).code, 1);
  assert.ok(Buffer.byteLength(worker.stderr) < 16384);
  const report = JSON.parse(worker.stderr); assert.equal(report.errors.length, 8);
  for (const error of report.errors) {
    for (const value of Object.values(error)) assert.ok(value.length <= 96);
  }
});
