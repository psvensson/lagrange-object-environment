import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDemoDiagnostics} from '../examples/native-cluster/demo-diagnostics.js';

test('diagnostic reserve retains first failure per phase across chunk boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'demo-diagnostics-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'records'); const failures = [];
  const sink = openDemoDiagnostics(file, (error) => failures.push(error));
  for (const message of ['first', 'replacement']) for (const phase of ['initialization', 'operation', 'protocol', 'cleanup']) {
    const line = Buffer.from(JSON.stringify({event: 'demo-worker-failure', phase,
      errors: [{name: 'Error', code: 'E', message}]}) + '\n');
    for (let i = 0; i < line.length; i += 7) sink.write(line.subarray(i, i + 7));
  }
  sink.close(); sink.close();
  assert.deepEqual(failures, []);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => record.errors[0].message === 'first'));
});

for (const value of ['x'.repeat(16384), '{partial',
  JSON.stringify({event: 'demo-worker-failure', phase: 'foreign', errors: []}) + '\n',
  JSON.stringify({event: 'demo-worker-failure', phase: 'cleanup', errors: [{name: '', code: '', message: '', extra: true}]}) + '\n']) {
  test('malformed or unbounded diagnostic is a bounded process failure', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'demo-invalid-diagnostic-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const failures = []; const file = join(root, 'records');
    const sink = openDemoDiagnostics(file, (error) => failures.push(error));
    sink.write(Buffer.from(value)); sink.close();
    assert.equal(failures.length, 1); assert.equal((await readFile(file)).length, 0);
  });
}
