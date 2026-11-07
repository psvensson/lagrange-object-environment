import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

// Admission of Images #294 (Bead 9qz), through its public package ./graph
// entry. This is trusted, kernel-free installation, not a user mutation or an
// Environment Theme implementation. The portable root does not export it.
const runtimeUrl = process.env.LAGRANGE_IMAGES_URL
  ?? new URL('../../lagrange-images/src/runtime.js', import.meta.url).href;
let api;
let graph;
let loadError;
try {
  api = await import(runtimeUrl);
  const packageRoot = new URL('../', runtimeUrl);
  const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  assert.equal(typeof manifest.exports?.['./graph'], 'string', 'Images must publish its graph entry');
  graph = await import(new URL(manifest.exports['./graph'], packageRoot).href);
  for (const name of ['provisionObject', 'provisionShape', 'ProvisioningConflictError']) {
    assert.equal(typeof graph[name], 'function', `the public graph entry must export ${name}`);
  }
} catch (error) {
  loadError = error;
}

test('Images provisioning admission requires the public graph entry in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') {
    assert.ifError(loadError);
  }
});

test('Node public provisioning preserves chosen identities, write-free replay and typed refusal', {
  skip: loadError && 'the pinned Images public graph entry is unavailable',
}, async () => {
  const {provisionObject, provisionShape, ProvisioningConflictError} = graph;
  const runtime = await api.createRuntime({backend: {mode: 'mock'}});
  const imageId = 'environment-provisioning-admission';
  try {
    await runtime.images.createImage({id: imageId});
    // No kernel/class installation: this data belongs to no language personality.
    const shape = {id: 'environment/admission-shape', slots: [{id: 'value', name: 'value'}], indexed: 'none'};
    const object = {
      id: 'environment/admission-object',
      shape: api.objectRef(imageId, shape.id),
      slots: {value: api.textValue('original')},
    };
    const options = {images: runtime.images, imageId};
    await provisionShape({...options, shape});
    await provisionObject({...options, object});
    const storedShape = await runtime.images.getRecord(imageId, shape.id);
    const storedObject = await runtime.images.getRecord(imageId, object.id);
    assert.equal(storedShape.id, shape.id);
    assert.equal(storedObject.id, object.id);
    assert.deepEqual(storedObject.slots, object.slots);
    const token = api.objectVersionToken(imageId, storedObject.id, storedObject._version);

    await provisionShape({...options, shape});
    await provisionObject({...options, object});
    assert.deepEqual(await runtime.images.getRecord(imageId, shape.id), storedShape,
      'identical Shape replay changes neither state nor stored version');
    assert.deepEqual(await runtime.images.getRecord(imageId, object.id), storedObject,
      'identical object replay changes neither state nor stored version');
    const replayedObject = await runtime.images.getRecord(imageId, object.id);
    assert.equal(api.objectVersionToken(imageId, replayedObject.id, replayedObject._version), token);

    const isProvisioningConflict = (error) => {
      assert.ok(error instanceof ProvisioningConflictError, 'never a Smalltalk kernel conflict');
      assert.equal(error.name, 'ProvisioningConflictError');
      return true;
    };
    await assert.rejects(provisionObject({...options, object: {
      ...object, slots: {value: api.textValue('divergent')},
    }}), isProvisioningConflict);
    await assert.rejects(provisionShape({...options, shape: {
      ...shape, slots: [{id: 'value', name: 'different'}],
    }}), isProvisioningConflict);
    assert.deepEqual(await runtime.images.getRecord(imageId, object.id), storedObject,
      'object conflict leaves the occupant and its version unchanged');
    assert.deepEqual(await runtime.images.getRecord(imageId, shape.id), storedShape,
      'Shape conflict leaves the occupant and its version unchanged');
  } finally {
    await runtime.close();
  }
});
