import assert from 'node:assert/strict';
import test from 'node:test';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {api, loadError, verifySource, manifestBytes, prepare, openEnvironment, stage} from './support/yaxo-environment.js';

test('E4 consumes pinned real source input, and a changed export is refused', () => {
  verifySource();
  const changed = Buffer.from(manifestBytes);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => verifySource(changed), /canonical Cuis export byte identity/);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.classes.length, 24);
  assert.equal(manifest.methods.length, 341);
  assert.deepEqual(manifest.packages, [{name: 'YAXO', requires: []}]);
});

test('E4 real application lane is required in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('E4 real YAXO Project root and domain graph use only ordinary authorized inspector actions', {
  skip: Boolean(loadError), timeout: 120_000,
}, async () => {
  const runtime = await api.createRuntime({
    backend: {instance: new api.LagrangeBackend({runtime: createSqliteApplicationRuntime()})},
  });
  let environment;
  try {
    const expected = await stage('application setup and oracle', () => prepare(runtime));
    environment = await stage('Environment read lane and Project', () => openEnvironment(runtime));
    const e = environment;
    assert.deepEqual(e.rootRef, expected.document, 'the Project exposes the exact native parse result');

    let denied = await e.activateRoot(e.projectAuthority);
    assert.equal(denied.kind, 'unauthorized-reference', 'Project membership grants no root read');
    assert.equal(denied.parameters.fields, undefined);
    assert.equal(denied.parameters.references, undefined);
    await e.activateRoot();
    assert.ok(e.descriptor().parameters.references.length > 0);
    const rootReferences = [...e.descriptor().parameters.references];
    const deniedTargets = [];
    for (let index = 0; index < rootReferences.length; index += 1) {
      await e.activateRoot();
      denied = await e.activateReference(index, e.grantFor(e.rootRef));
      assert.equal(denied.kind, 'unauthorized-reference', 'a root grant does not authorize a disclosed reference');
      assert.equal(denied.parameters.fields, undefined);
      assert.equal(denied.parameters.references, undefined);
      deniedTargets.push(api.objectRef(denied.subject.imageId, denied.subject.objectId));
    }
    assert.ok(deniedTargets.some((ref) => JSON.stringify(ref) === JSON.stringify(expected.documentElements)),
      'the denial includes the actual application collection, not only a singleton');

    // Bounded generic traversal, as repeated rendered actions from the Project.
    // Queue entries are action-index paths, NEVER oracle refs or inferred slot
    // ids. Every new edge is learned from a freshly displayed descriptor.
    const queue = [[]];
    const seen = new Map();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      assert.ok(queue.length < 100, 'the small application traversal must stay bounded');
      const path = queue[cursor];
      await e.activateRoot();
      for (const index of path) await e.activateReference(index);
      const descriptor = e.descriptor();
      assert.equal(descriptor.kind, 'inspector');
      const key = JSON.stringify(descriptor.subject);
      if (seen.has(key)) continue;
      seen.set(key, descriptor);
      for (let index = 0; index < descriptor.parameters.references.length; index += 1) {
        queue.push([...path, index]);
      }
    }
    for (const ref of Object.values(expected)) {
      assert.ok(seen.has(JSON.stringify(ref)), 'ordinary actions reach native domain ref ' + ref.objectId);
    }
    assert.ok(Object.values(seen.get(JSON.stringify(expected.text)).parameters.fields)
      .some((value) => value.kind === 'text' && value.value === 'Tove'),
    'the final inspector displays the native XMLStringNode value');
    assert.deepEqual(e.attemptedReads, e.expectedAttempts);
    assert.deepEqual(runtime.toolchainProviders.list(), []);
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  } finally {
    if (environment) await environment.compositor.destroy();
    await runtime.close();
  }
});
