import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Sole owner of restart-test process deadlines, cancellation, exit collection
// and temporary storage. execFile has no shell; every path awaits close before
// the next phase or directory removal. A successful-looking stdout is not exit
// success. Children in this proof never spawn descendants.
export async function runNode(args, {signal, timeout = 120_000} = {}) {
  signal?.throwIfAborted();
  let child;
  const outcome = new Promise((resolve, reject) => {
    child = execFile(process.execPath, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve({stdout, stderr});
    });
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({code, signal})));
  let cancellation = null;
  const abort = () => {
    cancellation = new Error('restart child cancelled', {cause: signal.reason});
    child.kill('SIGKILL');
  };
  // Node's execFile signal path does not honor its timeout killSignal on this
  // host. Own cancellation explicitly, and always collect the close event.
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  let result, failure, exit;
  try { result = await outcome; }
  catch (error) { failure = error; }
  finally {
    signal?.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    exit = await closed;
  }
  if (cancellation) {
    cancellation.stderr = failure?.stderr ?? result?.stderr ?? '';
    cancellation.executionError = failure;
    failure = cancellation;
  }
  if (failure) {
    failure.childPid = child.pid;
    failure.childExit = exit;
    throw failure;
  }
  return {...result, pid: child.pid, exit};
}

export async function withRestartDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'oe-application-restart-'));
  try { return await work(directory); }
  finally { await rm(directory, {recursive: true}); }
}
