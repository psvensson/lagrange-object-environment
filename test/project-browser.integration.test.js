import assert from 'node:assert/strict';
import test from 'node:test';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  classIdFor,
  createCompositor,
  createFakeRendererAdapter,
  createImageClientAdapter,
  createObjectInspectorProvider,
  createObjectNavigator,
  createPresentationRegistry,
  createProjectBrowser,
  createProjectPresentationProvider,
  createProjectSubject,
  createUnavailableRefProvider,
  createUnauthorizedRefProvider,
} from '../src/index.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {createCommandRouter} from '../src/command-router.js';
import {Command} from '../src/model.js';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createSelectionModel} from '../src/selection-model.js';
import {semanticUiForPresentation} from '../src/semantic-ui.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(HERE, '../../lagrange-images/src/runtime.js');
const RUNTIME_URL = process.env.LAGRANGE_IMAGES_URL ?? pathToFileURL(DEFAULT_RUNTIME).href;

let imagesApi = null;
try {
  imagesApi = await import(RUNTIME_URL);
} catch {
  imagesApi = null;
}
const available = imagesApi !== null && typeof imagesApi.createRuntime === 'function';

const IMAGE_A = 'project-browser-a';
const IMAGE_B = 'project-browser-b';
const PROJECT_ID = 'durable-project';
const IDS = Object.freeze({
  shapeId: 'probe-shape',
  className: 'Probe',
  interfaceId: 'probe-create-interface',
  bindingId: 'probe-create-binding',
  blockId: 'probe-create-block',
  mutationInterfaceId: 'probe-mutate-interface',
  mutationBindingId: 'probe-mutate-binding',
  mutationBlockId: 'probe-mutate-block',
  readInterfaceId: 'object-read-interface',
  readBindingId: 'object-read-binding',
  readBlockId: 'object-read-block',
  observationInterfaceId: 'observation-interface',
  observationBindingId: 'observation-binding',
  observationBlockId: 'observation-block',
});

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function adapterClients(runtime) {
  return {
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    authority: runtime.authority,
    defineClass: imagesApi.defineClass,
    installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    installImageMutationBinding: imagesApi.installImageMutationBinding,
    installImageObjectReadBinding: imagesApi.installImageObjectReadBinding,
    installImageObservationBinding: imagesApi.installImageObservationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    unpackCompositeValue: imagesApi.unpackCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
    authorizedReadProject: imagesApi.authorizedReadProject,
    authorizedRenameProject: imagesApi.authorizedRenameProject,
    authorizedDescribeSmalltalkClass: imagesApi.authorizedDescribeSmalltalkClass,
  };
}

