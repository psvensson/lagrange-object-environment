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
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider,
  createTextSlotMutationCommand}
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
const MUTATION = 'parity-text-mutation';
const EDIT = 'edit-text';
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
  let imported, stream, expected, classRef, stringSlot, originalTextRecord, graphBefore;
  let adapter, compositor, shell, selection, browser, nativeBrowser, commandRouter, mutation;
  let unsubscribe, projectAuthority, rootRef, rootIndex, pending, afterCommitHook = null;
  let deniedWrite = false;
  const attemptedReads = [];
  const expectedAttempts = [];
  const methodReads = [];
  const methodGrants = [];
  const writeDemands = [];
  const activationErrors = [];
  const replacementErrors = [];
  const stateEdits = [];
  const send = async (receiver, selector, args = []) => runtime.executor.execute(
    await runtime.invocations.sendMessage({languageId: 'symmetric-smalltalk', receiver,
      message: imagesApi.textValue(selector), arguments: args}, {dispatchImage: IMAGE}));
  const grantFor = (ref) => runtime.authority.issue({principal: 'parity-reader', grants: [
    {operation: 'object/read', resource: imagesApi.objectResource(ref.imageId, ref.objectId)},
  ]});
  const objectWriteAuthorityFor = (ref) => runtime.authority.issue({principal: 'parity-writer', grants: [
    {operation: 'object/write', resource: imagesApi.objectResource(ref.imageId, ref.objectId)},
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
    unsubscribe = shell.bindIntents({adapter: intentAdapter, inspector: true, inspectorNavigation: true,
      commandId: EDIT, authority, readBlockId: READ, commandRouter,
      onEdited: async (receipt) => {
        const subject = selection.selectedSubject();
        let competing = null;
        if (afterCommitHook) {
          const hook = afterCommitHook;
          afterCommitHook = null;
          competing = await hook(receipt, subject);
        }
        expectedAttempts.push(subject);
        await shell.inspectSelected({authority: grantFor(subject), readBlockId: READ});
        stateEdits.push({ok: true, receipt, competing});
      },
      onEditError: async (error, {reread} = {}) => {
        if (error.name === 'CommandConflictError' && reread) {
          expectedAttempts.push(selection.selectedSubject());
          await reread();
        }
        stateEdits.push({ok: false, error: error.name});
      },
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
      const setter = manifest.methods.find(({identity}) =>
        identity === 'cuis-method/YAXO/XMLStringNode/instance/string:');
      equal(setter?.source, 'string: aString\n\tstring _ aString',
        'this declared scalar edit is equivalent only to the pinned pure setter');
      const bindings = await imagesApi.instanceVariableBindings({images: runtime.images,
        imageId: IMAGE, classRef: classRef('XMLStringNode')});
      check(typeof bindings.string === 'string' && bindings.string.length > 0,
        'XMLStringNode declares string instance variable slot');
      stringSlot = bindings.string;
      await imagesApi.installCallableInterfaceV2({images: runtime.images, imageId: IMAGE,
        interfaceId: MUTATION + '-interface', functionName: EDIT,
        parameters: ['string', 'string', 'text-edit'], result: 'string',
        types: {'text-edit': {kind: 'record', fields: [{name: 'content', type: 'string'}]}},
      });
      await imagesApi.installImageMutationBinding({images: runtime.images, imageId: IMAGE,
        callableInterface: imagesApi.objectRef(IMAGE, MUTATION + '-interface'),
        fields: [{name: 'content', slot: stringSlot}],
        bindingId: MUTATION + '-binding', blockId: MUTATION});
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
      originalTextRecord = await runtime.images.getObject(IMAGE, text.objectId);
      graphBefore = await Promise.all([document, documentElements, root, child]
        .map((ref) => runtime.images.getObject(IMAGE, ref.objectId)));
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
      mutation = await adapter.bindTextSlotMutation({imageId: IMAGE, blockId: MUTATION});
      equal(mutation.writableSlots, [stringSlot], 'mutation binding owns single writable slot');
      commands.register(createTextSlotMutationCommand({id: EDIT, title: 'Edit text', mutation}));
      commands.register(createReplaceNativeMethodCommand());
      const navigator = createObjectNavigator({adapter: recordingAdapter, presentationRegistry: registry,
        commandRegistry: commands, referencesOfValue: imagesApi.referencesOfValue});
      compositor = createCompositor({rendererAdapter: globalThis.rendererAdapter});
      selection = createSelectionModel();
      shell = createEnvironmentShell({navigator, selectionModel: selection, compositor,
        writableSlots: mutation.writableSlots});
      browser = createProjectBrowser({adapter: recordingAdapter, presentationRegistry: registry, compositor});
      nativeBrowser = createNativeSmalltalkBrowser({adapter: recordingAdapter, presentationRegistry: registry, compositor});
      commandRouter = createCommandRouter({compositor, commandRegistry: commands, dispatch: adapter.dispatch,
        authorityProvider: async (demand) => {
          writeDemands.push(demand);
          if (demand.subject?.kind === 'ref') {
            return deniedWrite ? grantFor(demand.subject) : objectWriteAuthorityFor(demand.subject);
          }
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
    async prepareStateEdit(deny, afterCommitText = null) {
      deniedWrite = deny;
      const frontierBefore = await runtime.images.frontier(IMAGE);
      const readBefore = await adapter.readObject({imageId: IMAGE, objectId: expected.text.objectId,
        authority: grantFor(expected.text), blockId: READ});
      afterCommitHook = afterCommitText === null ? null : async (receipt, subject) => {
        const outside = await mutation.mutate({subject, field: {slot: stringSlot}, text: afterCommitText,
          versionToken: receipt.versionToken, authority: objectWriteAuthorityFor(subject)});
        return {outside};
      };
      pending = {before: descriptor(), tokenBefore: shell._inspectorToken().token,
        frontierBefore, readBefore, edits: stateEdits.length,
        demands: writeDemands.length, attempts: attemptedReads.length};
      return {prepared: true};
    },
    async stateEditState(submittedText, expectedText, expectedError = null) {
      const outcomes = stateEdits.slice(pending.edits);
      if (!outcomes.length) return {done: false};
      equal(outcomes.length, 1, 'single state-edit outcome');
      const outcome = outcomes[0];
      equal(writeDemands.length, pending.demands + 1, 'one Command invocation per GTK field edit');
      const demand = writeDemands[writeDemands.length - 1];
      equal(demand.commandId, EDIT, 'ordinary text-slot mutation Command');
      equal(demand.subject, expected.text, 'Command targets current inspector subject');
      equal(demand.intent, {kind: 'edit-field', key: 0}, 'authority demand omits raw edit text and token');
      check(!JSON.stringify(demand).includes(submittedText), 'submitted text must not leak into authority demand');
      if (expectedError) {
        equal(outcome, {ok: false, error: expectedError}, 'exact state-edit failure classification');
        const frontierNow = await runtime.images.frontier(IMAGE);
        equal(frontierNow, pending.frontierBefore, 'denied/stale state edit preserves history frontier');
        const readNow = await adapter.readObject({imageId: IMAGE, objectId: expected.text.objectId,
          authority: grantFor(expected.text), blockId: READ});
        equal(readNow, pending.readBefore, 'denied/stale state edit preserves stored record and version token');
        if (expectedError === 'CommandAuthorizationError') {
          check(descriptor() === pending.before, 'denied state edit leaves displayed descriptor unchanged');
          equal(shell._inspectorToken().token, pending.tokenBefore, 'denied state edit preserves paired inspector token');
          equal(attemptedReads.length, pending.attempts, 'denied state edit does not spuriously reread');
        } else {
          check(descriptor() !== pending.before, 'conflict triggers fresh authorized inspector reread');
          equal(shell._inspectorToken().token, pending.readBefore.versionToken,
            'conflict reread pairs winning version token');
          equal(attemptedReads.length, pending.attempts + 1, 'conflict performs one fresh authorized read');
        }
      } else {
        equal(outcome.ok, true, 'state edit succeeds');
        check(descriptor() !== pending.before, 'successful state edit re-presents fresh authorized read');
        equal(attemptedReads.length, pending.attempts + 1, 'successful state edit performs one fresh authorized read');
        const readNow = await adapter.readObject({imageId: IMAGE, objectId: expected.text.objectId,
          authority: grantFor(expected.text), blockId: READ});
        equal(shell._inspectorToken().token, readNow.versionToken, 'reread pairs current read version token');
        if (outcome.competing) {
          check(outcome.receipt.versionToken !== readNow.versionToken,
            'post-commit outside write supersedes receipt token');
          check(shell._inspectorToken().token !== outcome.receipt.versionToken,
            'inspector pairs reread token, never receipt token');
        }
      }
      equal(descriptor().subject, expected.text, 'inspector stays on XMLStringNode');
      equal(descriptor().parameters.fields[stringSlot], imagesApi.textValue(expectedText),
        'inspector displays authoritative slot text');
      equal(await send(expected.text, SELECTOR), imagesApi.textValue(expectedText),
        'native getter answers authoritative text');
      equal(await send(await send(expected.child, 'contents'), 'first'), expected.text,
        'parent element still points to same XMLStringNode');
      equal(await send(expected.root, 'attributeAt:', [imagesApi.textValue('lang')]),
        imagesApi.textValue('en'), 'sibling/root attributes unchanged');
      const currentRecord = await runtime.images.getObject(IMAGE, expected.text.objectId);
      equal(currentRecord.slots, {...originalTextRecord.slots, [stringSlot]: imagesApi.textValue(expectedText)},
        'only the mapped string slot changed');
      for (const key of ['id', 'shape', 'behavior', 'indexed', 'metadata']) {
        equal(currentRecord[key], originalTextRecord[key],
          'object identity/shape/behavior/indexed/metadata preserved');
      }
      const graphNow = await Promise.all([expected.document, expected.documentElements, expected.root, expected.child]
        .map((ref) => runtime.images.getObject(IMAGE, ref.objectId)));
      equal(graphNow, graphBefore, 'ancestor application objects unchanged');
      equal(attemptedReads, expectedAttempts, 'every attempted read accounted for');
      return {done: true, descriptor: descriptor()};
    },
    async mutateStateOutside(text) {
      const before = await adapter.readObject({imageId: IMAGE, objectId: expected.text.objectId,
        authority: grantFor(expected.text), blockId: READ});
      const shown = descriptor();
      const tokenBefore = shell._inspectorToken().token;
      equal(tokenBefore, before.versionToken, 'inspector starts paired with current version token');
      const outside = await mutation.mutate({subject: expected.text, field: {slot: stringSlot}, text,
        versionToken: before.versionToken, authority: objectWriteAuthorityFor(expected.text)});
      check(outside.versionToken !== tokenBefore, 'outside state write advances version token');
      check(descriptor() === shown && shell._inspectorToken().token === tokenBefore,
        'outside write leaves inspector observation stale until conflict/reread');
      equal(await send(expected.text, SELECTOR), imagesApi.textValue(text),
        'outside write immediately visible to native getter');
      return {value: text};
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
      runtime = adapter = compositor = shell = selection = browser = nativeBrowser = commandRouter = mutation = null;
      imported = stream = expected = classRef = stringSlot = originalTextRecord = graphBefore = null;
      pending = afterCommitHook = unsubscribe = null;
      globalThis.__parity = null;
      globalThis.__parityIntentHandler = null;
      globalThis.__jsenv_on_push = null;
      return {closed: true};
    },
  };
  globalThis.__parity = session;
  return {ready: true};
}
