import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createImageClientAdapter} from '../../src/image-client-adapter.js';

let api, loadError;
try {
  api = await import(process.env.LAGRANGE_IMAGES_URL
    ?? new URL('../../../lagrange-images/src/runtime.js', import.meta.url).href);
} catch (error) { loadError = error; }
const IMAGE = 'read-service-a';
const OTHER_IMAGE = 'read-service-b';
const PROJECT = 'integration';
const BLOCK = 'read-object';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}

// Test-only trusted setup: real Images semantics, explicitly mock storage.
// The real-cluster/native acceptance lane must choose mode:'lagrange' separately.
async function fixture() {
  const runtime = await api.createRuntime({backend: {mode: 'mock'}});
  try {
    const adapter = createImageClientAdapter({...api, ...runtime});
    for (const imageId of [IMAGE, OTHER_IMAGE]) {
      await runtime.images.createImage({id: imageId});
      await runtime.images.putShape(imageId, {id: 'shape', indexed: 'values', slots: [
        {id: 'title', name: 'Title'}, {id: 'ref', name: 'Target'},
      ]});
      await runtime.images.putObject(imageId, {id: 'object', shape: api.objectRef(imageId, 'shape'), slots: {
        title: api.textValue(imageId), ref: api.objectRef(OTHER_IMAGE, 'object'),
      }, indexed: [{kind: 'pinned-ref', imageId: OTHER_IMAGE, objectId: 'object', revision: '1'}]});
      await api.createProject({images: runtime.images, imageId, projectId: PROJECT, name: 'Current integration'});
      await api.addProjectMember({images: runtime.images, imageId, projectId: PROJECT,
        key: 'root', role: 'application', target: api.objectRef(imageId, 'object')});
    }
    const types = {
      'slot-value': {kind: 'record', fields: [{name: 'value', type: 'string'}]},
      'slot-entry': {kind: 'record', fields: [{name: 'name', type: 'string'}, {name: 'value', type: 'slot-value'}]},
      'object-record': {kind: 'record', fields: [
        {name: 'slots', type: {kind: 'list', element: 'slot-entry'}},
        {name: 'indexed', type: {kind: 'list', element: 'slot-value'}},
      ]},
      'object-read-result': {kind: 'record', fields: [
        {name: 'version-token', type: 'string'}, {name: 'value', type: 'object-record'},
      ]},
    };
    await api.installCallableInterfaceV2({images: runtime.images, imageId: IMAGE, interfaceId: 'read-interface',
      functionName: 'read', parameters: ['string'], result: 'object-read-result', types});
    await api.installImageObjectReadBinding({images: runtime.images, imageId: IMAGE,
      callableInterface: api.objectRef(IMAGE, 'read-interface'), bindingId: 'read-binding', blockId: BLOCK});
    const issue = (principal, objectIds) => runtime.authority.issue({principal, grants: objectIds.map((id) => ({
      operation: 'object/read', resource: api.objectResource(IMAGE, id),
    }))});
    const contexts = new Map([
      ['alice', issue('alice', [api.projectObjectId(PROJECT), 'object', 'authorized-missing'])],
      ['bob', issue('bob', [api.projectObjectId(PROJECT)])],
      ['denied', issue('denied', [])],
    ]);
    const tokens = new Map([...contexts.keys()].map((identity) => [identity, randomBytes(32).toString('hex')]));
    const config = {adapter, imageId: IMAGE, objectReadBlockId: BLOCK,
      authenticateRequest(request) {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        for (const [identity, token] of tokens) {
          const expected = Buffer.from('Bearer ' + token);
          if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return identity;
        }
        return null;
      },
      authorityForIdentity: (identity) => contexts.get(identity),
    };
    return {runtime, adapter, config, contexts, tokens, issue};
  } catch (error) { await runtime.close(); throw error; }
}

// Transport used by the Node contract proof only. No redirects, bounded body,
// actual socket abort, credentials outside the semantic request/adapter.
function transport(port, token, {signal, raw, path = '/v1/read', tls} = {}) {
  return new Promise((resolve, reject) => {
    const body = raw ?? '';
    const req = (tls ? httpsRequest : httpRequest)({host: '127.0.0.1', port, path, method: 'POST', signal, ...tls,
      headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        ...(token ? {authorization: 'Bearer ' + token} : {})},
    }, (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) res.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export {api, loadError, fixture, transport, deferred, IMAGE, OTHER_IMAGE, PROJECT, BLOCK};
