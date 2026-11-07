import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Session} from '../../src/model.js';
import {createImageClientAdapter} from '../../src/image-client-adapter.js';
import {createFakeRendererAdapter} from '../../src/fake-renderer-adapter.js';
import {semanticUiForPresentation} from '../../src/semantic-ui.js';
import {createSqliteApplicationRuntime} from './sqlite-application-runtime.js';
import {api, loadError, IMAGE, PROJECT, MEMBER, prepare, openEnvironment, findEditableObject}
  from './yaxo-environment.js';

assert.ifError(loadError);
const [phase, filename, encodedLocator, ...extra] = process.argv.slice(2);
assert.ok(phase === 'create' || phase === 'recover', 'unknown restart phase');
assert.ok(filename && filename !== ':memory:', 'restart needs a file-backed database');
assert.equal(extra.length, 0);
const locator = JSON.parse(encodedLocator);
assert.deepEqual(Object.keys(locator).sort(), ['imageId', 'memberKey', 'projectId']);
for (const value of Object.values(locator)) assert.ok(typeof value === 'string' && value.length > 0);

async function scanGraph(environment) {
  const queue = [[]];
  const seen = new Map();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    assert.ok(queue.length < 100);
    await environment.activateRoot();
    for (const index of queue[cursor]) await environment.activateReference(index);
    const shown = environment.descriptor();
    const key = JSON.stringify(shown.subject);
    if (seen.has(key)) continue;
    seen.set(key, {subject: shown.subject, fields: shown.parameters.fields,
      references: shown.parameters.references});
    for (let index = 0; index < shown.parameters.references.length; index += 1) {
      queue.push([...queue[cursor], index]);
    }
  }
  assert.ok(seen.size >= 5, 'recover a domain graph, not just its root');
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

const database = createSqliteApplicationRuntime(filename);
const runtime = await api.createRuntime({
  backend: {instance: new api.LagrangeBackend({runtime: database})},
  wasmModuleCache: new api.WasmModuleCache(), wasmInstancePool: new api.WasmInstancePool(),
});
const session = new Session({principal: 'restart-user', state: {resourceScope: randomUUID()}});
const renderer = createFakeRendererAdapter({projector: semanticUiForPresentation,
  mintHandle: (ordinal) => `${session.get('resourceScope')}:${ordinal}`});
let environment, report;
try {
  assert.deepEqual(runtime.toolchainProviders.list(), []);
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  if (phase === 'create') {
    assert.deepEqual(locator, {imageId: IMAGE, projectId: PROJECT, memberKey: MEMBER});
    await prepare(runtime, {editing: true});
  }
  const initialFrontier = await runtime.images.frontier(locator.imageId);
  const adapter = createImageClientAdapter({...api, ...runtime});
  let provisioningAttempts = 0;
  const recoveryAdapter = {...adapter, ensureSchema() {
    provisioningAttempts += 1;
    throw new Error('recovery cannot provision application schema');
  }};
  if (phase === 'recover') {
    // Counterexample: an idempotent ensureSchema would otherwise leave no
    // history evidence. Refuse the attempt itself, before reaching Images.
    await assert.rejects(openEnvironment(runtime, {
      editing: true, locator, provision: true, adapter: recoveryAdapter,
    }), /recovery cannot provision/);
    assert.equal(provisioningAttempts, 1);
    for (const wrong of [
      {...locator, projectId: 'nonexistent-project'},
      {...locator, memberKey: 'nonexistent-member'},
    ]) {
      const failedRenderer = createFakeRendererAdapter({projector: semanticUiForPresentation});
      await assert.rejects(openEnvironment(runtime, {editing: true, provision: false,
        locator: wrong, adapter: recoveryAdapter, renderer: failedRenderer}));
      assert.equal(failedRenderer.liveResourceCount(), 0, 'failed locator releases admitted views');
    }
    const noGrants = runtime.authority.issue({principal: 'restart-user', grants: []});
    await assert.rejects(adapter.readProject({imageId: locator.imageId, projectId: locator.projectId,
      authority: noGrants}), {name: 'AuthorityError'});
  }
  environment = await openEnvironment(runtime, {editing: true, locator, renderer,
    provision: phase === 'create', adapter: phase === 'create' ? adapter : recoveryAdapter});
  if (phase === 'recover') assert.equal(provisioningAttempts, 1, 'actual recovery attempts no provisioning');
  const e = environment;
  let denied = await e.activateRoot(e.projectAuthority);
  assert.equal(denied.kind, 'unauthorized-reference');
  assert.equal(denied.parameters.fields, undefined);
  assert.equal(denied.parameters.references, undefined);
  await e.activateRoot();
  const references = e.descriptor().parameters.references;
  assert.ok(references.length > 0);
  denied = await e.activateReference(0, e.grantFor(e.rootRef));
  assert.equal(denied.kind, 'unauthorized-reference', 'root authority does not grant a descendant');
  assert.equal(denied.parameters.fields, undefined);
  assert.equal(denied.parameters.references, undefined);

  const initialGraph = await scanGraph(e);
  const {subject} = await findEditableObject(e);
  const slot = e.mutation.writableSlots[0];
  const beforeText = e.descriptor().parameters.fields[slot].value;
  assert.equal(beforeText, phase === 'create' ? 'Tove' : 'Persisted text');
  const nativeText = async () => runtime.executor.execute(await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk', receiver: subject, message: api.textValue('string'), arguments: [],
  }, {dispatchImage: locator.imageId}));
  assert.deepEqual(await nativeText(), api.textValue(beforeText));
  if (phase === 'recover') assert.equal(await runtime.images.frontier(locator.imageId), initialFrontier,
    'opening, authority negatives, discovery and reads change no image state');
  const nextText = phase === 'create' ? 'Persisted text' : 'Continued text';
  assert.ok((await e.edit(nextText)).receipt);
  assert.equal(e.descriptor().parameters.fields[slot].value, nextText);
  assert.deepEqual(await nativeText(), api.textValue(nextText));
  const finalGraph = await scanGraph(e);
  assert.deepEqual(finalGraph.map(({subject, references}) => ({subject, references})),
    initialGraph.map(({subject, references}) => ({subject, references})), 'continued edit keeps graph identity/topology');
  assert.deepEqual(e.attemptedReads, e.expectedAttempts);
  const handles = renderer.liveHandles();
  assert.ok(handles.length > 0);
  assert.ok(renderer.liveResourceCount() > 0);
  report = {phase, pid: process.pid, resourceScope: session.get('resourceScope'),
    handles, liveResources: renderer.liveResourceCount(), root: e.rootRef, textRef: subject,
    beforeText, afterText: nextText, initialGraph, finalGraph, initialFrontier,
    finalFrontier: await runtime.images.frontier(locator.imageId), provisioningAttempts};
} finally {
  try {
    if (environment) await environment.compositor.destroy();
    assert.equal(renderer.liveResourceCount(), 0, 'session releases every host resource');
  } finally {
    await runtime.close();
    assert.throws(() => database.listTables(), /runtime is not started/);
    await assert.rejects(runtime.images.getObject(locator.imageId, 'after-close'));
  }
}
// Emitted only after every teardown proof; the parent still requires exit 0.
process.stdout.write(JSON.stringify({...report, resourcesAfterClose: renderer.liveResourceCount(), closed: true}));
