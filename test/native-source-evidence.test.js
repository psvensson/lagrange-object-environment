import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDemoSnapshotWriter} from '../examples/native-cluster/demo-snapshot-evidence.js';
import {SOURCE_DEVELOPMENT} from '../examples/native-cluster/runtime-selection.js';
import {exportSourceEvidence, finalizeSourceEvidence, sourceFailureRecords} from './native-cluster/source-evidence.js';

const selection = {...SOURCE_DEVELOPMENT, specifier: 'file:///admitted/lagrange/src/public-api.js'};
const deployment = {backend: 'lagrange', durable: true, lagrangeVersion: selection.version,
  lagrangeRevision: selection.revision, expectedImagesRevision: selection.imagesRevision, runtimeSelection: selection};
const topology = {processCount: 3, hostCount: 1, hostId: 'actual-host', configuredReplicationFactor: 3};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oe-source-export-'));
  const runDirectory = join(root, 'private-run'), directory = join(root, 'export');
  await mkdir(join(runDirectory, 'evidence'), {recursive: true, mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, directory, runDirectory, selection, provenance: {topology}, phases: [], durationMs: 100};
}

function diagnostic(message = 'schema admission refused', code = 'FORMATION_PENDING') {
  return JSON.stringify({event: 'demo-worker-failure', phase: 'operation',
    errors: [{name: 'Error', code, message}]}) + '\n';
}

test('export allowlist retains structured causes and validated complete snapshots without private files', async (t) => {
  const f = await fixture(t), secret = 'a'.repeat(64);
  for (const name of ['credential', 'node-0.json', 'config.json', 'native-client.log', 'node-0.log']) {
    await writeFile(join(f.runDirectory, name), secret, {mode: 0o600});
  }
  await writeFile(join(f.runDirectory, 'node-0.log.diagnostics'), diagnostic('Bearer ' + secret), {mode: 0o600});
  const writer = createDemoSnapshotWriter(join(f.runDirectory, 'evidence'));
  const graph = {root: {id: 'generated-root'}, history: Array.from({length: 500}, (_, i) => ({i, value: 'known-history'}))};
  const before = await writer.write(graph, deployment), after = await writer.write(graph, deployment);
  f.phases = [{stage: 'baseline-verified', elapsedMs: 10, receipt: before},
    {stage: 'after-read', elapsedMs: 80, receipt: after}, {stage: 'after-verified', elapsedMs: 90, receipt: after}];
  const exported = await exportSourceEvidence(f);
  assert.equal(exported.outcome, 'pending');
  const manifest = finalizeSourceEvidence({directory: f.directory, manifest: exported, signal: new AbortController().signal});
  assert.equal(manifest.outcome, 'accepted'); assert.deepEqual(manifest.runtimeSelection, selection);
  assert.deepEqual(manifest.topology, topology);
  assert.deepEqual((await readdir(f.directory)).sort(), ['diagnostics.json', 'manifest.json', 'receipts.json',
    'snapshot-1.json', 'snapshot-2.json']);
  for (const name of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, name), 'utf8')).includes(secret), false);
  const records = JSON.parse(await readFile(join(f.directory, 'diagnostics.json'), 'utf8'));
  assert.equal(records[0].owner, 'node-0'); assert.equal(records[0].errors[0].code, 'FORMATION_PENDING');
  assert.equal(records[0].errors[0].message, 'Bearer [redacted]');
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'snapshot-2.json'), 'utf8')), graph);
  assert.deepEqual(await readFile(join(f.directory, 'snapshot-1.json')),
    await readFile(join(f.runDirectory, 'evidence', 'snapshot-1.json')));
});

test('early runtime failure exports its admitted identity, failing stage and actual bounded diagnostic cause', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.runDirectory, 'node-0.log.diagnostics'), diagnostic(), {mode: 0o600});
  const failure = new Error('node-0: install failed; see private run log');
  f.phases = [{stage: 'Installing the demonstration image', elapsedMs: 40}];
  const result = await exportSourceEvidence({...f, failure, failureStage: 'Installing the demonstration image'});
  assert.equal(result.outcome, 'failed'); assert.equal(result.failureStage, 'Installing the demonstration image');
  assert.equal(result.failures[0].message, failure.message);
  assert.equal(result.snapshots.length, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), ['diagnostics.json', 'manifest.json', 'receipts.json']);
  const evidence = JSON.parse(await readFile(join(f.directory, 'diagnostics.json'), 'utf8'));
  assert.equal(evidence[0].errors[0].code, 'FORMATION_PENDING');
});

