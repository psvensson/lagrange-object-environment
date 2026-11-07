import assert from 'node:assert/strict';
import test from 'node:test';
import {connect} from 'node:net';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {api, loadError, fixture, transport, deferred, IMAGE, OTHER_IMAGE, PROJECT, BLOCK}
  from './support/image-read-service.js';
import {createImageReadService} from '../hosts/image-read-service/server.js';
import {IMAGE_READ_PROTOCOL as protocol} from '../src/image-read-connection.js';
import {
  createImageReadConnection, createRemoteImageClientAdapter, createImageClientAdapter,
  createProjectBrowser, createProjectSubject, createProjectPresentationProvider,
  createPresentationRegistry, createObjectNavigator, createObjectInspectorProvider,
  createUnavailableRefProvider, createUnauthorizedRefProvider, createCompositor,
  createFakeRendererAdapter, createCommandRegistry,
} from '../src/index.js';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createSelectionModel} from '../src/selection-model.js';
import {semanticUiForPresentation} from '../src/semantic-ui.js';

const read = (operation, id, imageId = IMAGE) => ({protocol, operation, imageId,
  [operation === 'project' ? 'projectId' : 'objectId']: id});
const object = read('object', 'object');
const project = read('project', PROJECT);
const json = (response) => JSON.parse(response.body);
const enabled = {skip: Boolean(loadError), timeout: 15_000};

test('read-service real Images runtime is required in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('HTTPS authenticates through the actual TLS request socket and drains cleanly', enabled, async (t) => {
  const key = await readFile(new URL('./fixtures/image-read-service/localhost-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/image-read-service/localhost-cert.pem', import.meta.url));
  const f = await serving(t, {tls: {key, cert}});
  const call = (body, identity = 'alice') => transport(f.port, f.tokens.get(identity),
    {raw: JSON.stringify(body), tls: {ca: cert}});
  assert.equal((await call(project)).status, 200);
  assert.equal((await call(object, 'bob')).status, 403);
  assert.equal((await call(project, 'unknown')).status, 401);
  await assert.rejects(transport(f.port, f.tokens.get('alice'), {raw: JSON.stringify(project), tls: {}}),
    {code: 'DEPTH_ZERO_SELF_SIGNED_CERT'});
  await f.service.close();
  assert.equal(f.service.pendingResponses, 0);
});

async function serving(t, overrides = {}) {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const service = await createImageReadService({...f.config, ...overrides});
  t.after(() => service.close());
  const {port} = await service.listen();
  const call = (body, identity = 'alice') => transport(port, f.tokens.get(identity), {raw: JSON.stringify(body)});
  return {...f, service, port, call};
}

test('real authority stays server-local: independent member grant, revocation and no writes', enabled, async (t) => {
  const f = await serving(t);
  const before = await f.runtime.images.history(IMAGE, {afterRevision: 0});
  const canonicalProject = await f.adapter.readProject({imageId: IMAGE, projectId: PROJECT, authority: f.contexts.get('alice')});
  const canonicalObject = await f.adapter.readObject({imageId: IMAGE, objectId: 'object', blockId: BLOCK, authority: f.contexts.get('alice')});
  assert.deepEqual(json(await f.call(project)).result, canonicalProject);
  assert.deepEqual(json(await f.call(object)).result, canonicalObject);
  assert.equal((await f.call(project, 'bob')).status, 200);
  assert.equal((await f.call(object, 'bob')).status, 403, 'membership never grants a target read');
  for (const operation of ['project', 'object']) {
    const existing = operation === 'project' ? PROJECT : 'object';
    const denied = await f.call(read(operation, existing), 'denied');
    assert.equal(denied.status, 403);
    assert.deepEqual(await f.call(read(operation, 'missing'), 'denied'), denied,
      'denied existing/missing subjects have identical envelopes');
  }
  assert.equal((await f.call(read('object', 'authorized-missing'))).status, 404);
  for (const identity of ['unknown', undefined]) {
    assert.equal((await transport(f.port, identity, {raw: JSON.stringify(object)})).status, 401);
  }
  for (const extra of [{principal: 'alice'}, {grants: []}, {authority: {}}, {blockId: 'mutate'}, {source: 'eval'}]) {
    assert.equal((await f.call({...object, ...extra})).status, 400);
  }
  assert.equal((await f.call({...object, operation: 'invokeBlock'})).status, 400);
  assert.equal((await f.call(read('object', 'object', OTHER_IMAGE))).status, 400, 'same id in another image is refused');
  f.runtime.authority.revoke(f.contexts.get('alice'));
  assert.equal((await f.call(object)).status, 403, 'old context does not survive revocation');
  assert.deepEqual(await f.runtime.images.history(IMAGE, {afterRevision: 0}), before,
    'serving reads did not provision or advance image history');
});

