// sl1: trusted bootstrap plus test orchestration only. Every semantic operation
// comes from the admitted public Images artifact or the unchanged Environment.
// The fixture is canonical Cuis SOURCE, never a saved application object graph.
import * as imagesApi from 'portable-runtime';
import {installNativeCryptoProvider} from 'host/crypto-bootstrap';
import {createImageClientAdapter} from 'image-client-adapter';
import {createCompositor} from 'compositor';
import {createEnvironmentShell} from 'environment-shell';
import {createObjectNavigator} from 'object-navigator';
import {createCommandRegistry} from 'command-registry';
import {createCommandRouter} from 'command-router';
import {createSelectionModel} from 'selection-model';
import {createPresentationRegistry} from 'presentation-registry';
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider}
  from 'object-presentation-providers';
import {createProjectBrowser, createProjectSubject, createProjectPresentationProvider}
  from 'project-browser';
import {createNativeSmalltalkBrowser, createNativeClassSubject,
  createNativeClassPresentationProvider, createNativeMethodPresentationProvider,
  createReplaceNativeMethodCommand} from 'native-smalltalk-browser';

const IMAGE = 'native-yaxo-parity';
const PROJECT = 'yaxo-application';
const MEMBER = 'application/root';
const READ = 'parity-read-block';
const SELECTOR = 'string';
const XML = '<note lang="en"><to>Tove</to></note>';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refKey = (ref) => JSON.stringify([ref.kind, ref.imageId, ref.objectId]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => check(same(actual, expected),
  message + ': actual=' + JSON.stringify(actual) + ', expected=' + JSON.stringify(expected));

export async function setup() {
  check(typeof process === 'undefined' && typeof window === 'undefined', 'no Node/browser runtime');
  installNativeCryptoProvider();
  // The public mock backend is deliberately unchanged. No SQLite adapter,
  // custom executor/compiler, foreign runtime, or private artifact import.
  let runtime = await imagesApi.createPortableRuntime({backend: {mode: 'mock'}});
  check(runtime.toolchainProviders === undefined && runtime.foreignRuntimeProviders === undefined,
    'the portable runtime has no foreign-runtime or toolchain provider lane');
  await runtime.images.createImage({id: IMAGE});
  let imported, stream, expected, classRef;
  let adapter, compositor, shell, selection, browser, nativeBrowser, commandRouter;
  let unsubscribe, projectAuthority, rootRef, rootIndex, pending;
  let deniedWrite = false;
  const attemptedReads = [];
  const expectedAttempts = [];
  const methodReads = [];
  const methodGrants = [];
  const writeDemands = [];
  const activationErrors = [];
  const replacementErrors = [];
  const send = async (receiver, selector, args = []) => runtime.executor.execute(
    await runtime.invocations.sendMessage({languageId: 'symmetric-smalltalk', receiver,
      message: imagesApi.textValue(selector), arguments: args}, {dispatchImage: IMAGE}));
  const grantFor = (ref) => runtime.authority.issue({principal: 'parity-reader', grants: [
    {operation: 'object/read', resource: imagesApi.objectResource(ref.imageId, ref.objectId)},
  ]});
  const authorityFor = (subject) => {
    const grants = [{operation: 'object/read', resource:
      imagesApi.objectResource(subject.imageId, subject.classRef.objectId)}];
    if (subject.kind === 'native-method') grants.push({
      operation: imagesApi.SMALLTALK_METHOD_READ_OPERATION,
      resource: imagesApi.smalltalkMethodPositionResource(subject.imageId, subject.classRef, subject.selector),
    });
    // Only semantic locator grants, never present/future physical Block refs.
    const authority = runtime.authority.issue({principal: 'parity-reader', grants});
    methodGrants.push({subject, grants, authority});
    return authority;
  };
  const writeAuthorityFor = (subject) => runtime.authority.issue({principal: 'parity-writer', grants: [
    {operation: 'object/write', resource: imagesApi.objectResource(subject.imageId, subject.classRef.objectId)},
  ]});
  const descriptor = () => compositor.liveView(shell.inspectorViewId).presentationDescriptor;
  const nativeDescriptor = () => compositor.liveView(nativeBrowser.viewId).presentationDescriptor;
  const intentAdapter = {onIntent(handler) {
    globalThis.__parityIntentHandler = handler;
    return () => { globalThis.__parityIntentHandler = null; };
  }};
  globalThis.__jsenv_on_push = async (payload) => {
    const {intent, surfaceHandle} = JSON.parse(payload);
    check(typeof globalThis.__parityIntentHandler === 'function', 'shell intent binding exists');
    globalThis.__parityIntentHandler(intent, surfaceHandle);
  };
  function bind(authority) {
    unsubscribe?.();
    unsubscribe = shell.bindIntents({adapter: intentAdapter, inspectorNavigation: true,
      authority, readBlockId: READ, commandRouter,
      activationBindings: [
        {viewId: browser.viewId, resolveItem: browser.resolveItem},
        nativeBrowser.activationBinding({authorityFor}),
      ],
      inputBindings: [nativeBrowser.replacementInputBinding({authorityFor,
        onReplacementError: (error) => replacementErrors.push(error.name)})],
      onActivateError: (error) => activationErrors.push(error.message),
    });
  }
  const session = {
    async standardImage() {
      await imagesApi.installSymmetricSmalltalkStandardImage({images: runtime.images,
        compilation: runtime.compilation, imageId: IMAGE, lane: 'wasm'});
      return {installed: true};
    },
    async importYaxo() {
      const manifest = JSON.parse(globalThis.__yaxoManifest);
      equal([manifest.classes.length, manifest.methods.length], [24, 341], 'canonical complete source');
      equal(manifest.packages, [{name: 'YAXO', requires: []}], 'canonical package identity');
      imported = await imagesApi.importCuisNativePackage({images: runtime.images,
        compilation: runtime.compilation, imageId: IMAGE,
        manifest, scope: JSON.parse(globalThis.__yaxoScope)});
      classRef = (name) => {
        const entry = imported.classes.find(({identity}) => identity === 'cuis-class/YAXO/' + name);
        check(entry, 'import returned native class ' + name);
        return entry.classRef;
      };
      return {imported: true};
    },
    async initializeTokenizer() {
      globalThis.__parityStage('XMLTokenizer initialize', 'start');
      await send(classRef('XMLTokenizer'), 'initialize');
      globalThis.__parityStage('XMLTokenizer initialize', 'end');
      globalThis.__parityStage('readStream', 'start');
      stream = await send(imagesApi.textValue(XML), 'readStream');
      globalThis.__parityStage('readStream', 'end');
      return {initialized: true};
    },
    async parseAndCheck() {
      const document = await send(classRef('XMLDOMParser'), 'parseDocumentFrom:', [stream]);
      const documentElements = await send(document, 'elements');
      const root = await send(documentElements, 'first');
      const child = await send(await send(root, 'elements'), 'first');
      const text = await send(await send(child, 'contents'), 'first');
      equal(await send(text, SELECTOR), imagesApi.textValue('Tove'), 'native parser text result');
      equal(await send(root, 'attributeAt:', [imagesApi.textValue('lang')]),
        imagesApi.textValue('en'), 'native parser attribute result');
      expected = {document, documentElements, root, child, text};
      // Independent public semantic oracle; none of these refs seeds navigation.
      for (const [ref, name] of [[document, 'XMLDocument'], [root, 'XMLElement'],
        [child, 'XMLElement'], [text, 'XMLStringNode']]) {
        const behavior = await send(ref, 'class');
        const authority = grantFor(behavior);
        const description = await imagesApi.authorizedDescribeSmalltalkClass({
          images: runtime.images, imageId: IMAGE, classRef: behavior,
          require: (demand) => runtime.authority.require(authority, demand),
        });
        equal(description.name, name, 'parsed object has native class');
      }
      await imagesApi.createProject({images: runtime.images, imageId: IMAGE, projectId: PROJECT, name: 'YAXO'});
      await imagesApi.addProjectMember({images: runtime.images, imageId: IMAGE, projectId: PROJECT,
        key: MEMBER, role: 'application-root', target: document});
      return {text: 'Tove', attribute: 'en'};
    },
    async openEnvironment() {
      adapter = createImageClientAdapter({...imagesApi, ...runtime});
      await adapter.ensureSchema(IMAGE, {className: 'ParityProbe', shapeId: 'parity-probe',
        interfaceId: 'parity-create-interface', bindingId: 'parity-create-binding', blockId: 'parity-create-block',
        mutationInterfaceId: 'parity-mutate-interface', mutationBindingId: 'parity-mutate-binding',
        mutationBlockId: 'parity-mutate-block', readInterfaceId: 'parity-read-interface',
        readBindingId: 'parity-read-binding', readBlockId: READ,
        observationInterfaceId: 'parity-observe-interface', observationBindingId: 'parity-observe-binding',
        observationBlockId: 'parity-observe-block'});
      const recordingAdapter = {...adapter,
        readObject(options) {
          attemptedReads.push(imagesApi.objectRef(options.imageId, options.objectId));
          return adapter.readObject(options);
        },
        readSmalltalkMethodForUpdate(options) {
          methodReads.push({imageId: options.imageId, classRef: options.classRef, selector: options.selector});
          return adapter.readSmalltalkMethodForUpdate(options);
        },
      };
      const registry = createPresentationRegistry();
      for (const provider of [createProjectPresentationProvider(), createObjectInspectorProvider(),
        createUnauthorizedRefProvider(), createUnavailableRefProvider(),
        createNativeClassPresentationProvider(), createNativeMethodPresentationProvider()]) registry.register(provider);
      const commands = createCommandRegistry();
      commands.register(createReplaceNativeMethodCommand());
      const navigator = createObjectNavigator({adapter: recordingAdapter, presentationRegistry: registry,
        commandRegistry: commands, referencesOfValue: imagesApi.referencesOfValue});
      compositor = createCompositor({rendererAdapter: globalThis.rendererAdapter});
      selection = createSelectionModel();
      shell = createEnvironmentShell({navigator, selectionModel: selection, compositor});
      browser = createProjectBrowser({adapter: recordingAdapter, presentationRegistry: registry, compositor});
      nativeBrowser = createNativeSmalltalkBrowser({adapter: recordingAdapter, presentationRegistry: registry, compositor});
      commandRouter = createCommandRouter({compositor, commandRegistry: commands, dispatch: adapter.dispatch,
        authorityProvider: async (demand) => {
          writeDemands.push(demand);
          return deniedWrite ? authorityFor(demand.subject) : writeAuthorityFor(demand.subject);
        }});
      await compositor.openView({viewId: shell.inspectorViewId,
        viewDescriptor: {kind: 'surface', width: 300, height: 300},
        presentationDescriptor: {kind: 'inspector', subject: null, parameters: {fields: {}, references: []}}});
      projectAuthority = grantFor(imagesApi.objectRef(IMAGE, imagesApi.projectObjectId(PROJECT)));
      const opened = await browser.open(createProjectSubject({imageId: IMAGE, projectId: PROJECT}), {
        authority: projectAuthority, viewDescriptor: {kind: 'surface', width: 300, height: 300},
      });
      equal(attemptedReads, [], 'neither Project nor Navigator may prefetch application objects');
      const members = opened.presentationDescriptor.parameters.project.members;
      rootIndex = members.findIndex(({key}) => key === MEMBER);
      check(rootIndex >= 0, 'Project displays application root action');
      equal(members[rootIndex].role, 'application-root', 'application root role');
      rootRef = members[rootIndex].target;
      equal(rootRef, expected.document, 'Project exposes actual native parser result');
      return {rootIndex, inspectorHandle: compositor.surfaceHandleForView(shell.inspectorViewId)};
    },
    prepareAction(from, index, authorityMode = 'target') {
      const viewId = from === 'project' ? browser.viewId : shell.inspectorViewId;
      const shown = compositor.liveView(viewId).presentationDescriptor;
      const target = from === 'project' ? browser.resolveItem(shown, index) : shown.parameters.references[index];
      check(target, 'action target comes from current displayed descriptor');
      const authority = authorityMode === 'project' ? projectAuthority
        : grantFor(authorityMode === 'root' ? rootRef : target);
      bind(authority);
      pending = {before: descriptor(), target, viewId};
      expectedAttempts.push(target);
      return {handle: compositor.surfaceHandleForView(viewId)};
    },
    actionState() {
      equal(activationErrors, [], 'GTK navigation has no unreported failure');
      if (descriptor() === pending.before) return {done: false};
      equal(selection.selectedSubject(), pending.target, 'selection uses disclosed target');
      equal(compositor.focusedView(), pending.viewId, 'ordinary shell action focus');
      equal(attemptedReads, expectedAttempts, 'one attempted read per explicit GTK action, including denial');
      const shown = descriptor();
      if (shown.kind === 'unauthorized-reference') {
        equal(shown.subject.kind, 'unauthorized-ref', 'denial retains its explicit sentinel');
        equal(imagesApi.objectRef(shown.subject.imageId, shown.subject.objectId), pending.target,
          'denial identifies the attempted target');
      } else equal(shown.subject, pending.target, 'inspector subject matches attempted target');
      return {done: true, descriptor: descriptor()};
    },
    verifyTraversal(seenDescriptors, deniedTargets) {
      const seen = new Map(seenDescriptors.map((value) => [refKey(value.subject), value]));
      for (const ref of Object.values(expected)) check(seen.has(refKey(ref)),
        'generic GTK actions reach parsed native object ' + ref.objectId);
      check(deniedTargets.every((ref) => ref.kind === 'unauthorized-ref'), 'denied subjects are sentinels');
      check(deniedTargets.some((ref) => refKey(imagesApi.objectRef(ref.imageId, ref.objectId))
        === refKey(expected.documentElements)),
        'root authority fails on actual parsed collection');
      check(Object.values(seen.get(refKey(expected.text)).parameters.fields)
        .some((value) => value.kind === 'text' && value.value === 'Tove'),
      'inspector displays native XMLStringNode text');
      equal(attemptedReads, expectedAttempts, 'whole graph attempted-read trace');
      return {objects: seen.size, attempts: attemptedReads.length};
    },
    async openNativeClass() {
      bind(null);
      const subject = createNativeClassSubject({imageId: IMAGE, classRef: classRef('XMLStringNode')});
      await nativeBrowser.open(subject, {authority: authorityFor(subject),
        viewDescriptor: {kind: 'surface', width: 300, height: 300}});
      const targets = nativeDescriptor().parameters.targets;
      const key = targets.findIndex(({target}) => target.kind === 'native-method' && target.selector === SELECTOR);
      check(key >= 0, 'native class displays imported string selector');
      equal(methodReads, [], 'class browse must not prefetch methods');
      return {key, handle: compositor.surfaceHandleForView(nativeBrowser.viewId)};
    },
    methodState() {
      equal(activationErrors, [], 'native selector activation has no failure');
      const shown = nativeDescriptor();
      if (shown.kind !== 'native-method') return {done: false};
      return {done: true, descriptor: shown};
    },
    prepareReplacement(deny) {
      deniedWrite = deny;
      pending = {before: nativeDescriptor(), errors: replacementErrors.length,
        demands: writeDemands.length, reads: methodReads.length};
      return {prepared: true};
    },
    replacementState(expectedError = null) {
      const errors = replacementErrors.slice(pending.errors);
      if (expectedError) {
        if (!errors.length) return {done: false};
        equal(errors, [expectedError], 'exact replacement failure classification');
        if (expectedError === 'CommandConflictError' && nativeDescriptor() === pending.before) return {done: false};
      } else {
        equal(errors, [], 'replacement succeeds');
        if (nativeDescriptor() === pending.before) return {done: false};
      }
      equal(writeDemands.length, pending.demands + 1, 'one Command invocation per GTK input');
      const demand = writeDemands[writeDemands.length - 1];
      equal(demand.commandId, 'replace-native-method', 'ordinary replacement Command');
      equal(demand.subject, pending.before.subject, 'Command targets current semantic subject');
      equal(demand.intent, {kind: 'submit-input', key: 0}, 'authority demand omits transient source text');
      equal(nativeDescriptor().subject, pending.before.subject, 'replacement stays on same method');
      if (expectedError === 'CommandAuthorizationError') {
        check(nativeDescriptor() === pending.before, 'denial leaves displayed descriptor unchanged');
        equal(methodReads.length, pending.reads, 'denial does not spuriously reread');
      } else equal(methodReads.length, pending.reads + 1, 'success/conflict performs one fresh authorized read');
      return {done: true, descriptor: nativeDescriptor()};
    },
    async verifyExecuted(value) {
      equal(await send(expected.text, SELECTOR), imagesApi.textValue(value), 'later executed native result');
      const shown = nativeDescriptor();
      const authoritative = await adapter.describeSmalltalkMethod({imageId: IMAGE,
        classRef: shown.subject.classRef, selector: shown.subject.selector, authority: authorityFor(shown.subject)});
      equal(shown.parameters.smalltalkMethod, authoritative, 'display agrees with independent public read');
      equal(authoritative.source, null, 'replacement text is not durable displayed source');
      for (const {subject, grants, authority} of methodGrants) {
        const expectedGrants = [{operation: 'object/read', resource:
          imagesApi.objectResource(subject.imageId, subject.classRef.objectId)}];
        if (subject.kind === 'native-method') expectedGrants.push({operation: imagesApi.SMALLTALK_METHOD_READ_OPERATION,
          resource: imagesApi.smalltalkMethodPositionResource(subject.imageId, subject.classRef, subject.selector)});
        equal(grants, expectedGrants, 'native authority only names class plus logical method position');
        let blockReadDenied = false;
        try {
          runtime.authority.require(authority, {operation: 'object/read', resource:
            imagesApi.objectResource(IMAGE, authoritative.method.objectId)});
        } catch (error) { blockReadDenied = error.name === 'AuthorityError'; }
        check(blockReadDenied, 'a semantic method-position grant confers no generic Block read');
      }
      equal(attemptedReads, expectedAttempts, 'native browse/replacement does not read application graph');
      return {value, method: authoritative.method};
    },
    async replaceOutside(source) {
      const shown = nativeDescriptor();
      const options = {imageId: IMAGE, classRef: shown.subject.classRef, selector: shown.subject.selector};
      const read = await adapter.readSmalltalkMethodForUpdate({...options, authority: authorityFor(shown.subject)});
      await adapter.replaceSmalltalkMethod({...options, source, versionToken: read.versionToken,
        authority: writeAuthorityFor(shown.subject)});
      const fresh = await adapter.describeSmalltalkMethod({...options, authority: authorityFor(shown.subject)});
      check(!same(fresh.method, shown.parameters.smalltalkMethod.method), 'real outside write advances method identity');
      check(nativeDescriptor() === shown, 'outside write leaves paired browser observation stale');
      return {winner: fresh.method, value: (await send(expected.text, SELECTOR)).value};
    },
    async close() {
      unsubscribe?.();
      if (compositor) await compositor.destroy();
      await runtime.close();
      // close() stops storage; it does not discard executor caches/pools. Drop
      // every owning composition reference before the host checks GC disposal.
      runtime = adapter = compositor = shell = selection = browser = nativeBrowser = commandRouter = null;
      imported = stream = expected = classRef = pending = unsubscribe = null;
      globalThis.__parity = null;
      globalThis.__parityIntentHandler = null;
      globalThis.__jsenv_on_push = null;
      return {closed: true};
    },
  };
  globalThis.__parity = session;
  return {ready: true};
}