for (const invalid of ['truncated', 'wrong-hash', 'symlink', 'receipt-sequence']) {
  test(`export rejects ${invalid} snapshot evidence and writes a failed manifest without copying it`, async (t) => {
    const f = await fixture(t), writer = createDemoSnapshotWriter(join(f.runDirectory, 'evidence'));
    const receipt = await writer.write({history: ['original']}, deployment);
    const path = join(f.runDirectory, 'evidence', 'snapshot-1.json');
    if (invalid === 'truncated') await writeFile(path, '{}');
    if (invalid === 'wrong-hash') receipt.sha256 = '0'.repeat(64);
    if (invalid === 'receipt-sequence') receipt.sequence = 2;
    if (invalid === 'symlink') { await rm(path); await symlink(join(f.runDirectory, 'credential'), path);
      await writeFile(join(f.runDirectory, 'credential'), 'private', {mode: 0o600}); }
    f.phases = [{stage: 'baseline-verified', elapsedMs: 20, receipt}];
    await assert.rejects(exportSourceEvidence(f), /export failed/);
    const manifest = JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.outcome, 'failed'); assert.ok(manifest.exportFailures.length);
    assert.equal((await readdir(f.directory)).some((name) => name.startsWith('snapshot-')), false);
  });
}

for (const invalid of ['oversized', 'malformed', 'symlink']) {
  test(`export does not publish ${invalid} diagnostic input as raw logs`, async (t) => {
    const f = await fixture(t), path = join(f.runDirectory, 'node-0.log.diagnostics');
    if (invalid === 'oversized') await writeFile(path, 'x'.repeat(65537), {mode: 0o600});
    if (invalid === 'malformed') await writeFile(path, 'private unstructured log', {mode: 0o600});
    if (invalid === 'symlink') {
      const secret = join(f.runDirectory, 'credential'); await writeFile(secret, 'private', {mode: 0o600});
      await symlink(secret, path);
    }
    await assert.rejects(exportSourceEvidence(f), /export failed/);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'diagnostics.json'), 'utf8')), []);
    const manifest = JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.outcome, 'failed'); assert.ok(manifest.exportFailures.length);
  });
}

test('export never merges a new result with stale artifact files', async (t) => {
  const f = await fixture(t); await mkdir(f.directory, {mode: 0o700});
  await writeFile(join(f.directory, 'stale.json'), 'preserve', {mode: 0o600});
  await assert.rejects(exportSourceEvidence(f), /fresh private directory/);
  assert.deepEqual(await readdir(f.directory), ['stale.json']);
});

test('cancellation across asynchronous export cannot publish an accepted final manifest', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const pending = exportSourceEvidence(f);
  const failure = new Error('cancelled while evidence export was pending');
  controller.abort(failure);
  const manifest = await pending;
  assert.equal(manifest.outcome, 'pending');
  assert.throws(() => finalizeSourceEvidence({directory: f.directory, manifest, signal: controller.signal}),
    (error) => error === failure);
  const final = JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'));
  assert.equal(final.outcome, 'failed'); assert.equal(final.failures[0].message, failure.message);
});

test('error-chain diagnostics are bounded, redact credential forms and survive cause cycles', () => {
  const secret = 'a'.repeat(64), first = new Error('password=hunter2 ' + secret);
  first.cause = first;
  const errors = sourceFailureRecords(new AggregateError(Array(30).fill(first), 'first semantic cause'));
  assert.equal(errors.length, 2);
  const text = JSON.stringify(errors);
  assert.equal(text.includes(secret), false); assert.equal(text.includes('hunter2'), false);
  for (const record of errors) for (const value of Object.values(record)) assert.ok(value.length <= 96);
});