test('real durable Project browse -> canonical members -> separately-authorized navigation -> refresh/follow', {
  skip: !available && 'lagrange-images sibling runtime not available',
}, async () => {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  for (const imageId of [IMAGE_A, IMAGE_B]) {
    await runtime.images.createImage({id: imageId});
    await imagesApi.installSmalltalkKernel({images: runtime.images, imageId});
  }
  const adapter = createImageClientAdapter(adapterClients(runtime));
  for (const imageId of [IMAGE_A, IMAGE_B]) await adapter.ensureSchema(imageId, IDS);

  const classId = classIdFor(IDS.className);
  const ref = (imageId, objectId) => ({kind: 'ref', imageId, objectId});
  const issue = (grants) => runtime.authority.issue({principal: 'alice', grants});
  const readAuthority = (imageId, objectId) => issue([
    {operation: 'object/read', resource: imagesApi.objectResource(imageId, objectId)},
  ]);
  const createAuthority = (imageId) => issue([
    {operation: 'object/create', resource: imagesApi.objectResource(imageId, classId)},
    {operation: 'object/edge-write', resource: imagesApi.objectResource(imageId, 'smalltalk/nil')},
  ]);
  const createTarget = (imageId, title) => adapter.createObject({
    imageId,
    classId,
    title,
    subject: ref(imageId, 'smalltalk/nil'),
    authority: createAuthority(imageId),
    blockId: IDS.blockId,
  });

  const local = await createTarget(IMAGE_A, 'Local source');
  const cross = await createTarget(IMAGE_B, 'Cross target');
  const retarget = await createTarget(IMAGE_B, 'Retargeted cross target');

  // Setup uses Images' public Project writes. Deliberately insert z before a;
  // only the canonical Images descriptor may decide presentation order.
  await imagesApi.createProject({
    images: runtime.images, imageId: IMAGE_A, projectId: PROJECT_ID, name: 'Durable Project',
  });
  await imagesApi.addProjectMember({
    images: runtime.images, imageId: IMAGE_A, projectId: PROJECT_ID,
    key: 'z-cross', role: 'dependency', target: ref(IMAGE_B, cross.objectId),
  });
  await imagesApi.addProjectMember({
    images: runtime.images, imageId: IMAGE_A, projectId: PROJECT_ID,
    key: 'a-local', role: 'source', target: ref(IMAGE_A, local.objectId),
  });

  const projectAuthority = readAuthority(IMAGE_A, imagesApi.projectObjectId(PROJECT_ID));
  let projectReads = 0;
  const browserAdapter = {
    ...adapter,
    async readProject(options) {
      projectReads += 1;
      return adapter.readProject(options);
    },
  };
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createProjectPresentationProvider());
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  const navigator = createObjectNavigator({
    adapter,
    presentationRegistry,
    commandRegistry,
    referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const rendererAdapter = createFakeRendererAdapter();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor});
  const browser = createProjectBrowser({
    adapter: browserAdapter, presentationRegistry, compositor,
  });
  let follow = null;

  try {
    // The inspector must already exist; Project member selection drives the
    // ordinary selection -> ObjectNavigator -> inspector path.
    await shell.openWorkspace(ref(IMAGE_A, local.objectId), {
      authority: readAuthority(IMAGE_A, local.objectId), readBlockId: IDS.readBlockId,
    });
    const opened = await browser.open(createProjectSubject({imageId: IMAGE_A, projectId: PROJECT_ID}), {
      authority: projectAuthority,
    });
    const canonical = opened.presentationDescriptor.parameters.project;
    assert.deepEqual(canonical.members.map(({key}) => key), ['a-local', 'z-cross'],
      'Project member order comes from the canonical descriptor, not storage insertion order');
    assert.deepEqual(canonical.members.map(({role}) => role), ['source', 'dependency']);
    assert.deepEqual(canonical.members.map(({target}) => target), [
      ref(IMAGE_A, local.objectId), ref(IMAGE_B, cross.objectId),
    ]);

    const semantic = semanticUiForPresentation(opened.presentationDescriptor);
    const memberActions = semantic.root.children.find(({kind}) => kind === 'collection').items;
    assert.deepEqual(memberActions.map(({key}) => key), [0, 1]);
    for (const text of ['z-cross', 'dependency', IMAGE_B, cross.objectId]) {
      assert.ok(memberActions[1].label.includes(text), `member label exposes ${text}`);
    }
    assert.ok(memberActions.every((action) => (
      !('target' in action) && !('ref' in action) && !('subject' in action)
    )),
      'the visible member action carries no authority-bearing or semantic ref payload');

    // A Project grant authorizes the descriptor only. The member target remains
    // visible but unreadable and uses ObjectNavigator's existing unauthorized
    // presentation rather than receiving any membership-derived grant.
    await shell.handleActivateItem({
      key: 1,
      viewId: browser.viewId,
      resolveItem: browser.resolveItem,
      authority: projectAuthority,
      readBlockId: IDS.readBlockId,
    });
    let inspector = compositor.durableIntent().find(({viewId}) => viewId === shell.inspectorViewId);
    assert.equal(inspector.presentationDescriptor.kind, 'unauthorized-reference');
    assert.equal(inspector.presentationDescriptor.subject.kind, 'unauthorized-ref');
    assert.equal(inspector.presentationDescriptor.subject.imageId, IMAGE_B);
    assert.equal(inspector.presentationDescriptor.subject.objectId, cross.objectId,
      'unauthorized materialization preserves the exact denied cross-Image identity');
    assert.equal(typeof inspector.presentationDescriptor.subject.reason, 'string');

    // The exact same visible member succeeds only with an explicit target grant;
    // its cross-Image ref traverses the generic navigation path unchanged.
    await shell.handleActivateItem({
      key: 1,
      viewId: browser.viewId,
      resolveItem: browser.resolveItem,
      authority: readAuthority(IMAGE_B, cross.objectId),
      readBlockId: IDS.readBlockId,
    });
    inspector = compositor.durableIntent().find(({viewId}) => viewId === shell.inspectorViewId);
    assert.equal(inspector.presentationDescriptor.kind, 'inspector');
    assert.equal(inspector.presentationDescriptor.subject.imageId, IMAGE_B);
    assert.equal(inspector.presentationDescriptor.parameters.fields['probe-title'].value, 'Cross target');
    assert.equal(compositor.focusedView(), browser.viewId);

    // Retarget the same durable member key. This does not change the Project
    // root, so explicit refresh is the intended read-only synchronization path.
    await imagesApi.addProjectMember({
      images: runtime.images, imageId: IMAGE_A, projectId: PROJECT_ID,
      key: 'z-cross', role: 'dependency', target: ref(IMAGE_B, retarget.objectId),
    });
    const refreshed = await browser.refresh({authority: projectAuthority});
    const stableMember = refreshed.presentationDescriptor.parameters.project.members[1];
    assert.equal(stableMember.key, 'z-cross', 'retarget preserves the durable member identity');
    assert.deepEqual(stableMember.target, ref(IMAGE_B, retarget.objectId));
    await shell.handleActivateItem({
      key: 1,
      viewId: browser.viewId,
      resolveItem: browser.resolveItem,
      authority: readAuthority(IMAGE_B, retarget.objectId),
      readBlockId: IDS.readBlockId,
    });
    inspector = compositor.durableIntent().find(({viewId}) => viewId === shell.inspectorViewId);
    assert.equal(inspector.presentationDescriptor.parameters.fields['probe-title'].value,
      'Retargeted cross target', 'activation resolves against the refreshed current descriptor');

    // Anchor the authorized metadata-only feed before the write so the proof is
    // deterministic. Adding a member changes the readable Project root; follow
    // must respond by calling readProject again, never by consuming hidden data.
    const anchor = await adapter.observePull({
      imageId: IMAGE_A,
      afterCursor: '',
      authority: projectAuthority,
      blockId: IDS.observationBlockId,
    });
    const observed = deferred();
    const readsBeforeFollow = projectReads;
    follow = browser.follow({
      authority: projectAuthority,
      observationBlockId: IDS.observationBlockId,
      afterCursor: anchor.cursor,
      intervalMs: 0,
      onUpdate(descriptor) {
        if (descriptor.parameters.project.members.some(({key}) => key === 'm-added')) {
          observed.resolve(descriptor);
        }
      },
      onError: observed.reject,
    });
    await imagesApi.addProjectMember({
      images: runtime.images, imageId: IMAGE_A, projectId: PROJECT_ID,
      key: 'm-added', role: 'test', target: ref(IMAGE_A, local.objectId),
    });
    const observedDescriptor = await within(observed.promise, 3000, 'Project observation reread');
    assert.ok(projectReads > readsBeforeFollow, 'observation caused a fresh authorized Project read');
    assert.deepEqual(observedDescriptor.parameters.project.members.map(({key}) => key),
      ['a-local', 'm-added', 'z-cross']);
  } finally {
    follow?.stop();
    if (follow) await follow.done.catch(() => {});
    try {
      await compositor.destroy();
    } finally {
      await runtime.close();
    }
  }
});


