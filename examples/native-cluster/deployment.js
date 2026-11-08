// Trusted DEVELOPMENT composition, launched separately from the desktop.
// This installs a new isolated graph; it is not production identity policy.
import assert from 'node:assert/strict';
import {readFile, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {createImageClientAdapter} from '../../src/image-client-adapter.js';

export const IMAGE = 'native-cluster-demo';
export const PROJECT = 'integration';
export const BLOCK = 'read-object';
export const IMAGES_REVISION = 'caf72f26d6a28a6901aea876a49d22311e29cf21';
export const LAGRANGE_REVISION = '07206ba1c8bb396f4eb097a753915bb34580d824';

async function credential(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new TypeError('A bounded private credential file is required');
    }
    const buffer = Buffer.alloc(4097);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > 4096 || !/^[a-f0-9]{64}$/.test(token)) throw new TypeError('Invalid development credential');
    return Buffer.from('Bearer ' + token);
  } finally { await file.close(); }
}

export async function createDevelopmentDeployment(config, {stage = () => {}, lagrangeRuntime = null, cleanupFailure = () => {}} = {}) {
  const expected = await credential(config.credentialFile);
  const pkg = JSON.parse(await readFile(new URL(import.meta.resolve('lagrange-server/package.json')), 'utf8'));
  assert.equal(pkg.version, '0.4.0');
  assert.equal(pkg.gitHead, LAGRANGE_REVISION);
  const api = await import(config.imagesRuntime);
  const ports = [config.restPort, config.adminPort, config.transportPort];
  assert(ports.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535));
  assert.equal(new Set(ports).size, 3);
  stage('runtime-start');
  // A local demo worker may transfer its already-started seed into the public
  // Images backend. That backend owns closure; the worker retains a raw-handle
  // safety net for failures before a deployment can be returned.
  const runtime = await api.createRuntime({backend: lagrangeRuntime
    ? {instance: new api.LagrangeBackend({runtime: lagrangeRuntime})}
    : {
    mode: 'lagrange', lagrangeSpecifier: import.meta.resolve('lagrange-server'),
    configuration: {
      logging: {level: 'error', prettyPrint: false},
      node: {id: '550e8400-e29b-41d4-a716-446655440036', restApiPort: config.restPort, wsPort: config.transportPort},
      admin: {websocketPort: config.adminPort},
      messageGroup: {replicaCount: 3}, partition: {defaultReplicaCount: 3},
      storage: {dataDir: config.dataDir}, worker: {maxThreads: 2, minThreads: 2},
    },
  }});
  try {
    assert.equal(runtime.backend.kind, 'lagrange');
    assert.equal(runtime.backend.durable, true);
    stage('image-create');
    await runtime.images.createImage({id: IMAGE});
    stage('graph-install');
    await runtime.images.putShape(IMAGE, {id: 'shape', slots: [
      {id: 'title', name: 'Title'}, {id: 'target', name: 'Target'},
    ]});
    for (const [id, title, target] of [
      ['root', 'Cluster root ' + config.nonce, api.objectRef(IMAGE, 'target')],
      ['target', 'Cluster target ' + config.nonce, api.objectRef(IMAGE, 'denied')],
      ['denied', 'Restricted ' + config.nonce, api.objectRef(IMAGE, 'root')],
    ]) {
      await runtime.images.putObject(IMAGE, {id, shape: api.objectRef(IMAGE, 'shape'),
        slots: {title: api.textValue(title), target}});
    }
    await api.createProject({images: runtime.images, imageId: IMAGE, projectId: PROJECT,
      name: 'Native cluster integration ' + config.nonce});
    for (const key of ['root', 'denied']) await api.addProjectMember({images: runtime.images,
      imageId: IMAGE, projectId: PROJECT, key, role: 'application', target: api.objectRef(IMAGE, key)});
    stage('binding-install');
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
    const authority = runtime.authority.issue({principal: 'development-operator',
      grants: [api.projectObjectId(PROJECT), 'root', 'target'].map((id) => ({
        operation: 'object/read', resource: api.objectResource(IMAGE, id),
      }))});
    const adapter = createImageClientAdapter({...api, ...runtime});
    const snapshot = async () => ({
      descriptor: await api.readProjectDescriptor({images: runtime.images, imageId: IMAGE, projectId: PROJECT}),
      project: await runtime.images.getObject(IMAGE, api.projectObjectId(PROJECT)),
      root: await runtime.images.getObject(IMAGE, 'root'),
      target: await runtime.images.getObject(IMAGE, 'target'),
      history: await runtime.images.history(IMAGE),
    });
    return {
      service: {adapter, imageId: IMAGE, objectReadBlockId: BLOCK,
        authenticateRequest(request) {
          const supplied = Buffer.from(request.headers.authorization ?? '');
          return supplied.length === expected.length && timingSafeEqual(supplied, expected)
            ? 'development-operator' : null;
        },
        authorityForIdentity: (identity) => identity === 'development-operator' ? authority : null,
      },
      provenance: {backend: runtime.backend.kind, durable: runtime.backend.durable,
        lagrangeVersion: pkg.version, lagrangeRevision: pkg.gitHead, expectedImagesRevision: IMAGES_REVISION},
      snapshot,
      // Trusted in-process test seam only; never exposed over HTTP.
      revoke: () => runtime.authority.revoke(authority),
      close: () => runtime.close(),
    };
  } catch (error) {
    try { await runtime.close(); } catch (cleanupError) {
      // The worker may retain secondary cleanup evidence; never replace the
      // original semantic failure or alter the default deployment contract.
      try { cleanupFailure(cleanupError); } catch { /* Recorder is sideband. */ }
    }
    throw error;
  }
}

export async function createDeployment() {
  if (!process.env.OE_CLUSTER_CONFIG) throw new TypeError('OE_CLUSTER_CONFIG is required');
  return createDevelopmentDeployment(JSON.parse(await readFile(process.env.OE_CLUSTER_CONFIG, 'utf8')));
}
