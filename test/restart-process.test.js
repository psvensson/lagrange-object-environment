import assert from 'node:assert/strict';
import test from 'node:test';
import {access} from 'node:fs/promises';
import {runNode, withRestartDirectory} from './support/restart-process.js';

const sleepy = ['-e', 'setTimeout(() => {}, 10000)'];
function reaped(error) {
  assert.ok(error.childPid);
  assert.equal(error.childExit.signal, 'SIGKILL');
  assert.throws(() => process.kill(error.childPid, 0), {code: 'ESRCH'});
  return true;
}
test('restart process deadlines and cancellation kill and reap a finite child', async () => {
  await assert.rejects(runNode(sleepy, {timeout: 30}), reaped);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(runNode(sleepy, {signal: controller.signal}), reaped); }
  finally { clearTimeout(timer); }
});

test('restart runner refuses valid JSON from a failed child and removes its directory on failure', async () => {
  let directory;
  await assert.rejects(withRestartDirectory(async (path) => {
    directory = path;
    await runNode(['-e', 'process.stdout.write(JSON.stringify({ok:true})); process.exitCode=7']);
  }), (error) => error.childExit.code === 7);
  await assert.rejects(access(directory), {code: 'ENOENT'});
});