test('remote ProjectBrowser and shell navigate ordinary refs with readonly capabilities', enabled, async (t) => {
  const f = await serving(t);
  const connection = createImageReadConnection({request: (body, {signal}) =>
    transport(f.port, f.tokens.get('bob'), {signal, raw: JSON.stringify(body)})});
  t.after(() => connection.close());
  const adapter = createRemoteImageClientAdapter({connection});
  const presentationRegistry = createPresentationRegistry();
  for (const provider of [createProjectPresentationProvider(), createObjectInspectorProvider(),
    createUnavailableRefProvider(), createUnauthorizedRefProvider()]) presentationRegistry.register(provider);
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  t.after(() => compositor.destroy());
  const navigator = createObjectNavigator({adapter, presentationRegistry,
    commandRegistry: createCommandRegistry(), referencesOfValue: api.referencesOfValue});
  const shell = createEnvironmentShell({navigator, compositor, selectionModel: createSelectionModel()});
  const browser = createProjectBrowser({adapter, presentationRegistry, compositor});
  await shell.openWorkspace(api.objectRef(IMAGE, 'object'));
  const opened = await browser.open(createProjectSubject({imageId: IMAGE, projectId: PROJECT}));
  assert.equal(opened.presentationDescriptor.parameters.project.name, 'Current integration');
  assert.ok(!JSON.stringify(semanticUiForPresentation(opened.presentationDescriptor)).includes('"editable"'));
  assert.throws(() => browser.follow(), /observation is unavailable/);
  await shell.handleActivateItem({key: 0, viewId: browser.viewId, resolveItem: browser.resolveItem});
  const displayed = () => compositor.liveView(shell.inspectorViewId).presentationDescriptor;
  assert.equal(displayed().kind, 'unauthorized-reference');
  f.contexts.set('bob', f.issue('bob', [api.projectObjectId(PROJECT), 'object']));
  await shell.handleActivateItem({key: 0, viewId: browser.viewId, resolveItem: browser.resolveItem});
  assert.equal(displayed().kind, 'inspector');
  assert.deepEqual(displayed().parameters.fields.title, api.textValue(IMAGE));
  assert.ok(!JSON.stringify(semanticUiForPresentation(displayed())).includes('"editable"'));
  await browser.refresh();
});

test('preflight refuses mutation, arbitrary, lexical, pinned, foreign and missing read bindings', enabled, async (t) => {
  const f = await fixture(); t.after(() => f.runtime.close());
  for (const options of [{authenticateRequest: undefined}, {authorityForIdentity: undefined}]) {
    await assert.rejects(createImageReadService({...f.config, ...options}), /requires trusted/);
  }
  const images = f.runtime.images;
  const readBinding = await images.getCodeArtifact(IMAGE, 'read-binding');
  await images.putCodeArtifact(OTHER_IMAGE, {id: 'read-binding', representation: readBinding.representation,
    content: readBinding.content, dependencies: readBinding.dependencies});
  await images.putLexicalEnvironment(IMAGE, {id: 'env', bindings: {}});
  for (const [id, code, environment] of [
    ['lexical', api.objectRef(IMAGE, 'read-binding'), api.objectRef(IMAGE, 'env')],
    ['foreign', api.objectRef(OTHER_IMAGE, 'read-binding'), null],
    ['arbitrary', api.objectRef(IMAGE, 'read-interface'), null],
  ]) {
    await images.putBlock(IMAGE, {id, code, environment});
    await assert.rejects(createImageReadService({...f.config, objectReadBlockId: id}));
  }
  await assert.rejects(images.putBlock(IMAGE, {id: 'pinned', environment: null,
    code: {kind: 'pinned-ref', imageId: IMAGE, objectId: 'read-binding', revision: '1'}}), /unpinned object ref/,
  'Images itself forbids pinned executable code refs');
  await api.installCallableInterfaceV2({images, imageId: IMAGE, interfaceId: 'mutate-interface',
    functionName: 'mutate', parameters: ['string', 'string', 'edit'], result: 'string',
    types: {edit: {kind: 'record', fields: [{name: 'title', type: 'string'}]}}});
  await api.installImageMutationBinding({images, imageId: IMAGE, blockId: 'mutate', bindingId: 'mutate-binding',
    callableInterface: api.objectRef(IMAGE, 'mutate-interface'), fields: [{name: 'title', slot: 'title'}]});
  await assert.rejects(createImageReadService({...f.config, objectReadBlockId: 'mutate'}), /image-object-read-binding/);
  await assert.rejects(createImageReadService({...f.config, objectReadBlockId: 'missing'}));
  const adapter = createImageClientAdapter({...api, ...f.runtime, parseImageObjectReadBindingArtifact: undefined});
  await assert.rejects(createImageReadService({...f.config, adapter}), /public Images helper/);
  const service = await createImageReadService(f.config); t.after(() => service.close());
  await assert.rejects(service.listen({host: '0.0.0.0'}), /configure TLS/);
  await assert.rejects(service.listen({host: 'localhost'}), /IP address/);
});

