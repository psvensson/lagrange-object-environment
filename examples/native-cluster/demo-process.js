// Owned child/process-group custody delegated by the Native demo launcher.
import {fork, spawn} from 'node:child_process';
import {openSync, writeSync, closeSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {openDemoDiagnostics} from './demo-diagnostics.js';
import {DEMO_GUARDIAN, DEMO_PYTHON} from './demo-guardian.js';

export function startDemoProcess({file, args, options, logFile, label, worker = false,
  onFailure, graceMs = 12_000}) {
  const log = openSync(logFile, 'wx', 0o600);
  let exited = false, outClosed = false, errClosed = false, ipcClosed = !worker, diagnosticClosed = false;
  let status, failure, stopping = false, killed = false, shutdown;
  let ready = false, pending = null, nextId = 0, logBytes = 0, line = '';
  const decoder = new StringDecoder('utf8');
  const watchers = new Set();
  const wake = () => { for (const watcher of [...watchers]) watcher(); };
  const fail = (error) => { if (!failure) { failure = error; onFailure(error); } wake(); };
  let diagnostics, child;
  try {
    diagnostics = openDemoDiagnostics(logFile + '.diagnostics', fail, (record) => {
      const error = new Error(`${label}: ${record.phase} failed; see private diagnostics`);
      error.code = record.errors[0].code; fail(error);
    });
    const guardianArgs = [String(process.pid), String(graceMs / 1000), worker ? 'worker' : 'native',
      worker ? process.execPath : file, ...(worker ? [file instanceof URL ? fileURLToPath(file) : file] : []), ...args];
    const launchOptions = {...options, detached: true,
      stdio: ['ignore', 'pipe', 'pipe', worker ? 'ipc' : 'ignore', 'pipe']};
    child = worker ? fork(DEMO_GUARDIAN, guardianArgs, {...launchOptions, execPath: DEMO_PYTHON,
      execArgv: ['-I', '-S'], serialization: 'json'})
      : spawn(DEMO_PYTHON, ['-I', '-S', DEMO_GUARDIAN, ...guardianArgs], launchOptions);
  } catch (error) { diagnostics?.close(); closeSync(log); throw error; }
  let settleClosed;
  const closed = new Promise((resolve) => { settleClosed = resolve; });
  let settled = false;
  function settle() {
    if (settled || !exited || !outClosed || !errClosed || !ipcClosed || !diagnosticClosed) return;
    settled = true;
    diagnostics.close();
    try { closeSync(log); } catch (error) { failure ??= error; }
    const result = {...status, killed, error: failure ?? null};
    settleClosed(result); wake();
  }
  const truncation = Buffer.from('\n[ordinary demo log truncated at 4 MiB]\n');
  const prefixLimit = 4 * 1024 * 1024 - truncation.length;
  let truncated = false;
  function record(chunk) {
    if (truncated) return;
    const bytes = chunk.subarray(0, prefixLimit - logBytes);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(log, bytes, offset);
      logBytes += bytes.length;
      if (bytes.length < chunk.length) { writeSync(log, truncation); truncated = true; }
    } catch (error) { fail(error); }
  }
  for (const stream of [child.stdout, child.stderr, child.stdio[4]]) stream.on('error', fail);
  child.stdio[4].on('data', (chunk) => diagnostics.write(chunk));
  child.stdio[4].once('close', () => { diagnosticClosed = true; settle(); });
  child.stdout.on('data', (chunk) => {
    record(chunk);
    if (worker || failure) return;
    line += decoder.write(chunk);
    // Only a bounded complete status line can establish native readiness.
    if (line.length > 65536) { line = ''; fail(new Error(`${label}: oversized status output`)); return; }
    let end;
    while ((end = line.indexOf('\n')) >= 0) {
      const text = line.slice(0, end); line = line.slice(end + 1);
      if (text === '{"event":"native-viewer-ready"}') { ready = true; wake(); }
    }
  });
  child.stderr.on('data', record);
  child.stdout.once('close', () => { outClosed = true; settle(); });
  child.stderr.once('close', () => { errClosed = true; settle(); });
  child.once('disconnect', () => {
    ipcClosed = true;
    if (!stopping) fail(new Error(`${label}: IPC disconnected`));
    settle();
  });
  child.on('error', (error) => { fail(error); });
  child.once('exit', (code, signal) => {
    exited = true; killed = signal === 'SIGKILL'; status = {code, signal};
    if (!stopping && (worker || !ready || code !== 0 || signal)) {
      fail(new Error(`${label}: unexpected exit (${code}/${signal})`));
    }
    wake(); settle();
  });
  // Failed spawn may emit close without exit. Normal fork disconnect can do
  // the reverse; the conjunction above retains both pipe/IPC custody facts.
  child.once('close', (code, signal) => {
    status ??= {code, signal}; exited = outClosed = errClosed = ipcClosed = diagnosticClosed = true;
    settle();
  });
  child.on('message', (message) => {
    if (!worker || stopping) return;
    if (!message || Buffer.byteLength(JSON.stringify(message)) > 16384) {
      fail(new Error(`${label}: invalid reply`)); return;
    }
    if (!ready && Object.keys(message).length === 1 && message.event === 'worker-ready') {
      ready = true; wake(); return;
    }
    if (!pending || message.id !== pending.id || typeof message.ok !== 'boolean' ||
      Object.keys(message).length !== (message.ok ? 3 : 2) ||
      (message.ok && !Object.hasOwn(message, 'value')) || pending.replied) {
      fail(new Error(`${label}: unexpected reply`)); return;
    }
    pending.replied = true; pending.reply = message; wake();
  });

  function assertAlive() {
    if (failure) throw failure;
    if (exited || child.exitCode !== null || child.signalCode !== null || stopping) {
      throw new Error(`${label}: process is no longer running`);
    }
  }
  function until(predicate, deadline, phase) {
    return new Promise((resolve, reject) => {
      const remaining = deadline - performance.now();
      if (!(remaining > 0)) { reject(new Error(`${label}: ${phase} startup deadline`)); return; }
      const finish = (error, value) => { clearTimeout(timer); watchers.delete(check);
        if (error) reject(error); else resolve(value); };
      const check = () => {
        try { assertAlive(); const value = predicate(); if (value) finish(null, value); }
        catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error(`${label}: ${phase} startup deadline`)), remaining);
      watchers.add(check); check();
    });
  }
  return {child, closed, assertAlive,
    ready: (deadline) => until(() => ready, deadline, 'ready'),
    async request(command, deadline) {
      assertAlive();
      if (!worker || !ready || pending) throw new Error(`${label}: invalid request state`);
      pending = {id: ++nextId, replied: false};
      try {
        child.send({id: pending.id, command}, (error) => { if (error) fail(error); });
        const reply = await until(() => pending.reply, deadline, command);
        if (!reply.ok) throw new Error(`${label}: ${command} failed; see private run log`);
        return reply.value;
      } finally { pending = null; }
    },
    stop() {
      stopping = true; wake();
      shutdown ??= (async () => {
        if (settled) return closed;
        // The guardian owns descendant drain and its own group deadline.
        // Never target a numeric group after its leader may have disappeared.
        if (!exited) child.kill('SIGTERM');
        return closed;
      })();
      return shutdown;
    },
  };
}
