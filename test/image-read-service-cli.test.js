import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../hosts/image-read-service/main.js', import.meta.url));
const marker = (text) => 'process.stdout.write(' + JSON.stringify(text + '\n') + ');';
async function run(t, source, waitFor) {
  const directory = await mkdtemp(join(tmpdir(), 'image-read-cli-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const deployment = join(directory, 'deployment.mjs');
  await writeFile(deployment, source);
  const child = spawn(process.execPath, [cli, '--deployment', deployment, '--port', '0', '--shutdown-timeout-ms', '100'],
    {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  let ready;
  const waiting = new Promise((resolve) => { ready = resolve; });
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes(waitFor)) ready(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ceiling = setTimeout(() => child.kill('SIGKILL'), 4000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(ceiling); ready(); resolve({code, signal}); });
  });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
  if (waitFor) { await waiting; assert.ok(stdout.includes(waitFor), stdout + stderr); child.kill('SIGTERM'); }
  const exit = await done;
  assert.equal(exit.signal, null, 'owned child must exit before the outer test ceiling');
  return {...exit, stdout, stderr};
}

// CLI lifecycle proof: stand-in dependencies deliberately isolate process/socket
// ownership. The adjacent integration suite proves real Images authorization.
const config = `const service = {
  imageId: 'i', objectReadBlockId: 'b', authenticateRequest: () => null, authorityForIdentity: () => null,
  adapter: {readProject() {}, async bindObjectRead() { return {read() {}}; }},
};`;

test('CLI listens, drains and closes deployment; failures never print provider details', {timeout: 15_000}, async (t) => {
  const normal = await run(t, config + `export async function createDeployment() {
    return {service, async close() { ${marker('closed')} }};
  }`, '"event":"listening"');
  assert.equal(normal.code, 0); assert.match(normal.stdout, /closed/); assert.equal(normal.stderr, '');
  const failed = await run(t, config + `service.adapter.bindObjectRead = async () => { throw new Error('credential SECRET'); };
    export async function createDeployment() { return {service, async close() { ${marker('closed')} }}; }`);
  assert.equal(failed.code, 1); assert.match(failed.stdout, /closed/);
  assert.equal(failed.stderr, 'Read service failed.\n');
  const closeFailure = await run(t, config + `export async function createDeployment() {
    return {service, async close() { setInterval(() => {}, 1000); throw new Error('credential SECRET'); }};
  }`, '"event":"listening"');
  assert.equal(closeFailure.code, 1); assert.equal(closeFailure.stderr, 'Read service failed.\n');
});

test('SIGTERM bounds module startup, deployment startup and non-cooperative shutdown', {timeout: 15_000}, async (t) => {
  for (const source of [
    `setInterval(() => {}, 1000); ${marker('import held')} await new Promise(() => {}); export function createDeployment() {}`,
    `export async function createDeployment() { setInterval(() => {}, 1000); ${marker('factory held')} await new Promise(() => {}); }`,
    config + `export async function createDeployment() {
      return {service, close: () => new Promise(() => {})};
    }`,
    config + `export async function createDeployment() {
      return {service, async close() { setInterval(() => {}, 1000); }};
    }`,
  ]) {
    const mark = source.includes('import held') ? 'import held'
      : source.includes('factory held') ? 'factory held' : '"event":"listening"';
    const result = await run(t, source, mark);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'Read service shutdown did not complete.\n');
  }
});
