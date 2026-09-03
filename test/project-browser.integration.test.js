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
    authorizedReadProjectDescriptor: imagesApi.authorizedReadProjectDescriptor,
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
    assert.deepEqual(inspector.presentationDescriptor.subject, ref(IMAGE_B, cross.objectId));

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
