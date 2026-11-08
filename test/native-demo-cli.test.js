import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../examples/native-cluster/launch.js', import.meta.url));

test('help starts no runtime and creates no data even with nonexistent dependency paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-help-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const result = await run(process.execPath, [CLI, '--help', '--images-checkout', '/absent',
    '--native-binary', '/absent', '--data-parent', root], {cwd: root, timeout: 3000});
  assert.match(result.stdout, /Usage: npm run demo:native/);
  assert.match(result.stdout, /startup defect still blocks/);
  assert.deepEqual(await readdir(root), []);
});

test('invalid or missing prerequisites fail before data or runtime acquisition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-preconditions-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const args of [[], ['--unknown'], ['--images-checkout', '/absent', '--native-binary', '/absent', '--data-parent', root]]) {
    await assert.rejects(run(process.execPath, [CLI, ...args], {cwd: root, timeout: 3000}), (error) => error.code === 1);
    assert.deepEqual(await readdir(root), []);
  }
});
