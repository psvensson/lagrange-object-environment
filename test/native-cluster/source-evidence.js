// Test-harness export only. Never copy a private run directory wholesale: only
// bounded structured diagnostics and independently validated generated evidence
// may leave it. This delegate owns transfer/redaction, not acceptance semantics.
import assert from 'node:assert/strict';
import {mkdir, open, lstat, readdir, realpath, writeFile} from 'node:fs/promises';
import {constants, openSync, fstatSync, ftruncateSync, writeFileSync, closeSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {createDemoSnapshotReader} from '../../examples/native-cluster/demo-snapshot-evidence.js';
import {validateRuntimeSelection} from '../../examples/native-cluster/runtime-selection.js';

const DIAGNOSTIC_PHASES = ['initialization', 'operation', 'protocol', 'cleanup'];
function sanitized(value) {
  return String(value ?? '').slice(0, 1024)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]')
    .replace(/((?:authorization|credential|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 96);
}
export function sourceFailureRecords(error) {
  const seen = new Set(), records = [];
  function visit(value, depth) {
    if (!value || depth > 3 || records.length >= 8 || seen.has(value)) return;
    seen.add(value);
    const field = (name) => { try { return sanitized(value[name]); } catch { return 'unavailable'; } };
    records.push({name: field('name'), code: field('code'), message: field('message')});
    try {
      if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) visit(child, depth + 1);
      visit(value.cause, depth + 1);
    } catch { /* A broken diagnostic accessor cannot expose an unbounded object. */ }
  }
  visit(error, 0); return records;
}

async function privateBytes(path, bound) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > bound ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Export input is not a bounded private regular file');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new Error('Export input changed while being read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function readDiagnostics(runDirectory) {
  const output = [], errors = [];
  for (const owner of ['node-0', 'node-1', 'node-2', 'native-client']) {
    try {
      const bytes = await privateBytes(join(runDirectory, owner + '.log.diagnostics'), 65536);
      if (!bytes?.length) continue;
      const lines = new TextDecoder('utf-8', {fatal: true}).decode(bytes).split('\n');
      assert.equal(lines.pop(), '', 'Private diagnostics must contain complete records');
      assert(lines.length <= 4, 'Private diagnostics exceeded their phase count');
      const phases = new Set();
      for (const line of lines) {
        assert(Buffer.byteLength(line) < 16384, 'Private diagnostic record is oversized');
        const record = JSON.parse(line);
        assert(record && Object.keys(record).length === 3 && record.event === 'demo-worker-failure' &&
          DIAGNOSTIC_PHASES.includes(record.phase) && !phases.has(record.phase) && Array.isArray(record.errors) &&
          record.errors.length > 0 && record.errors.length <= 8 && record.errors.every((error) => error &&
            Object.keys(error).length === 3 && ['name', 'code', 'message'].every((key) =>
              typeof error[key] === 'string' && error[key].length <= 96)), 'Invalid private diagnostic record');
        phases.add(record.phase);
        output.push({owner, phase: record.phase, errors: record.errors.map((error) =>
          ({name: sanitized(error.name), code: sanitized(error.code), message: sanitized(error.message)}))});
      }
    } catch (error) { errors.push(error); }
  }
  return {output, errors};
}

export async function exportSourceEvidence({directory, runDirectory, selection, provenance,
  phases = [], failure, failureStage, durationMs}) {
  if (!isAbsolute(directory)) throw new TypeError('OE_SOURCE_EVIDENCE_DIR must be absolute');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const destination = await lstat(directory);
  if (!destination.isDirectory() || (destination.mode & 0o077) !== 0 ||
      await realpath(directory) !== resolve(directory) || (await readdir(directory)).length) {
    throw new Error('Evidence export requires a fresh private directory');
  }
  const identity = selection ? validateRuntimeSelection(selection) : null;
  assert(phases.length <= 64, 'Native source phase evidence exceeds its bound');
  const errors = [], files = [], receipts = [];
  const diagnostics = runDirectory ? await readDiagnostics(runDirectory) : {output: [], errors: []};
  errors.push(...diagnostics.errors);
  files.push(['diagnostics.json', JSON.stringify(diagnostics.output, null, 2)]);
  const available = new Map();
  try {
    for (const {receipt} of phases) if (receipt) {
      assert([1, 2].includes(receipt.sequence), 'Invalid exported snapshot sequence');
      if (available.has(receipt.sequence)) assert.deepEqual(receipt, available.get(receipt.sequence), 'Snapshot receipt changed');
      else available.set(receipt.sequence, receipt);
    }
    if (available.size) {
      assert(runDirectory && identity, 'Snapshot export requires the actually admitted session');
      const reader = createDemoSnapshotReader(join(runDirectory, 'evidence'));
      for (const [, receipt] of [...available].sort(([a], [b]) => a - b)) {
        assert.deepEqual(receipt.provenance.runtimeSelection, identity, 'Snapshot export identity mismatch');
        const {bytes} = await reader.read(receipt);
        files.push([`snapshot-${receipt.sequence}.json`, bytes]);
        receipts.push(receipt);
      }
    }
  } catch (error) { errors.push(error); }
  files.push(['receipts.json', JSON.stringify(receipts, null, 2)]);
  for (const [name, bytes] of files) {
    try { await writeFile(join(directory, name), bytes, {flag: 'wx', mode: 0o600}); }
    catch (error) { errors.push(error); }
  }
  const topology = provenance?.topology;
  const manifest = {protocol: 'oe-native-source-evidence/v1',
    outcome: failure || errors.length ? 'failed' : 'pending', runtimeSelection: identity,
    topology: topology ? {processCount: topology.processCount,
      configuredReplicationFactor: topology.configuredReplicationFactor,
      ...(topology.hostCount === undefined ? {} : {hostCount: topology.hostCount, hostId: topology.hostId})} : null,
    phases: phases.map(({stage, elapsedMs}) => ({stage: sanitized(stage), elapsedMs})),
    durationMs, failureStage: failure ? sanitized(failureStage) : null,
    failures: sourceFailureRecords(failure), exportFailures: errors.flatMap((error) => sourceFailureRecords(error)).slice(0, 8),
    snapshots: receipts.map(({sequence, byteLength, sha256}) => ({sequence, byteLength, sha256}))};
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {flag: 'wx', mode: 0o600});
  if (errors.length) throw new AggregateError(errors, 'Native source evidence export failed');
  return manifest;
}

// The asynchronous export is deliberately provisional. The caller performs
// this last small publication synchronously and then reports acceptance with
// no intervening await, so cancellation during export cannot leave a passing
// artifact beside a failed process status.
export function finalizeSourceEvidence({directory, manifest, signal}) {
  assert.equal(manifest.outcome, 'pending', 'Only a complete provisional export can be published');
  const failure = signal.aborted ? signal.reason ?? new Error('Native source acceptance cancelled') : null;
  const final = {...manifest, outcome: failure ? 'failed' : 'accepted',
    ...(failure ? {failureStage: 'evidence publication', failures: sourceFailureRecords(failure)} : {})};
  const file = openSync(join(directory, 'manifest.json'), constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    assert(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 131072,
      'Evidence publication requires its bounded private manifest');
    ftruncateSync(file, 0); writeFileSync(file, JSON.stringify(final, null, 2));
  } finally { closeSync(file); }
  if (failure) throw failure;
  return final;
}
