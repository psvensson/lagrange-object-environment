import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';

// Keep all three probes bound at once so the OS cannot select the same port
// twice. Release once; a subsequent collision is a visible failure, no retry.
export async function clusterPorts() {
  const probes = [];
  try {
    for (let i = 0; i < 3; i++) {
      const probe = createServer();
      probes.push(probe);
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
    }
    return probes.map((probe) => probe.address().port);
  } finally {
    await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  }
}

export function ownedProcess(command, args, options = {}) {
  const child = spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let stdout = '', stderr = '';
  const messages = [];
  const waiters = new Set();
  let exited = false, status, processError;
  function wake() { for (const waiter of [...waiters]) waiter(); }
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); process.stdout.write(chunk); wake(); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4 * 1024 * 1024); process.stderr.write(chunk); wake(); });
  child.on('message', (message) => { messages.push(message); wake(); });
  const exit = new Promise((resolve) => {
    child.once('close', (code, signal) => { exited = true; status = processError ? {code, signal, error: processError.message} : {code, signal}; wake(); resolve(status); });
    // A post-spawn IPC error is not process death. Keep custody through close.
    child.on('error', (error) => { processError = error; wake(); });
  });
  async function until(predicate, timeout, label) {
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const value = predicate({stdout, stderr, messages, exited, status});
        if (value) { clearTimeout(timer); waiters.delete(check); resolve(value); }
        else if (exited) { clearTimeout(timer); waiters.delete(check); reject(new Error(`${label}: early process exit ${JSON.stringify(status)}`)); }
      };
      timer = setTimeout(() => { waiters.delete(check); reject(new Error(`${label}: deadline ${timeout}ms`)); }, timeout);
      waiters.add(check); check();
    });
  }
  return {child, exit, until, messages,
    async terminate() {
      if (exited) return status;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 12_000);
      try { return await exit; } finally { clearTimeout(timer); }
    },
  };
}
