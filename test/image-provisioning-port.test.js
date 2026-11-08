import assert from 'node:assert/strict';
import test from 'node:test';
import {createImageProvisioningPort} from '../src/index.js';

function client(overrides = {}) {
  return {
    images: {},
    provisionShape: (request) => request,
    provisionObject: (request) => request,
    objectRef: (imageId, objectId) => ({imageId, objectId}),
    textValue: (value) => ({value}),
    integerValue: (value) => ({value}),
    ...overrides,
  };
}

test('the trusted provisioning port has a frozen, closed surface with no raw service', () => {
  const input = client();
  const port = createImageProvisioningPort(input);
  assert.ok(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port).sort(), [
    'integerValue', 'objectRef', 'provisionObject', 'provisionShape', 'textValue',
  ]);
  assert.equal(Object.values(port).includes(input.images), false);
  for (const name of ['objectRef', 'textValue', 'integerValue']) {
    assert.equal(port[name], input[name], 'the public Value constructor retains its identity');
  }
});

test('provisioning captures its dependencies and forwards only the exact public request', () => {
  const input = client();
  const images = input.images;
  const port = createImageProvisioningPort(input);
  input.images = {foreign: true};
  input.provisionObject = () => { throw new Error('replaced dependency must not run'); };
  const shape = {id: 'shape'};
  const object = {id: 'object'};
  const foreign = {images: input.images, provisionObject: input.provisionObject};
  assert.deepEqual(port.provisionShape({imageId: 'image', shape, ...foreign}),
    {images, imageId: 'image', shape});
  assert.deepEqual(port.provisionObject({imageId: 'image', object, ...foreign}),
    {images, imageId: 'image', object, seed: false});
  assert.deepEqual(port.provisionObject({imageId: 'image', object, seed: true}),
    {images, imageId: 'image', object, seed: true});
  assert.equal(port.provisionObject({object}).object, object, 'the record is not copied or reinterpreted');
});

test('the port preserves owner promise and failure identities without extra wrapping', async () => {
  const failure = new TypeError('lower owner conflict');
  const result = Promise.resolve({id: 'already-installed'});
  const port = createImageProvisioningPort(client({
    provisionShape: () => result,
    provisionObject: () => { throw failure; },
  }));
  assert.equal(port.provisionShape({}), result);
  assert.throws(() => port.provisionObject({}), (error) => error === failure);
  const rejected = Promise.reject(failure);
  const rejecting = createImageProvisioningPort(client({provisionObject: () => rejected}));
  assert.equal(rejecting.provisionObject({}), rejected);
  await assert.rejects(rejected, (error) => error === failure);
});

test('the factory neither provisions on construction nor invents a missing dependency', () => {
  const refusal = () => { throw new Error('construction must perform no image operation'); };
  createImageProvisioningPort(client({provisionShape: refusal, provisionObject: refusal}));
  for (const value of [undefined, null, {}, {images: null}, {images: 'image'}]) {
    assert.throws(() => createImageProvisioningPort(value), TypeError);
  }
  for (const name of ['provisionShape', 'provisionObject', 'objectRef', 'textValue', 'integerValue']) {
    assert.throws(() => createImageProvisioningPort(client({[name]: undefined})),
      {name: 'TypeError', message: `image provisioning requires public Images helper: ${name}`});
  }
});
