import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createImageClientAdapter} from '../../src/image-client-adapter.js';
import {createCompositor} from '../../src/compositor.js';
import {createEnvironmentShell} from '../../src/environment-shell.js';
import {createObjectNavigator} from '../../src/object-navigator.js';
import {createCommandRouter} from '../../src/command-router.js';
import {createCommandRegistry} from '../../src/command-registry.js';
import {createSelectionModel} from '../../src/selection-model.js';
import {createPresentationRegistry} from '../../src/presentation-registry.js';
import {createFakeRendererAdapter} from '../../src/fake-renderer-adapter.js';
import {semanticUiForPresentation} from '../../src/semantic-ui.js';
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider, createTextSlotMutationCommand}
  from '../../src/object-presentation-providers.js';
import {createProjectBrowser, createProjectSubject, createProjectPresentationProvider}
  from '../../src/project-browser.js';

// E4 real application pressure. These are SOURCE inputs from Cuis, not a saved
// application graph: Images imports and executes the real parser on every run.
// Native GTK proves generic inspector activation separately; this file does not
// claim portable import/compilation or a native-host YAXO execution capability.
const fixture = new URL('../fixtures/yaxo/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
const manifestBytes = await readFile(new URL('manifest.json', fixture));
const scopeBytes = await readFile(new URL('scope.json', fixture));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function verifySource(bytes = manifestBytes) {
  assert.equal(digest(bytes), provenance.output.sha256, 'canonical Cuis export byte identity');
  assert.equal(digest(scopeBytes), provenance.output.scopeSha256, 'exact M4 import scope');
}

const runtimeUrl = process.env.LAGRANGE_IMAGES_URL
  ?? new URL('../../../lagrange-images/src/runtime.js', import.meta.url).href;
let api;
let loadError;
try { api = await import(runtimeUrl); } catch (error) { loadError = error; }

const IMAGE = 'environment-yaxo';
const PROJECT = 'yaxo-application';
const MEMBER = 'application/root';
const READ = 'e4-read-block';
const MUTATION = 'yaxo-text-mutation';
const EDIT = 'edit-object-text';
const XML = '<note lang="en"><to>Tove</to></note>';

async function stage(name, work) {
  const start = performance.now();
  const report = (phase) => process.stderr.write(JSON.stringify({
    e4Stage: name, phase, elapsedMs: Math.round(performance.now() - start),
    rssBytes: process.memoryUsage().rss,
  }) + '\n');
  report('start');
  try { return await work(); } finally { report('end'); }
}


async function prepare(runtime, {editing = false} = {}) {
  verifySource();
  assert.deepEqual(runtime.toolchainProviders.list(), []);
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  await runtime.images.createImage({id: IMAGE});
  await stage('standard image', () => api.installSymmetricSmalltalkStandardImage({
    images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, lane: 'wasm',
  }));
  const imported = await stage('native YAXO import', () => api.importCuisNativePackage({
    images: runtime.images, compilation: runtime.compilation, imageId: IMAGE,
    manifest: JSON.parse(manifestBytes), scope: JSON.parse(scopeBytes),
  }));
  const classRef = (name) => imported.classes.find(
    ({identity}) => identity === 'cuis-class/YAXO/' + name).classRef;
  if (editing) {
    const setter = JSON.parse(manifestBytes).methods.find(({identity}) =>
      identity === 'cuis-method/YAXO/XMLStringNode/instance/string:');
    assert.equal(setter.source, 'string: aString\n\tstring _ aString',
      'this declared scalar edit is equivalent only to the pinned pure setter');
    const bindings = await api.instanceVariableBindings({images: runtime.images,
      imageId: IMAGE, classRef: classRef('XMLStringNode')});
    assert.equal(typeof bindings.string, 'string');
    await api.installCallableInterfaceV2({images: runtime.images, imageId: IMAGE,
      interfaceId: MUTATION + '-interface', functionName: 'edit-text',
      parameters: ['string', 'string', 'text-edit'], result: 'string',
      types: {'text-edit': {kind: 'record', fields: [{name: 'content', type: 'string'}]}},
    });
    await api.installImageMutationBinding({images: runtime.images, imageId: IMAGE,
      callableInterface: api.objectRef(IMAGE, MUTATION + '-interface'),
      fields: [{name: 'content', slot: bindings.string}],
      bindingId: MUTATION + '-binding', blockId: MUTATION});
  }
  const send = async (receiver, selector, args = []) =>
    runtime.executor.execute(await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk', receiver, message: api.textValue(selector), arguments: args,
    }, {dispatchImage: IMAGE}));
  await stage('tokenizer initialization', () => send(classRef('XMLTokenizer'), 'initialize'));
  const stream = await send(api.textValue(XML), 'readStream');
  const document = await stage('native parse', () => send(classRef('XMLDOMParser'), 'parseDocumentFrom:', [stream]));
  await api.createProject({images: runtime.images, imageId: IMAGE, projectId: PROJECT, name: 'YAXO'});
  await api.addProjectMember({
    images: runtime.images, imageId: IMAGE, projectId: PROJECT,
    key: MEMBER, role: 'application-root', target: document,
  });

  // Independent native package protocol oracle. These refs are for assertions
  // only; the navigation harness below receives just the Project locator.
  const documentElements = await send(document, 'elements');
  const root = await send(documentElements, 'first');
  const child = await send(await send(root, 'elements'), 'first');
  const text = await send(await send(child, 'contents'), 'first');
  for (const [ref, name] of [[document, 'XMLDocument'], [root, 'XMLElement'],
    [child, 'XMLElement'], [text, 'XMLStringNode']]) {
    assert.equal((await api.readBehavior(runtime.images, await send(ref, 'class'))).name.value, name);
  }
  assert.deepEqual(await send(text, 'string'), api.textValue('Tove'));
  assert.deepEqual(await send(root, 'attributeAt:', [api.textValue('lang')]), api.textValue('en'));
  return {document, documentElements, root, child, text};
}