// ---------------------------------------------------------------------------
// okv Slice C: the first real Project rename vertical against REAL Images.
// One durable Project, one editable field (name), one Images-owned CAS, one
// ordinary Environment Command path, one fresh authoritative reread.
// ---------------------------------------------------------------------------

test('first Project rename vertical: ordinary edit-field -> view-keyed edit binding -> rename-project Command -> adapter.renameProject -> Images CAS -> ProjectBrowser reread; negatives; token scope; write-token promotion; follow race', {
  skip: !available && 'lagrange-images sibling runtime not available',
}, async () => {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE_A});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE_A});
  const adapter = createImageClientAdapter(adapterClients(runtime));
  await adapter.ensureSchema(IMAGE_A, IDS);
  const PROJECT = 'renamable-project';
  await imagesApi.createProject({images: runtime.images, imageId: IMAGE_A, projectId: PROJECT, name: 'Old'});
  await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE_A, projectId: PROJECT, key: 'm', role: 'source', target: {kind: 'ref', imageId: IMAGE_A, objectId: 'target-1'}});
  const projectResource = imagesApi.objectResource(IMAGE_A, imagesApi.projectObjectId(PROJECT));
  // A second, UNRELATED but readable Project in the same image: the observation
  // feed is authority-filtered per object (a write the reader may not read is
  // invisible), so the race proof's 'unrelated write' must be one this reader
  // can see, which is exactly what makes the follow's reread UNFILTERED (7c8).
  const UNRELATED = 'unrelated-project';
  await imagesApi.createProject({images: runtime.images, imageId: IMAGE_A, projectId: UNRELATED, name: 'U'});
  const unrelatedResource = imagesApi.objectResource(IMAGE_A, imagesApi.projectObjectId(UNRELATED));
  const issue = (grants) => runtime.authority.issue({principal: 'alice', grants});
  const readAuthority = () => issue([
    {operation: 'object/read', resource: projectResource},
    {operation: 'object/read', resource: unrelatedResource},
  ]);
  const writeAuthority = () => issue([{operation: 'object/write', resource: projectResource}]);
  const subject = createProjectSubject({imageId: IMAGE_A, projectId: PROJECT});
  const ref = (imageId, objectId) => ({kind: 'ref', imageId, objectId});

  let projectReads = 0;
  const browserAdapter = {...adapter, async readProject(options) { projectReads += 1; return adapter.readProject(options); }};
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createProjectPresentationProvider());
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  // THE ORDINARY COMMAND (composition-registered, never in src/): applicable to
  // the Project subject; consumes only semantic context; edits `name` and nothing
  // else; calls the adapter's Images-owned rename. A gate (for the race + the
  // write-token proofs) holds the Command open AFTER the CAS committed.
  const commandRegistry = createCommandRegistry();
  let gate = null;       // when set: hold the Command open AFTER its CAS committed
  let committed = null;  // resolved the instant the CAS committed (a causal seam, no timing)
  commandRegistry.register(new Command({
    id: 'rename-project',
    title: 'Rename Project',
    appliesTo: (s) => s?.kind === 'project',
    invoke: async (s, {authority, adapter: a, text, versionToken, field}) => {
      if (field?.field !== 'name') throw new TypeError(`rename-project edits the Project name only, got ${JSON.stringify(field)}`);
      const result = await a.renameProject({imageId: s.imageId, projectId: s.projectId, name: text, versionToken, authority});
      committed?.resolve(result);
      if (gate) await gate.promise;
      return result;
    },
  }));
  const navigator = createObjectNavigator({adapter, presentationRegistry, commandRegistry, referencesOfValue: imagesApi.referencesOfValue});
  const selectionModel = createSelectionModel();
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor});
  const browser = createProjectBrowser({adapter: browserAdapter, presentationRegistry, compositor});
  let deniedMode = false;
  const commandRouter = createCommandRouter({
    compositor, commandRegistry,
    dispatch: (command, s, opts) => adapter.dispatch(command, s, opts),
    authorityProvider: async () => (deniedMode ? readAuthority() : writeAuthority()),
  });
  // The host's intent seam (the fake renderer adapter has none): the handler the
  // shell registers is invoked with the ORDINARY intent + the live surface handle.
  const handlers = new Set();
  const intentAdapter = {onIntent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }};
  const emitEdit = (surface, key, text) => { for (const fn of handlers) fn({kind: 'edit-field', key, text}, surface); };
  // Per-edit synchronization: bindIntents is fire-and-forget; onEdited/onEditError
  // are the only completion seams. onEdited performs the AUTHORITATIVE reread with
  // a per-call Project READ authority (the rename authority is write-only).
  let pending = null;
  const edits = [];
  shell.bindIntents({
    adapter: intentAdapter, commandRouter,
    editBindings: [{
      viewId: browser.viewId,
      commandId: 'rename-project',
      resolveField: browser.resolveField,
      tokenFor: browser.tokenFor,
      onEdited: async (result) => {
        const record = {result, error: null, rereadError: null};
        edits.push(record);
        try {
          if (result === null) throw new Error('the edit was not routed to any Command');
          await browser.refresh({authority: readAuthority()});
        } catch (error) {
          record.rereadError = error;
        }
        pending?.resolve(record);
      },
      onEditError: async (error) => {
        const record = {result: null, error, rereadError: null};
        edits.push(record);
        try { await browser.refresh({authority: readAuthority()}); } catch (rereadError) { record.rereadError = rereadError; }
        pending?.resolve(record);
      },
    }],
  });
  const edit = async (key, text, surface = compositor.surfaceHandleForView(browser.viewId)) => {
    pending = deferred();
    emitEdit(surface, key, text);
    return within(pending.promise, 3000, `edit ${key} ${JSON.stringify(text)}`);
  };
  const liveDescriptor = () => compositor.liveView(browser.viewId).presentationDescriptor;
  const freshToken = async () => (await adapter.readProject({imageId: IMAGE_A, projectId: PROJECT, authority: readAuthority()})).versionToken;
  let follow = null;
  try {
    await shell.openWorkspace(ref(IMAGE_A, 'smalltalk/nil'), {authority: readAuthority(), readBlockId: IDS.readBlockId}).catch(() => {});
    const opened = await browser.open(subject, {authority: readAuthority()});
    const first = opened.presentationDescriptor;
    assert.equal(first.parameters.project.name, 'Old');
    const token0 = browser.tokenFor(first);
    assert.equal(typeof token0, 'string', 'step 1: Project A is displayed with a transient token');
    // The editable Name key comes from the SemanticUi document, never a literal.
    const nameKey = semanticUiForPresentation(first).root.children.find((c) => c.kind === 'field' && c.editable === 'text').key;
    const readsBefore = projectReads;

    // STEPS 2-8: the ordinary intent routes by the live project-view, the router
    // discovers rename-project, the Command reaches adapter.renameProject, Images
    // authorizes + CASes, ProjectBrowser rereads, the display shows 'New' from the
    // FRESH descriptor paired with the reread's token.
    const ok = await edit(nameKey, 'New');
    assert.equal(ok.error, null); assert.equal(ok.rereadError, null);
    assert.deepEqual(Object.keys(ok.result), ['versionToken'], 'the Command result is the write result (token only)');
    const second = liveDescriptor();
    assert.notEqual(second, first, 'P5: the displayed descriptor is a NEW object from the reread, never a local patch');
    assert.equal(second.parameters.project.name, 'New');
    assert.ok(projectReads > readsBefore, 'P5: a fresh authorized read happened');
    assert.equal(browser.tokenFor(first), null, 'the old descriptor has no token');
    assert.equal(browser.tokenFor(second), await freshToken(), 'the displayed token is the one paired by the reread');
    // SINKS: the token never appears in the descriptor, durable intent or the document.
    for (const sink of [JSON.stringify(second), JSON.stringify(compositor.durableIntent()), JSON.stringify(semanticUiForPresentation(second))]) {
      assert.ok(!sink.includes(browser.tokenFor(second)) && !sink.includes('object-version/'), 'no token in any sink');
    }

    // NEGATIVE: stale token -> CommandConflictError preserved; the display converges by reread; no overwrite.
    const staleDescriptor = liveDescriptor();
    const staleToken = browser.tokenFor(staleDescriptor);
    await adapter.renameProject({imageId: IMAGE_A, projectId: PROJECT, name: 'External', versionToken: staleToken, authority: writeAuthority()});
    const stale = await edit(nameKey, 'Loser', compositor.surfaceHandleForView(browser.viewId));
    assert.equal(stale.error?.name, 'CommandConflictError', 'a stale token is a conflict, reported as such');
    assert.equal(stale.rereadError, null, 'the Project was refreshed from authority after the conflict');
    assert.equal(liveDescriptor().parameters.project.name, 'External', 'no overwrite; the display converged on the current state');
    assert.equal(browser.tokenFor(liveDescriptor()), await freshToken());

    // NEGATIVE: denied write -> CommandAuthorizationError; no optimistic rename.
    deniedMode = true;
    const denied = await edit(nameKey, 'Denied');
    deniedMode = false;
    assert.equal(denied.error?.name, 'CommandAuthorizationError');
    assert.equal(liveDescriptor().parameters.project.name, 'External', 'a denied write changes nothing');
    assert.equal((await adapter.readProject({imageId: IMAGE_A, projectId: PROJECT, authority: readAuthority()})).descriptor.name, 'External');

    // NEGATIVE: an arbitrary/stale key -> no dispatch (no onEdited, no onEditError).
    const editsBefore = edits.length;
    emitEdit(compositor.surfaceHandleForView(browser.viewId), 1, 'x');
    emitEdit(compositor.surfaceHandleForView(browser.viewId), 99, 'x');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(edits.length, editsBefore, 'Project id/namespace/member keys cannot generate a rename');

    // TOKEN SCOPE through the vertical (follow stopped): a member RETARGET does
    // not stale the displayed rename token; a member ADD does (until a reread).
    await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE_A, projectId: PROJECT, key: 'm', role: 'source', target: {kind: 'ref', imageId: IMAGE_A, objectId: 'target-2'}});
    const afterRetarget = await edit(nameKey, 'AfterRetarget');
    assert.equal(afterRetarget.error, null, 'retargeting a member does not stale the Project rename token');
    assert.equal(liveDescriptor().parameters.project.name, 'AfterRetarget');
    await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE_A, projectId: PROJECT, key: 'n', role: 'lib', target: {kind: 'ref', imageId: IMAGE_A, objectId: 'target-3'}});
    const afterAdd = await edit(nameKey, 'AfterAdd');
    assert.equal(afterAdd.error?.name, 'CommandConflictError', 'adding a member stales the displayed token (conflict), and the reread converges');
    assert.equal(liveDescriptor().parameters.project.members.length, 2);
    const recovered = await edit(nameKey, 'AfterAdd');
    assert.equal(recovered.error, null, 'after the reread the fresh token renames');

    // P9: WRITE-TOKEN PROMOTION. Hold the Command open after the CAS committed,
    // bump the Project externally BEFORE the reread, release. A promoted write
    // token would be stale (next rename conflicts); the reread-paired token is fresh.
    gate = deferred(); committed = deferred();
    const held = edit(nameKey, 'Held');
    const writeResult = await within(committed.promise, 3000, 'the CAS committed'); // causal: the bump lands AFTER the commit, BEFORE the reread
    await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE_A, projectId: PROJECT, key: 'o', role: 'lib', target: {kind: 'ref', imageId: IMAGE_A, objectId: 'target-4'}});
    gate.resolve(); gate = null; committed = null;
    const heldResult = await held;
    assert.equal(heldResult.error, null);
    assert.equal(liveDescriptor().parameters.project.name, 'Held');
    assert.equal(browser.tokenFor(liveDescriptor()), await freshToken(), 'the displayed token is the READ token, not the write token');
    assert.notEqual(browser.tokenFor(liveDescriptor()), writeResult.versionToken, 'the write token was NOT promoted (the external bump made it stale)');
    const afterHeld = await edit(nameKey, 'AfterHeld');
    assert.equal(afterHeld.error, null, 'a promoted write token would have conflicted here');

    // RE-OPEN (4o8): a new project-view realization keeps the view-keyed binding
    // working without re-binding; the stale old surface routes nowhere.
    const oldSurface = compositor.surfaceHandleForView(browser.viewId);
    await browser.open(subject, {authority: readAuthority()});
    const newSurface = compositor.surfaceHandleForView(browser.viewId);
    assert.notEqual(newSurface, oldSurface);
    const reopened = await edit(nameKey, 'Reopened', newSurface);
    assert.equal(reopened.error, null); assert.equal(liveDescriptor().parameters.project.name, 'Reopened');
    const before = edits.length;
    emitEdit(oldSurface, nameKey, 'Ghost');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(edits.length, before, 'a stale surface cannot dispatch');

    // RACE (owner-mandated): follow + rename of the displayed Project. The Command
    // holds after the CAS; during the hold the follow observes the write (and an
    // UNRELATED write in the same image forces an extra unfiltered reread); the
    // edit completion also requests a refresh. Final state: current name, current token.
    const anchor = await adapter.observePull({imageId: IMAGE_A, afterCursor: '', authority: readAuthority(), blockId: IDS.observationBlockId});
    const followSawRaced = deferred();
    follow = browser.follow({
      authority: readAuthority(), observationBlockId: IDS.observationBlockId, afterCursor: anchor.cursor, intervalMs: 0,
      onUpdate(descriptor) { if (descriptor.parameters.project.name === 'Raced') followSawRaced.resolve(descriptor); },
      onError: followSawRaced.reject,
    });
    gate = deferred();
    const racing = edit(nameKey, 'Raced');
    await within(followSawRaced.promise, 3000, 'the follow observed the committed rename while the edit was still in flight');
    // An UNRELATED readable write in the same image during the hold forces an
    // extra, unfiltered follow reread (the 7c8 mechanism) — asserted, not assumed.
    const readsBeforeUnrelated = projectReads;
    await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE_A, projectId: UNRELATED, key: 'q', role: 'lib', target: {kind: 'ref', imageId: IMAGE_A, objectId: 'target-9'}});
    for (let i = 0; i < 600 && projectReads <= readsBeforeUnrelated; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(projectReads > readsBeforeUnrelated, 'an unrelated readable write forced an extra UNFILTERED reread (7c8)');
    gate.resolve(); gate = null;
    const raced = await racing;
    assert.equal(raced.error, null); assert.equal(raced.rereadError, null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(liveDescriptor().parameters.project.name, 'Raced', 'the final displayed descriptor is current');
    assert.equal(browser.tokenFor(liveDescriptor()), await freshToken(), 'no stale pairing overwrote the fresher one');
    const afterRace = await edit(nameKey, 'AfterRace');
    assert.equal(afterRace.error, null, 'the displayed token after the race is the current one');
  } finally {
    follow?.stop();
    if (follow) await follow.done.catch(() => {});
    await compositor.destroy();
    await runtime.close();
  }
});