// Minimal byte parser for two ordered HTTP responses on ONE pipelined socket.
// Node's normal Agent queues these serially, which cannot prove overlap.
function pipelined(port, requests) {
  const socket = connect({host: '127.0.0.1', port});
  const responses = []; let buffered = Buffer.alloc(0);
  const done = new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const at = buffered.indexOf('\r\n\r\n');
        if (at < 0) break;
        const header = buffered.subarray(0, at).toString();
        const length = Number(/content-length: (\d+)/i.exec(header)?.[1]);
        if (!Number.isSafeInteger(length)) { reject(new Error('No bounded response')); return; }
        if (buffered.length < at + 4 + length) break;
        responses.push({status: Number(header.split(' ')[1]), body: buffered.subarray(at + 4, at + 4 + length).toString()});
        buffered = buffered.subarray(at + 4 + length);
        if (responses.length === requests.length) { socket.destroy(); resolve(responses); return; }
      }
    });
    socket.once('connect', () => {
      for (const {token, body} of requests) {
        const bytes = JSON.stringify(body);
        socket.write('POST /v1/read HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer '
          + token + '\r\nContent-Length: ' + Buffer.byteLength(bytes) + '\r\n\r\n' + bytes);
      }
    });
  });
  return {socket, done};
}

test('overlapping principals on one TCP connection never share ambient authority', enabled, async (t) => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const held = deferred(), entered = deferred();
  const adapter = {...f.adapter, async bindObjectRead(args) {
    const reader = await f.adapter.bindObjectRead(args);
    return {read: async (options) => {
      if (options.authority === f.contexts.get('alice')) await held.promise;
      else entered.resolve();
      return reader.read(options);
    }};
  }};
  const service = await createImageReadService({...f.config, adapter});
  t.after(() => service.close());
  const {port} = await service.listen();
  const pipe = pipelined(port, ['alice', 'bob'].map((identity) => ({token: f.tokens.get(identity), body: object})));
  t.after(() => pipe.socket.destroy());
  try {
    await entered.promise;
    assert.equal(service.pendingOperations, 2, 'the second principal entered while the first read was held');
  } finally { held.resolve(); }
  const [alice, bob] = await pipe.done;
  assert.equal(alice.status, 200); assert.equal(bob.status, 403);
  assert.equal(json(alice).result.slots.title.value, IMAGE);
});

test('malformed, oversized, stalled and operational failures have safe bounded responses', enabled, async (t) => {
  const f = await serving(t, {operationTimeoutMs: 50});
  for (const raw of ['{', ' '.repeat(16 * 1024 + 1), JSON.stringify({...object, objectId: ''})]) {
    assert.equal((await transport(f.port, f.tokens.get('alice'), {raw})).status, 400);
  }
  assert.equal((await transport(f.port, f.tokens.get('alice'), {path: '/invoke', raw: '{}'})).status, 400);
  const socket = connect({host: '127.0.0.1', port: f.port}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('POST /v1/read HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{');
  const [chunk] = await once(socket, 'data');
  assert.match(chunk.toString(), /504 Gateway Timeout/);
  socket.destroy();
  const bad = await createImageReadService({...f.config,
    authorityForIdentity() { throw new Error('secret authority provider details'); }});
  t.after(() => bad.close());
  const {port} = await bad.listen();
  const failure = await transport(port, f.tokens.get('alice'), {raw: JSON.stringify(object)});
  assert.deepEqual(json(failure), {protocol, ok: false, error: 'FAILED'});
});

test('disconnect and timeout retain actual work capacity; bounded drain reports incomplete work', enabled, async (t) => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const held = deferred(), entered = deferred();
  const service = await createImageReadService({...f.config, maxPending: 1, operationTimeoutMs: 50, drainTimeoutMs: 25,
    authenticateRequest: async (...args) => { entered.resolve(); await held.promise; return f.config.authenticateRequest(...args); }});
  const {port} = await service.listen();
  const controller = new AbortController();
  const pending = transport(port, f.tokens.get('alice'), {signal: controller.signal, raw: JSON.stringify(object)});
  const refused = assert.rejects(pending, {name: 'AbortError'});
  await entered.promise; controller.abort(); await refused;
  assert.equal(service.pendingOperations, 1);
  assert.equal((await transport(port, f.tokens.get('alice'), {raw: JSON.stringify(object)})).status, 503);
  const start = performance.now();
  await assert.rejects(service.close(), {name: 'ImageReadServiceDrainError'});
  assert.ok(performance.now() - start < 1000, 'close cannot wait forever on uncancellable work');
  held.reject(new Error('late private failure'));
  await new Promise(setImmediate);
  assert.equal(service.pendingOperations, 0);

  const heldAuthority = deferred();
  const second = await createImageReadService({...f.config, operationTimeoutMs: 25, maxPending: 1,
    authorityForIdentity: () => heldAuthority.promise});
  const address = await second.listen();
  try {
    const reply = await transport(address.port, f.tokens.get('alice'), {raw: JSON.stringify(object)});
    assert.equal(reply.status, 504, 'deadline includes authority lookup');
    assert.equal(second.pendingOperations, 1);
    heldAuthority.resolve(f.contexts.get('alice'));
    await new Promise(setImmediate);
    assert.equal(second.pendingOperations, 0);
  } finally { heldAuthority.resolve(null); await second.close(); }
});

