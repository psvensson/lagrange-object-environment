import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {stat} from 'node:fs/promises';
import {runNode, withRestartDirectory} from './support/restart-process.js';
import {loadError, IMAGE, PROJECT, MEMBER} from './support/yaxo-environment.js';

const child = fileURLToPath(new URL('./support/yaxo-restart-child.js', import.meta.url));

test('E6 real-runtime lane is required in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('E6 fresh process reacquires the edited application from disk and continues ordinary interaction', {
  skip: Boolean(loadError), timeout: 300_000,
}, async (t) => withRestartDirectory(async (directory) => {
  const filename = join(directory, 'application.sqlite');
  // The only recovery inputs. Reports remain here for comparisons and are
  // NEVER included in a subsequent child's arguments or environment.
  const locator = JSON.stringify({imageId: IMAGE, projectId: PROJECT, memberKey: MEMBER});
  const a = await runNode([child, 'create', filename, locator], {signal: t.signal});
  assert.ok((await stat(filename)).size > 0, 'A left a real durable database');
  const b = await runNode([child, 'recover', filename, locator], {signal: t.signal});
  const created = JSON.parse(a.stdout);
  const recovered = JSON.parse(b.stdout);
  assert.notEqual(a.pid, b.pid);
  assert.notEqual(created.resourceScope, recovered.resourceScope);
  assert.ok(created.handles.every((handle) => !recovered.handles.includes(handle)));
  for (const result of [created, recovered]) {
    assert.ok(result.liveResources > 0);
    assert.equal(result.resourcesAfterClose, 0);
    assert.equal(result.closed, true);
  }
  assert.deepEqual(recovered.root, created.root);
  assert.deepEqual(recovered.textRef, created.textRef);
  assert.deepEqual(recovered.initialGraph, created.finalGraph, 'disk recovery preserves complete observed graph/state');
  assert.equal(recovered.initialFrontier, created.finalFrontier);
  assert.equal(recovered.beforeText, 'Persisted text');
  assert.equal(recovered.afterText, 'Continued text');
  assert.equal(recovered.provisioningAttempts, 1, 'only the explicitly refused negative control attempted setup');
  assert.ok(recovered.finalFrontier > recovered.initialFrontier, 'continued operation actually committed');
}));
