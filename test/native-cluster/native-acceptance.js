// Semantic acceptance composes existing process owners; it owns no child kill
// mechanism, native readiness protocol, cohort loop, or image semantics.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {startDemoProcess} from '../../examples/native-cluster/demo-process.js';
import {createDemoSnapshotReader} from '../../examples/native-cluster/demo-snapshot-evidence.js';
import {IMAGE, PROJECT} from '../../examples/native-cluster/deployment.js';
import {validateRuntimeSelection} from '../../examples/native-cluster/runtime-selection.js';
import {ownedProcess} from './process-owner.js';

const CLEAN = Object.freeze({code: 0, signal: null, killed: false, error: null});
const clean = (status) => status && status.code === 0 && !status.signal && !status.killed && !status.error;
function markerCounts(stdout, marker) {
  const complete = stdout.split('\n').slice(0, -1).map((line) => line.replace(/\r$/, ''))
    .filter((line) => line === marker || line === `test real_cluster_native_navigation ... ${marker}`).length;
  return {complete, occurrences: stdout.split(marker).length - 1};
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function assertProvenance(provenance, selection) {
  assert.deepEqual(provenance, {backend: 'lagrange', durable: true,
    lagrangeVersion: selection.version, lagrangeRevision: selection.revision,
    expectedImagesRevision: selection.imagesRevision, runtimeSelection: selection},
  'Snapshot provenance must describe the admitted real runtime and Images identities');
}

async function verifyUnauthenticated(endpoint, deadline, signal, fetchImpl, now) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new Error('Native acceptance cancelled'));
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Unauthenticated read deadline')),
    Math.max(0, deadline - now()));
  let response, reader, primary;
  const cleanup = [];
  try {
    response = await fetchImpl(endpoint + '/v1/read', {method: 'POST', redirect: 'error',
      signal: controller.signal, headers: {'content-type': 'application/json'},
      body: JSON.stringify({protocol: 'environment-image-read/v1', operation: 'project',
        imageId: IMAGE, projectId: PROJECT})});
    assert.equal(response.status, 401, 'The real read service must reject an absent credential');
    // Drain the entire refusal under the same request/body budget.
    reader = response.body?.getReader();
    let bytes = 0;
    if (reader) for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error('Unauthenticated read response exceeds its body bound');
    }
  } catch (error) { primary = error; }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    controller.abort();
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); }
    catch (error) { cleanup.push(error); }
    try { reader?.releaseLock(); } catch (error) { cleanup.push(error); }
  }
  const failures = [primary, ...cleanup].filter(Boolean);
  if (failures.length > 1) throw new AggregateError(failures,
    'Unauthenticated read failed with incomplete response cleanup', {cause: primary ?? failures[0]});
  if (failures.length) throw failures[0];
}