test('a client that stops reading cannot retain a response socket indefinitely', enabled, async (t) => {
  const f = await serving(t, {responseTimeoutMs: 40});
  await api.createProject({images: f.runtime.images, imageId: IMAGE, projectId: 'large',
    name: 'x'.repeat(4 * 1024 * 1024 - 8192)});
  f.contexts.set('alice', f.issue('alice', [api.projectObjectId(PROJECT), api.projectObjectId('large')]));
  const socket = connect({host: '127.0.0.1', port: f.port});
  t.after(() => socket.destroy());
  let received = Buffer.alloc(0);
  const firstChunk = deferred();
  let paused = false;
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (!paused) { paused = true; socket.pause(); firstChunk.resolve(); }
  });
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await once(socket, 'connect');
  const body = JSON.stringify(read('project', 'large'));
  for (let i = 0; i < 4; i += 1) socket.write('POST /v1/read HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer '
    + f.tokens.get('alice') + '\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  // Pipeline enough bounded responses to exceed loopback kernel buffers, then
  // stop reading after the first chunk. A single response can fit in those
  // buffers and emit finish even while the peer is paused.
  await firstChunk.promise;
  await new Promise((resolve) => setTimeout(resolve, 250));
  socket.resume();
  await closed;
  const split = received.indexOf('\r\n\r\n');
  assert.ok(split > 0, 'the authorized response actually started');
  assert.match(received.subarray(0, split).toString(), /^HTTP\/1.1 200 /);
  let complete = 0, offset = 0;
  while (offset < received.length) {
    const at = received.indexOf('\r\n\r\n', offset);
    if (at < 0) break;
    const declared = Number(/content-length: (\d+)/i.exec(received.subarray(offset, at).toString())[1]);
    if (received.length < at + 4 + declared) break;
    complete += 1; offset = at + 4 + declared;
  }
  assert.ok(complete < 4, 'deadline destroyed the backpressured output before all replies completed');
  assert.equal((await f.call(project)).status, 200, 'other clients can still read');
  await f.service.close();
  assert.equal(f.service.pendingResponses, 0, 'queued delivery obligations settled on TCP close');
});

test('TCP disconnect aborts a queued pipeline stage before it can start an Images read', enabled, async (t) => {
  const f = await fixture(); t.after(() => f.runtime.close());
  const firstRead = deferred(), releaseRead = deferred(), authorityEntered = deferred();
  const releaseAuthority = deferred(), authorityAborted = deferred();
  let readCalls = 0;
  const adapter = {...f.adapter, async bindObjectRead(args) {
    const reader = await f.adapter.bindObjectRead(args);
    return {read: async (options) => {
      readCalls += 1; firstRead.resolve();
      await releaseRead.promise;
      return reader.read(options);
    }};
  }};
  const service = await createImageReadService({...f.config, adapter,
    authorityForIdentity: async (identity, {signal}) => {
      if (identity === 'bob') {
        signal.addEventListener('abort', authorityAborted.resolve, {once: true});
        authorityEntered.resolve();
        await releaseAuthority.promise;
      }
      return f.contexts.get(identity);
    }});
  t.after(() => service.close());
  const {port} = await service.listen();
  const pipe = pipelined(port, ['alice', 'bob'].map((identity) => ({token: f.tokens.get(identity), body: object})));
  pipe.done.catch(() => {});
  t.after(() => pipe.socket.destroy());
  let ceiling;
  try {
    await Promise.all([firstRead.promise, authorityEntered.promise]);
    pipe.socket.destroy();
    await Promise.race([authorityAborted.promise, new Promise((_, reject) => {
      ceiling = setTimeout(() => reject(new Error('queued authority did not see TCP disconnect')), 1000);
    })]);
  } finally {
    clearTimeout(ceiling);
    releaseRead.resolve(); releaseAuthority.resolve();
  }
  await new Promise(setImmediate);
  assert.equal(readCalls, 1, 'a disconnected queued request must not start the next stage');
  assert.equal(service.pendingOperations, 0);
  await service.close();
  assert.equal(service.pendingResponses, 0);
});
