import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {verifyDemoGuardian} from '../examples/native-cluster/demo-guardian.js';
import {startDemoProcess} from '../examples/native-cluster/demo-process.js';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-guardian-'));
  t.after(() => rm(root, {recursive: true, force: true})); return root;
}
async function heartbeat(path) {
  for (let i = 0; i < 300; i++) {
    const value = await readFile(path, 'utf8').catch(() => '');
    if (value) return value;
    await sleep(5);
  }
  throw new Error('No fixture heartbeat');
}

test('Linux guardian capability check ignores Python startup injection', async (t) => {
  const root = await directory(t); const marker = join(root, 'injected');
  await writeFile(join(root, 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').write('injected')`);
  const previous = process.env.PYTHONPATH; process.env.PYTHONPATH = root;
  try { await verifyDemoGuardian(); }
  finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
  const failures = [];
  const owner = startDemoProcess({file: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/native-demo/native.mjs', import.meta.url)), 'close'],
    options: {env: {...process.env, PYTHONPATH: root}}, logFile: join(root, 'isolation.log'),
    label: 'isolation', onFailure: (error) => failures.push(error), graceMs: 150});
  t.after(() => owner.stop());
  assert.equal((await owner.closed).code, 0); assert.deepEqual(failures, []);
  await assert.rejects(readFile(marker), {code: 'ENOENT'});
});

test('parent death independently drains a native payload and pipe-free resistant descendant', {timeout: 5000}, async (t) => {
  const root = await directory(t);
  const parent = fork(new URL('./fixtures/native-demo/parent.mjs', import.meta.url), [root],
    {execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  t.after(async () => { parent.kill('SIGKILL'); await sleep(2100); });
  const ready = new Promise((resolve) => parent.once('message', resolve));
  const exited = new Promise((resolve) => parent.once('exit', resolve));
  await ready; await heartbeat(join(root, 'heartbeat'));
  parent.kill('SIGKILL'); await exited; await sleep(300);
  const before = await readFile(join(root, 'heartbeat'), 'utf8'); await sleep(60);
  assert.equal(await readFile(join(root, 'heartbeat'), 'utf8'), before);
});

test('unexpected guardian death reports custody loss without signaling a reused group id', {timeout: 5000}, async (t) => {
  const root = await directory(t); const failures = [];
  const owner = startDemoProcess({file: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/native-demo/native.mjs', import.meta.url)),
      'descendant-resistant-stay', join(root, 'heartbeat')], options: {},
    logFile: join(root, 'loss.log'), label: 'lost', graceMs: 80, onFailure: (error) => failures.push(error)});
  t.after(() => owner.stop());
  await owner.ready(performance.now() + 2000); await heartbeat(join(root, 'heartbeat'));
  const exited = new Promise((resolve) => owner.child.once('exit', resolve));
  owner.child.kill('SIGKILL'); await exited;
  const stopping = owner.stop();
  const before = await readFile(join(root, 'heartbeat'), 'utf8'); await sleep(100);
  assert.notEqual(await readFile(join(root, 'heartbeat'), 'utf8'), before,
    'lost custody must not trigger speculative group signals');
  const status = await stopping;
  assert.equal(status.killed, true); assert.equal(status.signal, 'SIGKILL'); assert.ok(failures.length);
});