export function createNativeAcceptance({endpoint, onFailure, nativeBinary, testBinary,
  credentialFile, runDirectory, selection, seedControl, deadline,
  startNative = startDemoProcess, startAction = ownedProcess, fetchImpl = globalThis.fetch,
  makeReader = createDemoSnapshotReader, writeMarker = writeFile,
  now = () => performance.now(), onStage = () => {}}) {
  // No I/O or process acquisition is allowed in this constructor. ready() is
  // called only after the cohort has retained this four-method owner.
  const mapped = deferred(), finished = deferred(), failed = deferred();
  mapped.promise.catch(() => {}); failed.promise.catch(() => {});
  const controller = new AbortController();
  const semanticDeadline = deadline - 15_000;
  let cli, action, cliClosure, actionClosure, journey, shutdown;
  let firstFailure, stopping = false, semanticComplete = false, mappedReady = false, settled = false;
  let actionMayExit = false, actionStatus;
  const cleanupFailures = [];

  function fail(error) {
    if (firstFailure) return;
    firstFailure = error;
    failed.reject(error); controller.abort(error);
    try { onFailure(error); }
    catch (observerError) { cleanupFailures.push(observerError); }
  }
  function guard() {
    if (firstFailure) throw firstFailure;
    if (stopping) throw new Error('Native acceptance is stopping');
    if (now() >= semanticDeadline) throw new Error('Native acceptance semantic deadline');
  }
  function phase(name, details) {
    guard(); onStage(name, details); guard();
  }
  function stageDeadline(limit, startupDeadline) {
    guard();
    const end = Math.min(now() + limit, semanticDeadline, startupDeadline ?? Infinity);
    if (!(end > now())) throw new Error('Native acceptance stage deadline');
    return end;
  }
  async function wait(promise, end, label) {
    let timer;
    try {
      const value = await Promise.race([promise, failed.promise,
        new Promise((_resolve, reject) => { timer = setTimeout(() =>
          reject(new Error(`${label}: deadline`)), Math.max(0, end - now())); })]);
      guard(); return value;
    } finally { clearTimeout(timer); }
  }
  function closureFailure(label, error) {
    const value = error instanceof Error ? error : new Error(`${label}: incomplete child closure`);
    if (!cleanupFailures.includes(value)) cleanupFailures.push(value);
    fail(value);
  }
  function closeCli() {
    if (!cli) return Promise.resolve();
    if (cliClosure) return cliClosure;
    const result = deferred(); cliClosure = result.promise;
    // Invoke the delegated stop synchronously, including cancellation from
    // inside a factory. The returned closure promise alone is memoized.
    try {
      Promise.resolve(cli.stop()).then((status) => {
        if (!clean(status)) {
          const error = new Error('Actual native CLI did not close cleanly', {cause: status?.error});
          error.status = status; closureFailure('native CLI', error);
        }
        result.resolve(status);
      }, (error) => { closureFailure('native CLI', error); result.resolve(); });
    } catch (error) { closureFailure('native CLI', error); result.resolve(); }
    return cliClosure;
  }
  function closeAction() {
    if (!action) return Promise.resolve();
    if (actionClosure) return actionClosure;
    const result = deferred(); actionClosure = result.promise;
    try {
      Promise.resolve(action.terminate()).then((status) => {
        if (!clean(status)) {
          const error = new Error('Native action child did not close cleanly', {cause: status?.error});
          error.status = status; closureFailure('native action', error);
        }
        result.resolve(status);
      }, (error) => { closureFailure('native action', error); result.resolve(); });
    } catch (error) { closureFailure('native action', error); result.resolve(); }
    return actionClosure;
  }
  function closeDelegates() {
    // Start both closures before awaiting either; a pending waiter must not
    // delay shutdown of the child that can release that waiter.
    return Promise.all([closeCli(), closeAction()]);
  }
  function settle() {
    if (settled) return;
    settled = true;
    if (!semanticComplete && !firstFailure) fail(new Error('Native acceptance stopped before completion'));
    if (!mappedReady) mapped.reject(firstFailure ?? new Error('Actual native CLI was never ready'));
    const errors = [...new Set([firstFailure, ...cleanupFailures].filter(Boolean))];
    const error = errors.length > 1 ? new AggregateError(errors,
      'Native acceptance failed with incomplete cleanup', {cause: firstFailure}) : errors[0];
    finished.resolve(error ? {code: 1, signal: null,
      killed: cleanupFailures.some((failure) => failure.status?.killed || failure.status?.signal === 'SIGKILL'),
      error} : {...CLEAN});
  }

  async function run(startupDeadline) {
    try {
      validateRuntimeSelection(selection);
      assert.equal(selection.kind, 'source-development', 'Source acceptance requires an explicit source selection');
      assert(Number.isFinite(deadline) && Number.isFinite(startupDeadline), 'Acceptance requires absolute bounded deadlines');
      guard();
      const reader = makeReader(join(runDirectory, 'evidence'));
      phase('baseline-snapshot');
      const beforeDeadline = stageDeadline(30_000, startupDeadline);
      const beforeReceipt = await wait(seedControl.snapshot(beforeDeadline), beforeDeadline, 'Baseline snapshot');
      assertProvenance(beforeReceipt.provenance, selection);
      const baseline = await wait(reader.read(beforeReceipt), beforeDeadline, 'Baseline evidence read');
      phase('baseline-verified', beforeReceipt);

      const refusalDeadline = stageDeadline(10_000, startupDeadline);
      await wait(verifyUnauthenticated(endpoint, refusalDeadline, controller.signal, fetchImpl, now),
        refusalDeadline, 'Unauthenticated read');
      phase('native-cli');
      const cliDeadline = stageDeadline(20_000, startupDeadline);
      cli = startNative({file: nativeBinary,
        args: ['view', '--endpoint', endpoint, '--image', IMAGE, '--project', PROJECT,
          '--credential-file', credentialFile, '--member', 'root'],
        label: 'native-client', logFile: join(runDirectory, 'native-client.log'), onFailure: fail,
        options: {cwd: runDirectory, env: {...process.env, LC_ALL: 'C', LC_NUMERIC: 'C'}}});
      if (stopping || firstFailure) void closeCli();
      guard();
      await wait(cli.ready(cliDeadline), cliDeadline, 'Actual native executable');
      mappedReady = true; mapped.resolve();
      phase('native-mapped');
      await wait(closeCli(), semanticDeadline, 'Actual native CLI closure');
      phase('native-actions');
      const revoked = join(runDirectory, 'revoked');
      action = startAction(testBinary,
        ['--ignored', '--exact', 'real_cluster_native_navigation', '--nocapture', '--test-threads=1'],
        {cwd: runDirectory, env: {...process.env, LC_ALL: 'C', LC_NUMERIC: 'C',
          OE_CLUSTER_ORACLE: baseline.path, OE_CLUSTER_ENDPOINT: endpoint,
          OE_CLUSTER_CREDENTIAL: credentialFile, OE_CLUSTER_REVOKED: revoked}});
      if (stopping || firstFailure) void closeAction();
      Promise.resolve(action.exit).then((status) => {
        actionStatus = status;
        if (!clean(status) || !actionMayExit) fail(new Error('Native action child exited before successful completion',
          {cause: status?.error}));
      }, fail);
      guard();
      const navigationDeadline = stageDeadline(80_000);
      const revokeMarker = await wait(action.until(({stdout, exited, status}) => {
        const marker = markerCounts(stdout, 'NATIVE_CLUSTER_REVOKE');
        return (marker.complete > 0 || marker.occurrences > 1) && {exited, status, marker};
      },
      Math.max(1, navigationDeadline - now()), 'native navigation'), navigationDeadline, 'Native navigation');
      assert.deepEqual(revokeMarker.marker, {complete: 1, occurrences: 1}, 'Exactly one native revoke marker is required');
      if (revokeMarker.exited || actionStatus) throw new Error('Native action exited before revocation');
      phase('authority-revocation');
      const revokeDeadline = stageDeadline(5_000);
      const revokedReply = await wait(seedControl.revoke(revokeDeadline), revokeDeadline, 'Authority revocation');
      assert.deepEqual(revokedReply, {revoked: true}, 'Private seed revocation must acknowledge completion');
      guard();
      actionMayExit = true;
      await wait(writeMarker(revoked, 'revoked\n', {flag: 'wx', mode: 0o600}),
        semanticDeadline, 'Revocation marker');
      phase('native-revoked');
      const exitDeadline = stageDeadline(40_000);
      const outcome = await wait(action.until(({stdout, exited, status}) => exited &&
        {status, passed: markerCounts(stdout, 'NATIVE_CLUSTER_ACTIONS_PASSED'),
          revoked: markerCounts(stdout, 'NATIVE_CLUSTER_REVOKE')},
      Math.max(1, exitDeadline - now()), 'native revocation and teardown'), exitDeadline, 'Native action closure');
      assert(clean(outcome.status), 'Native action child must close successfully without an error or signal');
      assert.deepEqual(outcome.passed, {complete: 1, occurrences: 1},
        'Native action child must report exactly one NATIVE_CLUSTER_ACTIONS_PASSED');
      assert.deepEqual(outcome.revoked, {complete: 1, occurrences: 1},
        'Native action child must report exactly one NATIVE_CLUSTER_REVOKE');
      const exit = await wait(action.exit, exitDeadline, 'Native action stdio closure');
      assert(clean(exit), 'Native action process and stdio must close successfully');
      await wait(closeAction(), semanticDeadline, 'Native action owner closure');

      phase('after-snapshot');
      const afterDeadline = stageDeadline(30_000);
      const afterReceipt = await wait(seedControl.snapshot(afterDeadline), afterDeadline, 'Independent cluster reread');
      assertProvenance(afterReceipt.provenance, selection);
      const after = await wait(reader.read(afterReceipt), afterDeadline, 'Independent evidence read');
      phase('after-read', afterReceipt);
      assert.deepEqual(after.snapshot, baseline.snapshot,
        'Native reads, refusals and revocation must preserve the complete records and history');
      phase('after-verified', afterReceipt);
      semanticComplete = true;
    } catch (error) { fail(error); }
    finally {
      // Public stop waits for this journey, so this block calls only memoized
      // delegated closures. There is no stop -> journey -> stop dependency.
      await closeDelegates();
      settle();
    }
  }

  return Object.freeze({
    ready(startupDeadline) {
      if (!journey && !stopping) journey = Promise.resolve().then(() => run(startupDeadline));
      return mapped.promise;
    },
    assertAlive() {
      if (firstFailure) throw firstFailure;
      if (stopping && !semanticComplete) throw new Error('Native acceptance is stopping');
      if (settled && !semanticComplete) throw new Error('Native acceptance is incomplete');
    },
    closed: finished.promise,
    stop() {
      if (shutdown) return shutdown;
      const result = deferred(); shutdown = result.promise;
      stopping = true;
      if (!semanticComplete) fail(firstFailure ?? new Error('Native acceptance stopped before completion'));
      // Cancellation retires adapter waits immediately and closes all already
      // acquired delegates before waiting for the journey to unwind.
      void closeDelegates();
      Promise.resolve(journey).then(async () => {
        await closeDelegates(); settle(); return finished.promise;
      }).then(result.resolve, (error) => { closureFailure('native acceptance', error); settle();
        finished.promise.then(result.resolve); });
      return shutdown;
    },
  });
}
