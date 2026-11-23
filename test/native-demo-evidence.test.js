import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, readdir, writeFile, rm, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createDemoSnapshotWriter, createDemoSnapshotReader, MAX_SNAPSHOT_BYTES,
  snapshotEvidencePath} from '../examples/native-cluster/demo-snapshot-evidence.js';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-evidence-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}
const provenance = {backend: 'lagrange', durable: true, runtimeSelection: {kind: 'source-development'}};
const snapshot = {descriptor: {members: ['root', 'denied']}, project: {id: 'project'}, root: {id: 'root'},
  target: {id: 'target'}, history: Array.from({length: 800}, (_, index) => ({index, value: 'complete history '.repeat(8)}))};

test('two exclusive private files transfer the complete graph/history while receipts stay under IPC bounds', async (t) => {
  const root = await directory(t);
  const writer = createDemoSnapshotWriter(root), reader = createDemoSnapshotReader(root);
  for (const sequence of [1, 2]) {
    const receipt = await writer.write(snapshot, provenance);
    assert.deepEqual(Object.keys(receipt), ['sequence', 'byteLength', 'sha256', 'provenance']);
    assert.equal(receipt.sequence, sequence); assert.ok(receipt.byteLength > 16384);
    assert.ok(Buffer.byteLength(JSON.stringify({id: sequence, ok: true, value: receipt})) < 16384);
    const result = await reader.read(receipt);
    assert.equal(result.path, snapshotEvidencePath(root, sequence));
    assert.deepEqual(result.snapshot, snapshot);
  }
  assert.deepEqual((await readdir(root)).sort(), ['snapshot-1.json', 'snapshot-2.json']);
  await assert.rejects(writer.write(snapshot, provenance), /exactly two/);
  await assert.rejects(reader.read({sequence: 3}), /exactly two/);
});

test('snapshot overflow fails before creating a file and is never truncated or retried', async (t) => {
  const root = await directory(t), writer = createDemoSnapshotWriter(root);
  await assert.rejects(writer.write({history: 'x'.repeat(MAX_SNAPSHOT_BYTES)}, provenance), /1 MiB/);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(writer.write({history: []}, provenance), /1 MiB/);
});

for (const corruption of ['size', 'hash', 'sequence', 'extra', 'large-provenance']) {
  test(`receipt ${corruption} is terminal instead of accepting an altered or replayed snapshot`, async (t) => {
    const root = await directory(t);
    const receipt = await createDemoSnapshotWriter(root).write(snapshot, provenance);
    const changed = structuredClone(receipt);
    if (corruption === 'size') changed.byteLength--;
    if (corruption === 'hash') changed.sha256 = '0'.repeat(64);
    if (corruption === 'sequence') changed.sequence = 2;
    if (corruption === 'extra') changed.path = '/outside/snapshot';
    if (corruption === 'large-provenance') changed.provenance.extra = '\0'.repeat(4000);
    const reader = createDemoSnapshotReader(root);
    await assert.rejects(reader.read(changed));
    await assert.rejects(reader.read(receipt));
  });
}

test('reader rejects duplicate sequence rather than substituting the baseline for a fresh reread', async (t) => {
  const root = await directory(t), writer = createDemoSnapshotWriter(root), reader = createDemoSnapshotReader(root);
  const before = await writer.write(snapshot, provenance);
  const after = await writer.write(snapshot, provenance);
  await reader.read(before);
  await assert.rejects(reader.read(before), /sequence/);
  await assert.rejects(reader.read(after), /sequence/);
});

for (const corruption of ['truncated', 'longer', 'changed-bytes', 'public', 'symlink', 'directory']) {
  test(`reader refuses ${corruption} evidence even with a plausible small receipt`, async (t) => {
    const root = await directory(t);
    const receipt = await createDemoSnapshotWriter(root).write(snapshot, provenance);
    const path = snapshotEvidencePath(root, 1), bytes = await readFile(path);
    if (corruption === 'truncated') await writeFile(path, bytes.subarray(0, bytes.length - 1));
    if (corruption === 'longer') await writeFile(path, Buffer.concat([bytes, Buffer.from('x')]));
    if (corruption === 'changed-bytes') { bytes[bytes.length - 2] ^= 1; await writeFile(path, bytes); }
    if (corruption === 'public') await chmod(path, 0o644);
    if (corruption === 'symlink' || corruption === 'directory') {
      await rm(path);
      const outside = join(root, 'outside');
      await writeFile(outside, bytes, {mode: 0o600});
      await symlink(corruption === 'directory' ? root : outside, path);
    }
    await assert.rejects(createDemoSnapshotReader(root).read(receipt));
  });
}

test('exclusive writer cannot overwrite preexisting evidence or follow a symlink', async (t) => {
  const root = await directory(t), outside = join(root, 'outside');
  await writeFile(outside, 'preserve', {mode: 0o600});
  await symlink(outside, snapshotEvidencePath(root, 1));
  await assert.rejects(createDemoSnapshotWriter(root).write(snapshot, provenance), {code: 'EEXIST'});
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
});

for (const bytes of [Buffer.from([0x22, 0xff, 0x22]), Buffer.from('{malformed')]) {
  test('valid length/hash do not admit invalid UTF-8 or JSON', async (t) => {
    const root = await directory(t);
    await writeFile(snapshotEvidencePath(root, 1), bytes, {mode: 0o600});
    const receipt = {sequence: 1, byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), provenance};
    await assert.rejects(createDemoSnapshotReader(root).read(receipt));
  });
}
