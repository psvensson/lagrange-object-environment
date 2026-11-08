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
  startupMs = 160_000, pollMs = 250, onStage = () => {}, onCleanupFailure = () => {}}) {
  const deadline = performance.now() + startupMs;
  const owners = [];
  let firstFailure, rejectFailure, primary;
  const failed = new Promise((_resolve, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const fail = (error) => { if (!firstFailure) { firstFailure = error; rejectFailure(error); } };
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
    onStage('Waiting for the three expected nodes');
    for (;;) {
      guard();
      const rows = await protect(owners[0].request('members', deadline));
      if (exactDemoMembership(rows, expected)) break;
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
    onStage('Stopping the demo processes');
    // All owned groups begin shutdown together; one child cannot delay the
    // others' TERM/KILL ceilings. Keep the original operation failure separate.
    const results = await Promise.allSettled(owners.map((owner) => owner.stop()));
    const incomplete = results.filter((result) => result.status === 'rejected' ||
      result.value.killed || result.value.code !== 0 || result.value.signal || result.value.error);
    if (incomplete.length) {
      onCleanupFailure(incomplete);
      primary ??= new Error('Demo cleanup was incomplete; see private run logs');
    }
  }
  if (primary) throw primary;
}
