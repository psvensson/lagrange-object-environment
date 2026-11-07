import assert from 'node:assert/strict';
import test from 'node:test';
import {createImageReadConnection, IMAGE_READ_PROTOCOL as protocol} from '../src/image-read-connection.js';
import {createRemoteImageClientAdapter} from '../src/image-client-adapter.js';

const args = {imageId: 'i', objectId: 'o'};
const response = (result) => ({status: 200, body: JSON.stringify({protocol, ok: true, result})});
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}

test('closed read protocol refuses identity/operation injection and remote error text', async () => {
  const sent = [];
  let reply = response({slots: {x: {kind: 'text', value: 'state'}}, indexed: []});
  const connection = createImageReadConnection({request: async (body) => { sent.push(body); return reply; }});
  const adapter = createRemoteImageClientAdapter({connection});
  assert.deepEqual(Object.keys(adapter).sort(), ['projectWritableFields', 'readObject', 'readProject', 'writableSlots']);
  assert.ok(Object.isFrozen(adapter) && Object.isFrozen(adapter.writableSlots));
  assert.deepEqual(adapter.projectWritableFields, []);
  assert.deepEqual(await adapter.readObject(args), JSON.parse(reply.body).result);
  assert.deepEqual(sent, [{protocol, operation: 'object', ...args}]);
  for (const extra of [{authority: {}}, {blockId: 'arbitrary'}]) {
    assert.throws(() => adapter.readObject({...args, ...extra}), /server-side/);
  }
  for (const extra of [{authority: {}}, {principal: 'root'}, {grants: []}, {operation: 'project'}, {protocol}, {source: 'x'}]) {
    await assert.rejects(connection.readObject({...args, ...extra}), {code: 'IMAGE_READ_BAD_REQUEST'});
  }
  assert.equal(sent.length, 1);
  for (const body of [
    {protocol, ok: false, error: 'DENIED', message: 'credential secret'},
    {protocol, ok: false, error: 'new Error(secret)'},
    {protocol, ok: true, result: {}, stack: 'secret'},
    {protocol: 'future', ok: true, result: {}},
  ]) {
    reply = {status: 403, body: JSON.stringify(body)};
    await assert.rejects(adapter.readObject(args), {code: 'IMAGE_READ_INVALID_RESPONSE'});
  }
  reply = {status: 403, body: JSON.stringify({protocol, ok: false, error: 'DENIED'})};
  await assert.rejects(adapter.readObject(args), {name: 'AuthorityError', message: 'Not authorized to read this subject.'});
  reply = {status: 404, body: JSON.stringify({protocol, ok: false, error: 'NOT_FOUND'})};
  await assert.rejects(adapter.readObject(args), {code: 'OBJECT_NOT_FOUND'});
  reply = {status: 200, body: ' '.repeat(4 * 1024 * 1024 + 1)};
  await assert.rejects(adapter.readObject(args), {code: 'IMAGE_READ_INVALID_RESPONSE'});
  connection.close();
});

test('deadline retains actual transport capacity; late rejection and close never deliver results', async () => {
  const held = deferred();
  let signal;
  const connection = createImageReadConnection({timeoutMs: 15, maxPending: 1,
    request: (_, options) => { signal = options.signal; return held.promise; }});
  await assert.rejects(connection.readObject(args), {code: 'IMAGE_READ_TIMEOUT'});
  assert.ok(signal.aborted);
  assert.equal(connection.pendingRequests, 1);
  await assert.rejects(connection.readObject(args), {code: 'IMAGE_READ_BUSY'});
  held.reject(new Error('private transport details'));
  await new Promise(setImmediate);
  assert.equal(connection.pendingRequests, 0);
  connection.close();
  await assert.rejects(connection.readObject(args), {name: 'AbortError'});

  const late = deferred();
  const second = createImageReadConnection({request: () => late.promise});
  const pending = second.readObject(args);
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  await new Promise(setImmediate);
  second.close(); second.close();
  late.resolve(response({secret: 'must never be delivered'}));
  await rejected;
  const failure = createImageReadConnection({request() { throw new Error('credential secret'); }});
  await assert.rejects(failure.readObject(args), {message: 'Cannot reach the image read service.'});
  failure.close();
});