async function openEnvironment(runtime, {editing = false} = {}) {
  const adapter = createImageClientAdapter({...api, ...runtime});
  // Existing trusted adapter bootstrap installs the ordinary read lane. Its
  // unused Probe schema does not manufacture any application instance.
  await adapter.ensureSchema(IMAGE, {
    shapeId: 'e4-probe-shape', className: 'E4Probe',
    interfaceId: 'e4-create-interface', bindingId: 'e4-create-binding', blockId: 'e4-create-block',
    mutationInterfaceId: 'e4-mutate-interface', mutationBindingId: 'e4-mutate-binding',
    mutationBlockId: 'e4-mutate-block', readInterfaceId: 'e4-read-interface',
    readBindingId: 'e4-read-binding', readBlockId: READ,
    observationInterfaceId: 'e4-observe-interface', observationBindingId: 'e4-observe-binding',
    observationBlockId: 'e4-observe-block',
  });
  const mutation = editing ? await adapter.bindTextSlotMutation({imageId: IMAGE, blockId: MUTATION}) : null;
  const commands = createCommandRegistry();
  if (mutation) commands.register(createTextSlotMutationCommand({id: EDIT, title: 'Edit text', mutation}));
  const attemptedReads = [];
  const recordingAdapter = {
    ...adapter,
    readObject(options) {
      attemptedReads.push(api.objectRef(options.imageId, options.objectId));
      return adapter.readObject(options);
    },
  };
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createProjectPresentationProvider());
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  const navigator = createObjectNavigator({
    adapter: recordingAdapter, presentationRegistry, commandRegistry: commands,
    referencesOfValue: api.referencesOfValue,
  });
  const renderer = createFakeRendererAdapter({projector: semanticUiForPresentation});
  const compositor = createCompositor({rendererAdapter: renderer});
  const selection = createSelectionModel();
  const shell = createEnvironmentShell({navigator, selectionModel: selection, compositor,
    writableSlots: mutation?.writableSlots ?? []});
  const browser = createProjectBrowser({adapter: recordingAdapter, presentationRegistry, compositor});
  // No root ref/read is needed to admit an empty inspector. First application
  // materialization must come from a Project member action.
  await compositor.openView({
    viewId: shell.inspectorViewId, viewDescriptor: {kind: 'canvas', width: 200, height: 200},
    presentationDescriptor: {kind: 'inspector', subject: null, parameters: {fields: {}, references: []}},
  });
  const grantFor = (ref, operation = api.OBJECT_READ_OPERATION) => runtime.authority.issue({
    principal: 'e4-reader',
    grants: [{operation, resource: api.objectResource(ref.imageId, ref.objectId)}],
  });
  const projectAuthority = grantFor(api.objectRef(IMAGE, api.projectObjectId(PROJECT)));
  const opened = await browser.open(createProjectSubject({imageId: IMAGE, projectId: PROJECT}), {
    authority: projectAuthority,
  });
  assert.equal(attemptedReads.length, 0, 'no application read before a Project action');
  const project = opened.presentationDescriptor.parameters.project;
  const ordinal = project.members.findIndex(({key}) => key === MEMBER);
  assert.ok(ordinal >= 0);
  assert.equal(project.members[ordinal].role, 'application-root');
  const rootRef = project.members[ordinal].target;
  const descriptor = () => compositor.liveView(shell.inspectorViewId).presentationDescriptor;
  const expectedAttempts = [];

  async function activate(viewId, index, authority) {
    const view = compositor.liveView(viewId);
    const target = viewId === browser.viewId
      ? browser.resolveItem(view.presentationDescriptor, index)
      : view.presentationDescriptor.parameters.references[index];
    assert.ok(target, 'action target must be disclosed by its current descriptor');
    const previous = descriptor();
    const errors = [];
    const unsubscribe = shell.bindIntents({
      adapter: renderer, inspectorNavigation: true, authority, readBlockId: READ,
      activationBindings: [{viewId: browser.viewId, resolveItem: browser.resolveItem}],
      onActivateError: (error) => errors.push(error),
    });
    try {
      expectedAttempts.push(target);
      const intent = renderer.activateAction(compositor.surfaceHandleForView(viewId), index);
      assert.deepEqual(intent, {kind: 'activate-item', key: index});
      const deadline = Date.now() + 2000;
      while (descriptor() === previous && errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.deepEqual(errors, []);
      assert.notEqual(descriptor(), previous, 'the rendered action must cause a fresh inspector presentation');
      assert.deepEqual(selection.selectedSubject(), target);
      assert.equal(compositor.focusedView(), viewId);
      assert.deepEqual(attemptedReads, expectedAttempts,
        'every attempted read, including denial, belongs to exactly one explicit action');
      assert.equal(descriptor().subject.objectId, target.objectId);
      assert.equal(descriptor().subject.imageId, target.imageId);
      return descriptor();
    } finally {
      unsubscribe();
    }
  }
  const activateRoot = (authority = grantFor(rootRef)) => activate(browser.viewId, ordinal, authority);
  // The explicit test host issues an exact target grant for a positive action;
  // production navigation never receives this issuer or any authority service.
  const activateReference = (index, authority) => {
    const target = descriptor().parameters.references[index];
    return activate(shell.inspectorViewId, index, authority ?? grantFor(target));
  };
  const dispatches = [];
  let denyWrite = false;
  const commandRouter = createCommandRouter({compositor, commandRegistry: commands,
    dispatch: adapter.dispatch,
    authorityProvider: async (request) => {
      dispatches.push(request);
      return grantFor(request.subject, denyWrite ? 'object/read' : 'object/write');
    }});
  const reread = async () => {
    const subject = selection.selectedSubject();
    expectedAttempts.push(subject);
    return shell.inspectSelected({authority: grantFor(subject), readBlockId: READ});
  };
  async function edit(text, {deny = false, afterCommit = null} = {}) {
    const handle = compositor.surfaceHandleForView(shell.inspectorViewId);
    // Read the key from the realized SemanticUi field, not a guessed ordinal.
    const fields = [];
    function walk(node) {
      if (node.kind === 'field' && node.editable === 'text') fields.push(node);
      for (const child of [...(node.children ?? []), ...(node.items ?? [])]) walk(child);
    }
    walk(renderer.realizedDocument(handle).root);
    assert.equal(fields.length, 1);
    denyWrite = deny;
    let outcome;
    await shell.handleEditField({key: fields[0].key, text, commandId: EDIT,
      surfaceHandle: handle, commandRouter, authority: grantFor(selection.selectedSubject()), readBlockId: READ,
      onEdited: async (receipt) => {
        if (afterCommit) await afterCommit(receipt);
        await reread();
        outcome = {receipt};
      },
      onEditError: async (error) => {
        if (error.name === 'CommandConflictError') await reread();
        outcome = {error};
      }});
    assert.ok(outcome, 'one edit produces a visible outcome');
    return outcome;
  }
  return {compositor, renderer, shell, adapter, mutation, dispatches, edit, reread,
    descriptor, activateRoot, activateReference, projectAuthority, grantFor, rootRef,
    attemptedReads, expectedAttempts};
}


export {api, loadError, IMAGE, PROJECT, MEMBER, READ, MUTATION, verifySource, manifestBytes, prepare, openEnvironment, stage};

// Discover a writable field only by following the current displayed graph.
export async function findEditableObject(environment) {
  const queue = [[]];
  const seen = new Set();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    assert.ok(queue.length < 100);
    const path = queue[cursor];
    await environment.activateRoot();
    for (const index of path) await environment.activateReference(index);
    const shown = environment.descriptor();
    const key = JSON.stringify(shown.subject);
    if (seen.has(key)) continue;
    seen.add(key);
    if (environment.mutation.writableSlots.some((slot) => Object.hasOwn(shown.parameters.fields, slot))) {
      return {path, subject: shown.subject};
    }
    for (let index = 0; index < shown.parameters.references.length; index += 1) queue.push([...path, index]);
  }
  assert.fail('ordinary application graph has no configured editable object');
}
