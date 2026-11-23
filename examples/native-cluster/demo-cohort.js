import {performance} from 'node:perf_hooks';

export function exactDemoMembership(rows, expected) {
  if (!Array.isArray(rows) || rows.length > 3) throw new Error('Unexpected cluster membership');
  const found = new Set();
  for (const row of rows) {
    if (!row || typeof row.status !== 'string' || !expected.includes(row.nodeId) || found.has(row.nodeId)) {
      throw new Error('Unexpected cluster member identity');
    }
    found.add(row.nodeId);
  }
  return found.size === 3 && rows.every((row) => row.status === 'active');
}

export async function runDemoCohort({nodes, startWorker, startNative, signal,
  probeReadiness = null, startupMs = 160_000, pollMs = 250,
  onStage = () => {}, onCleanupFailure = () => {}}) {
  const started = performance.now();
  const deadline = started + startupMs;
  const owners = [];
  const readinessController = new AbortController();
  let readinessWork;
  let membershipAttempts = 0, readinessAttempts = 0;
  let lastMembership = null, lastReadiness = null;
  let firstFailure, rejectFailure, primary;
  const secondaryFailures = [];
  const retainReportingFailure = (error) => {
    if (!primary) primary = error;
    else if (error !== primary) secondaryFailures.push(error);
  };
  const failed = new Promise((_resolve, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const fail = (error) => { if (!firstFailure) {
    firstFailure = error; readinessController.abort(error); rejectFailure(error);
  } };
  const abort = () => fail(signal.reason ?? new Error('Demo interrupted'));
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const guard = () => {
    if (firstFailure) throw firstFailure;
    if (performance.now() >= deadline) throw new Error('Demo startup deadline');
    for (const owner of owners) owner.assertAlive();
  };
  const protect = (promise) => Promise.race([promise, failed]);
  try {
    for (let index = 0; index < nodes.length; index++) {
      guard(); onStage(`Starting node ${index + 1} of 3`); guard();
      const owner = startWorker(nodes[index], fail);
      owners.push(owner);
      await protect(owner.ready(deadline)); guard();
      const value = await protect(owner.request('start', deadline));
      if (value?.started !== true || Object.keys(value).length !== 1) throw new Error('Invalid node start reply');
    }
    const expected = nodes.map((node) => node.configuration.node.id);
    onStage(probeReadiness ? 'Waiting for the expected nodes and seed serving readiness'
      : 'Waiting for the three expected nodes');
    for (;;) {
      guard();
      const round = ++membershipAttempts;
      const rows = await protect(owners[0].request('members', deadline));
      const complete = exactDemoMembership(rows, expected);
      // Retain only the latest validated observation, with no references to
      // worker-owned rows. Evidence observes this owner; it never decides
      // membership or treats an older probe as current serving authority.
      lastMembership = Object.freeze({round, elapsedMs: Math.round(performance.now() - started),
        rows: Object.freeze(rows.map(({nodeId, status}) => Object.freeze({nodeId, status}))), complete});
      if (complete) {
        if (!probeReadiness) break;
        guard();
        // Only the seed serves the application handle used for installation.
        // The three identities and every worker's liveness remain separate
        // requirements; no local serving verdict is inferred from membership.
        readinessAttempts++;
        readinessWork = Promise.resolve().then(() => probeReadiness(nodes[0], {
          deadline, signal: readinessController.signal,
        }));
        const ready = await protect(readinessWork);
        guard();
        if (typeof ready !== 'boolean') throw new Error('Invalid serving-readiness result');
        lastReadiness = Object.freeze({round, elapsedMs: Math.round(performance.now() - started), ready});
        if (ready) break;
      }
      let timer;
      try { await protect(new Promise((resolve) => {
        timer = setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - performance.now())));
      })); } finally { clearTimeout(timer); }
    }
    guard(); onStage('Installing the demonstration image'); guard();
    const address = await protect(owners[0].request('install', deadline));
    if (address?.host !== '127.0.0.1' || address.secure !== false ||
      !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
      throw new Error('Invalid application read-service address');
    }
    guard(); onStage('Opening the native client'); guard();
    const native = startNative(`http://127.0.0.1:${address.port}`, fail);
    owners.push(native);
    await protect(native.ready(deadline)); guard();
    onStage('Ready: browse the Project, follow references, inspect objects and Refresh');
    const status = await protect(native.closed);
    if (status.code !== 0 || status.signal || status.error || status.killed) throw new Error('Native client failed');
  } catch (error) { primary = error; }
  finally {
    signal.removeEventListener('abort', abort);
    readinessController.abort(primary ?? new Error('Demo cohort closing'));
    try { onStage('Stopping the demo processes', Object.freeze({startupObservation: Object.freeze({
      membershipAttempts, lastMembership, readinessAttempts, lastReadiness,
    })})); }
    catch (error) { retainReportingFailure(error); }
    // All owned groups begin shutdown together; one child cannot delay the
    // others' TERM/KILL ceilings. Keep the original operation failure separate.
    const results = await Promise.allSettled(owners.map((owner) =>
      Promise.resolve().then(() => owner.stop())));
    // Runtime shutdown begins before waiting for the bounded HTTP delegate.
    // A failed readiness operation belongs to its original caller, not to
    // process cleanup, but its body cannot be left running after this owner.
    try { await readinessWork; } catch { /* Preserve the first operation failure. */ }
    const incomplete = results.filter((result) => result.status === 'rejected' ||
      !result.value || typeof result.value !== 'object' || result.value.killed ||
      result.value.code !== 0 || result.value.signal || result.value.error);
    if (incomplete.length) {
      const cleanupFailure = new Error('Demo cleanup was incomplete; see private run logs', {
        cause: incomplete[0].status === 'rejected' ? incomplete[0].reason : incomplete[0].value?.error,
      });
      primary ??= cleanupFailure;
      try { onCleanupFailure(incomplete); }
      catch (error) {
        if (primary !== cleanupFailure) secondaryFailures.push(cleanupFailure);
        retainReportingFailure(error);
      }
    }
  }
  if (secondaryFailures.length) {
    throw new AggregateError([primary, ...secondaryFailures],
      'Demo operation or cleanup reporting failed', {cause: primary});
  }
  if (primary) throw primary;
}
