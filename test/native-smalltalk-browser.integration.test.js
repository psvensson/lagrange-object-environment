import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createImageClientAdapter} from '../src/image-client-adapter.js';
import {createCompositor} from '../src/compositor.js';
import {createEnvironmentShell} from '../src/environment-shell.js';
import {createObjectNavigator} from '../src/object-navigator.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {createSelectionModel} from '../src/selection-model.js';
import {semanticUiForPresentation as projectSemanticUi} from '../src/semantic-ui.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {
  createUnauthorizedRefProvider,
  createUnavailableRefProvider,
} from '../src/object-presentation-providers.js';
import {
  LOCATOR_RELATION,
  NATIVE_CLASS_PRESENTATION_KIND,
  NATIVE_METHOD_PRESENTATION_KIND,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeMethodPresentationProvider,
  createNativeMethodSubject,
  createNativeSmalltalkBrowser,
  createReplaceNativeMethodCommand,
  resolveNativeTarget,
} from '../src/native-smalltalk-browser.js';
import {createCommandRouter} from '../src/command-router.js';
import {semanticUiForPresentation} from '../src/semantic-ui.js';
import {assertDataRepresentable} from '../src/compositor.js';

// THE E1 FALSIFIER (Bead lagrange-object-environment-eij.1).
//
// One image, two classes, ONE Environment browsing path:
//   * BrowseDeclared  — a hand-authored native Symmetric Smalltalk class;
//   * BrowseImported  — a Cuis-origin class produced by IMAGES' own native
//                       import from a canonical cuis-semantic-export-v2
//                       manifest. A Cuis-origin class IS a native class.
//
// The Environment must not be able to tell them apart, and this file proves it
// cannot: same provider, same presentation kind, structurally identical
// documents, and a seam that receives nothing but {imageId, classRef, authority}.
//
// Authority is proven independently of presentation: a locator in a description
// is not a grant, and a denied browse is the same answer whether or not the
// class exists.
//
// LANE SCOPE (Bead aov): this runs in the JS lane only. Images'
// portable-runtime exports the ADR 0087 browse seams but NOT the class-building
// or Cuis-import helpers, so the native lane cannot construct either class. Its
// coverage is the seam admission plus the checked-in SemanticUi fixture.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = resolve(HERE, '../../lagrange-images/src/runtime.js');
const RUNTIME_URL = process.env.LAGRANGE_IMAGES_URL ?? pathToFileURL(DEFAULT_RUNTIME).href;

let imagesApi = null;
try {
  imagesApi = await import(RUNTIME_URL);
} catch {
  imagesApi = null;
}

const available = imagesApi !== null && typeof imagesApi.createRuntime === 'function'
  && typeof imagesApi.authorizedDescribeSmalltalkClass === 'function'
  && typeof imagesApi.authorizedDescribeSmalltalkMethod === 'function'
  && typeof imagesApi.importCuisNativePackage === 'function'
  // The only redefinition path reachable from source (defineMethods* refuse it),
  // needed by the proof that the Block ref is Images' and not derived here.
  && typeof imagesApi.reconcileMethodsFromSource === 'function'
  // Called directly to learn the ref Images bound, so gate on it too: an Images
  // export change must SKIP this lane, not error it.
  && typeof imagesApi.methodBindings === 'function';

// The integration lane skips silently without a sibling runtime, which would
// make "all green" indistinguishable from "nothing ran" for the one file that
// carries E1's identity proof. CI checks out the pinned sibling, so it sets
// this and a silent skip becomes a hard failure.
test('E1 identity proof lane availability', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') {
    assert.ok(available, `LAGRANGE_IMAGES_REQUIRED=1 but no ADR 0087 Images runtime resolved at ${RUNTIME_URL}`);
  }
});

const IMAGE = 'native-browse';

// The canonical Cuis semantic export the IMAGES import adapter consumes. This
// is a manifest in the format Images defines, handed to Images' own importer:
// the Environment neither parses nor retains it, and no Cuis VM, toolchain or
// foreign-runtime provider exists anywhere in this runtime.
function cuisManifest() {
  return Object.freeze({
    format: imagesApi.CUIS_SEMANTIC_EXPORT_V2,
    packages: [{name: 'Fixture', requires: ['Cuis-Base']}],
    classes: [{
      identity: 'cuis-class/Fixture/BrowseImported',
      package: 'Fixture',
      name: 'BrowseImported',
      superclassName: 'Object',
      superclass: imagesApi.CUIS_NATIVE_ROOT_OBJECT_IDENTITY,
      instanceVariables: ['baseValue'],
    }],
    methods: [{
      identity: 'cuis-method/Fixture/BrowseImported/instance/baseValue',
      package: 'Fixture',
      class: 'cuis-class/Fixture/BrowseImported',
      side: 'instance',
      selector: 'baseValue',
      source: 'baseValue\n\t^ baseValue',
    }],
  });
}

function adapterClients(runtime) {
  return {
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    authority: runtime.authority,
    compilation: runtime.compilation,
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
    authorizedDescribeSmalltalkMethod: imagesApi.authorizedDescribeSmalltalkMethod,
    authorizedReadSmalltalkMethodForUpdate: imagesApi.authorizedReadSmalltalkMethodForUpdate,
    authorizedReplaceSmalltalkMethod: imagesApi.authorizedReplaceSmalltalkMethod,
  };
}

function registryFor() {
  const registry = createPresentationRegistry();
  registry.register(createNativeClassPresentationProvider());
  registry.register(createNativeMethodPresentationProvider());
  registry.register(createUnavailableRefProvider());
  registry.register(createUnauthorizedRefProvider());
  return registry;
}

// A DELEGATING spy over the real adapter: purity is recorded on exactly the
// calls that also produce every other assertion in this file, so it can never be
// proven against a stub.
function recordingAdapter(adapter) {
  const seamCalls = [];
  return {
    seamCalls,
    describeSmalltalkClass(args) {
      seamCalls.push(args);
      return adapter.describeSmalltalkClass(args);
    },
    describeSmalltalkMethod(args) {
      seamCalls.push(args);
      return adapter.describeSmalltalkMethod(args);
    },
    readSmalltalkMethodForUpdate(args) {
      seamCalls.push(args);
      return adapter.readSmalltalkMethodForUpdate(args);
    },
    replaceSmalltalkMethod(args) {
      seamCalls.push(args);
      return adapter.replaceSmalltalkMethod(args);
    },
    classifySmalltalkClassReadError: (error) => adapter.classifySmalltalkClassReadError(error),
    classifySmalltalkMethodReadError: (error) => adapter.classifySmalltalkMethodReadError(error),
  };
}

async function setup() {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  // No toolchain and no foreign-runtime provider exists here at all: browsing a
  // Cuis-origin class cannot reach a Cuis VM even by accident.
  assert.deepEqual(runtime.toolchainProviders.list(), []);
  assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});
  await imagesApi.installSmalltalkInstanceVariableProtocol({images: runtime.images, imageId: IMAGE});

  // (1) the Cuis-origin class, through IMAGES' importer.
  const imported = await imagesApi.importCuisNativePackage({
    images: runtime.images, compilation: runtime.compilation, imageId: IMAGE, manifest: cuisManifest(),
  });
  // (2) the hand-authored native class: same declared shape, same selector.
  const declared = await imagesApi.ensureClassFromDeclaration({
    images: runtime.images, imageId: IMAGE, name: 'BrowseDeclared', instanceVariables: ['baseValue'],
  });
  await imagesApi.defineMethodsFromSource({
    images: runtime.images, compilation: runtime.compilation, imageId: IMAGE,
    classRef: declared.classRef, methods: [{selector: 'baseValue', source: '[ ^baseValue ]'}],
  });

  const realAdapter = createImageClientAdapter(adapterClients(runtime));
  const adapter = recordingAdapter(realAdapter);
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryFor(), compositor});
  const registry = registryFor();

  const grant = (objectId) => ({
    operation: imagesApi.OBJECT_READ_OPERATION,
    resource: imagesApi.objectResource(IMAGE, objectId),
  });
  const authorityFor = (...objectIds) => runtime.authority.issue({
    principal: 'alice', grants: objectIds.map(grant),
  });

  // Images ccd8321 (#231) CHANGED THE METHOD-READ CONTRACT, and this helper is
  // the whole Environment-side consequence in this slice. A public method read
  // now authorizes, before it resolves anything:
  //   1. `object/read` on the declaring Class/Metaclass  (unchanged);
  //   2. `smalltalk-method/read` on the exact LOGICAL POSITION
  //      {imageId, classRef, selector}.
  // It is NOT `object/read` on the current Block any more. The position is
  // nameable from the public semantic locator alone -- no caller has to predict
  // which immutable revision currently occupies it -- and the grant follows that
  // position across revisions while conferring no direct Block authority.
  //
  // The `objectIds` argument is kept here so this admission slice changes the
  // authority CONSTRUCTION and nothing else; the Block ids the E2 fixtures still
  // pass are now redundant, and removing them (with `boundBlockFor`) belongs to
  // the E3 slice that also proves the first read needs no Block identity at all.
  const methodPositionGrant = (classRef, selector) => ({
    operation: imagesApi.SMALLTALK_METHOD_READ_OPERATION,
    resource: imagesApi.smalltalkMethodPositionResource(IMAGE, classRef, selector),
  });
  const authorityForMethod = ({classRef, selector, objectIds = []}) => runtime.authority.issue({
    principal: 'alice',
    grants: [...objectIds.map(grant), methodPositionGrant(classRef, selector)],
  });

  return {
    runtime,
    adapter,
    realAdapter,
    browser,
    registry,
    authorityFor,
    authorityForMethod,
    methodPositionGrant,
    importedClassRef: imported.classes[0].classRef,
    declaredClassRef: declared.classRef,
  };
}

const skip = !available && 'lagrange-images sibling runtime with the ADR 0087 browse seam not available';

test('a hand-authored native class and a Cuis-origin imported class take the SAME Environment browsing path', {skip}, async () => {
  const t = await setup();
  try {
    const browse = async (classRef) => t.browser.browse(
      createNativeClassSubject({imageId: IMAGE, classRef}),
      {authority: t.authorityFor(classRef.objectId)},
    );

    const imported = await browse(t.importedClassRef);
    const declared = await browse(t.declaredClassRef);

    // --- ONE ROUTE. Same provider, same presentation kind, and (asserted, not
    // implied) exactly ONE candidate discovered for each subject.
    for (const [label, presentation, classRef] of [
      ['imported', imported, t.importedClassRef], ['declared', declared, t.declaredClassRef],
    ]) {
      assert.equal(presentation.kind, NATIVE_CLASS_PRESENTATION_KIND, label);
      const discovered = t.registry.discover(
        createNativeClassSubject({imageId: IMAGE, classRef}),
        {smalltalkClass: presentation.context.smalltalkClass, targets: presentation.context.targets},
      );
      assert.equal(discovered.presentations.length, 1, `${label}: exactly one presentation is discoverable`);
      assert.deepEqual(discovered.failures, [], `${label}: no provider failed`);
    }

    // --- INPUT PURITY. The seam saw the subject and authority and NOTHING else:
    // no manifest, package name, Cuis semantic identity or origin flag could
    // have reached Images, so an origin-selecting read is not merely absent, it
    // was impossible on these exact calls.
    assert.equal(t.adapter.seamCalls.length, 2, 'one authorized read per browse — never a graph walk');
    for (const call of t.adapter.seamCalls) {
      assert.deepEqual(Object.keys(call).sort(), ['authority', 'classRef', 'imageId']);
    }
    assert.deepEqual(t.adapter.seamCalls.map((c) => c.classRef), [t.importedClassRef, t.declaredClassRef]);

    // --- IDENTITY. The description's subject IS the ref Images' importer
    // returned — not a rebuilt id, not a re-spelling.
    assert.deepEqual(imported.subject.classRef, t.importedClassRef);
    assert.deepEqual(imported.context.smalltalkClass.class, t.importedClassRef);
    // The same identity claim for the hand-authored class: acceptance says EACH
    // class appears as the exact classRef Images returned, so both halves of the
    // pair are checked on both the subject and the description.
    assert.deepEqual(declared.subject.classRef, t.declaredClassRef);
    assert.deepEqual(declared.context.smalltalkClass.class, t.declaredClassRef);

    // --- STRUCTURAL EQUALITY. Everything except the class's own name and its
    // refs is identical, and both descriptions carry the SAME field set.
    const blank = (presentation) => ({
      ...presentation.context.smalltalkClass, class: null, superclass: null, classSide: null, name: null,
    });
    assert.deepEqual(
      Object.keys(imported.context.smalltalkClass).sort(),
      Object.keys(declared.context.smalltalkClass).sort(),
    );
    assert.deepEqual(blank(imported), blank(declared),
      'origin changes nothing a description reports');

    // --- POSITIVE CONTENT, through the real browse (not only the fixture). An
    // implementation that presented name+side and dropped the rest would pass a
    // pure equality check, because both classes would be equally impoverished.
    assert.equal(imported.context.smalltalkClass.name, 'BrowseImported');
    assert.equal(declared.context.smalltalkClass.name, 'BrowseDeclared');
    assert.equal(imported.context.smalltalkClass.side, 'instance');
    assert.deepEqual(imported.context.smalltalkClass.layout,
      {instanceVariables: ['baseValue'], indexed: 'none'},
      'the DECLARED native layout NAMES, exactly as Images reported them');
    assert.deepEqual(imported.context.smalltalkClass.selectors, ['baseValue'],
      'the class\'s OWN canonical selector names');
    assert.equal(imported.context.smalltalkClass.provenance, null,
      'Images owns no durable provenance today; E1 reports that truthfully rather than inventing one');
    // ONE ordered target array: the class's own selectors, then its relations,
    // each carrying the description's OWN objects by identity.
    assert.deepEqual(imported.context.targets.map((entry) => entry.group),
      ['selector', 'relation', 'relation']);
    assert.equal(imported.context.targets[0].target.selector, imported.context.smalltalkClass.selectors[0]);
    assert.equal(imported.context.targets[0].target.classRef, imported.context.smalltalkClass.class);
    assert.equal(imported.context.targets[1].target.classRef, imported.context.smalltalkClass.superclass);
    assert.equal(imported.context.targets[2].target.classRef, imported.context.smalltalkClass.classSide);
    assert.deepEqual(
      imported.context.targets.map((entry) => entry.label.split(' ->')[0]),
      ['baseValue', LOCATOR_RELATION.SUPERCLASS, LOCATOR_RELATION.CLASS_SIDE],
    );

    // --- NO ORIGIN ANYWHERE. Not in the presentation, not in the rendered
    // document. Cuis origin is not native identity.
    const descriptor = t.browser.toPresentationDescriptor(imported);
    assertDataRepresentable(descriptor, 'presentationDescriptor');
    const rendered = JSON.stringify(semanticUiForPresentation(descriptor));
    const presented = JSON.stringify(descriptor);
    for (const token of ['cuis', 'Cuis', 'Fixture', 'oop', 'Spur']) {
      assert.equal(presented.includes(token), false, `the descriptor must not carry ${token}`);
      assert.equal(rendered.includes(token), false, `the document must not carry ${token}`);
    }
    // Nor any Images storage layout, at any depth.
    for (const storageToken of ['behavior-name', 'behavior-superclass', 'behavior-methods',
      'behavior-instance-shape', 'method-dictionary', 'smalltalk/behavior-shape', '_version']) {
      assert.equal(presented.includes(storageToken), false, `the descriptor must not expose ${storageToken}`);
    }
    // provenance is null, so no Provenance row may be rendered.
    assert.equal(JSON.parse(rendered).root.children.some((c) => c.label === 'Provenance'), false);
    assert.equal(rendered.includes('Class: BrowseImported'), true);
  } finally {
    await t.runtime.close();
  }
});

test('the class side is a LOCATOR: browsing it needs its own grant, and answers the class side', {skip}, async () => {
  const t = await setup();
  try {
    const subject = createNativeClassSubject({imageId: IMAGE, classRef: t.importedClassRef});
    const instanceSide = await t.browser.browse(subject, {authority: t.authorityFor(t.importedClassRef.objectId)});
    const {superclass, classSide} = instanceSide.context.smalltalkClass;
    const descriptor = t.browser.toPresentationDescriptor(instanceSide);

    // The resolver hands back exactly the refs the description named.
    // The imported class has ONE selector, so its relation targets sit at keys 1
    // and 2 — precisely the offset a per-group key space would get wrong.
    const targets = descriptor.parameters.targets;
    const relationKeys = targets
      .map((entry, key) => ({entry, key}))
      .filter(({entry}) => entry.group === 'relation')
      .map(({key}) => key);
    assert.deepEqual(relationKeys, [1, 2]);
    assert.equal(resolveNativeTarget(descriptor, relationKeys[0]).classRef, superclass);
    assert.equal(resolveNativeTarget(descriptor, relationKeys[1]).classRef, classSide);
    assert.equal(resolveNativeTarget(descriptor, 0).kind, 'native-method');

    // A LOCATOR IS NOT A GRANT. Holding the class's own read authority does not
    // reach its superclass or its class side.
    const childOnly = t.authorityFor(t.importedClassRef.objectId);
    for (const [label, ref] of [['superclass', superclass], ['class side', classSide]]) {
      const denied = await t.browser.browse(
        createNativeClassSubject({imageId: IMAGE, classRef: ref}), {authority: childOnly},
      );
      assert.equal(denied.kind, 'unauthorized-reference', `${label} is not reachable on the class's own grant`);
    }

    // With ITS OWN grant the class side browses through the same path — and
    // answers the kernel's metaclass facts, which is the only thing that proves
    // `side` is reported rather than assumed.
    const classSidePresentation = await t.browser.browse(
      createNativeClassSubject({imageId: IMAGE, classRef: classSide}), {authority: t.authorityFor(classSide.objectId)},
    );
    assert.equal(classSidePresentation.kind, NATIVE_CLASS_PRESENTATION_KIND);
    assert.equal(classSidePresentation.context.smalltalkClass.side, 'class');
    assert.equal(classSidePresentation.context.smalltalkClass.name, 'BrowseImported class');
    assert.equal(classSidePresentation.context.smalltalkClass.classSide, null,
      'a Metaclass has no class side, and there is deliberately no inverse edge to derive');
    assert.equal(classSidePresentation.context.smalltalkClass.layout, null,
      'a Metaclass declares no instance layout at all — not an empty one');
    // The instance side reported 'instance' for the SAME browse path: `side` is
    // the kernel's metaclass decision, never a constant.
    assert.equal(instanceSide.context.smalltalkClass.side, 'instance');
  } finally {
    await t.runtime.close();
  }
});

test('a denied browse is the same answer for an existing and a nonexistent class (no existence oracle)', {skip}, async () => {
  const t = await setup();
  try {
    const nothing = t.runtime.authority.issue({principal: 'mallory', grants: []});
    const missing = imagesApi.objectRef(IMAGE, 'smalltalk/class/NeverDeclared');

    const outcomes = [];
    for (const classRef of [t.importedClassRef, missing]) {
      const presentation = await t.browser.browse(
        createNativeClassSubject({imageId: IMAGE, classRef}), {authority: nothing},
      );
      outcomes.push(t.browser.toPresentationDescriptor(presentation));
    }
    // Identical apart from the objectId the CALLER supplied, which discloses
    // nothing it did not already know. With an Environment-owned fixed reason
    // this holds by construction; the claim proven here is that the Environment
    // adds no oracle of its own on top of Images' authorize-before-existence.
    const blank = (descriptor) => JSON.parse(JSON.stringify({...descriptor, subject: {...descriptor.subject, objectId: null}}));
    assert.deepEqual(blank(outcomes[0]), blank(outcomes[1]));
    assert.equal(outcomes[0].kind, 'unauthorized-reference');
    assert.equal(outcomes[1].kind, 'unauthorized-reference');
  } finally {
    await t.runtime.close();
  }
});

test('an authorized read of a ref that is not a class is unavailable, and leaks no Images storage token', {skip}, async () => {
  const t = await setup();
  try {
    // The kernel's own nil: it exists, it is readable with its own grant, and it
    // is NOT a Behavior. Images answers with a message naming the Behavior SHAPE
    // id; nothing of that may reach a consumer.
    const kernel = await imagesApi.findSmalltalkKernel({images: t.runtime.images, imageId: IMAGE});
    const notAClass = kernel.nil;

    const presentation = await t.browser.browse(
      createNativeClassSubject({imageId: IMAGE, classRef: notAClass}),
      {authority: t.authorityFor(notAClass.objectId)},
    );

    assert.equal(presentation.kind, 'unavailable-reference',
      'authorized but not browsable is UNAVAILABLE, never "unauthorized"');
    const rendered = JSON.stringify(semanticUiForPresentation(
      t.browser.toPresentationDescriptor(presentation),
    ));
    for (const storageToken of ['smalltalk/behavior-shape', 'behavior-shape', 'behavior not found', 'method-dictionary']) {
      assert.equal(rendered.includes(storageToken), false,
        `the presented reason must not carry the Images storage token ${storageToken}: ${rendered}`);
    }
  } finally {
    await t.runtime.close();
  }
});

test('class-read authority yields selector NAMES and no method: the Environment cannot even ask', {skip}, async () => {
  const t = await setup();
  try {
    const presentation = await t.browser.browse(
      createNativeClassSubject({imageId: IMAGE, classRef: t.importedClassRef}),
      {authority: t.authorityFor(t.importedClassRef.objectId)},
    );
    const {smalltalkClass} = presentation.context;

    assert.deepEqual(smalltalkClass.selectors, ['baseValue']);
    // A description carries no method ref at any depth: `baseValue` is a NAME.
    const asText = JSON.stringify(smalltalkClass);
    assert.equal(asText.includes('smalltalk/block'), false, 'no Block ref is disclosed by class authority');
    assert.equal('method' in smalltalkClass, false);
    assert.equal('methods' in smalltalkClass, false);

    // E1 asserted this structurally — the adapter exposed no method seam at all,
    // so the Block was unreachable by construction. E2 adds that seam, so the
    // guarantee is now the one that actually matters and survives having a
    // method reader in the codebase: browsing a CLASS reaches no method, and the
    // method seam is a SEPARATE call that authorizes the Block independently
    // (proven directly by 'class-read authority alone does not yield the Block').
    assert.equal(typeof t.realAdapter.describeSmalltalkMethod, 'function',
      'E2 adds the method seam; the protection is the second authorization, not absence');
    // E1 bounded the adapter's ENTIRE method-shaped surface with a `some(/Method/)`
    // fence. E2 must not weaken that into "the one member we added exists": the
    // fence becomes an EXHAUSTIVE enumeration, so a later describeMethodDictionary,
    // readMethodBlock or installMethod cannot appear silently.
    // E3 (Bead eij.3) widens the enumeration to FOUR members and not one more:
    // E2's read-only description, its error mapping, and the writer-facing PAIR
    // -- the read that mints a position token and the replacement that consumes
    // one. Still no describeMethodDictionary, readMethodBlock, installMethod,
    // compileMethod or defineMethodsFromSource, which is exactly what an
    // exhaustive list (rather than a "the ones we added exist" check) protects.
    assert.deepEqual(
      Object.keys(t.realAdapter).filter((key) => /Method/.test(key)).sort(),
      [
        'classifySmalltalkMethodReadError',
        'describeSmalltalkMethod',
        'readSmalltalkMethodForUpdate',
        'replaceSmalltalkMethod',
      ],
      'the adapter exposes exactly the E2 read + its error mapping + the E3 writer-facing pair',
    );
    // Browsing the class made exactly ONE seam call, and it was the CLASS one:
    // presenting a class never reaches the method reader, by accident or design.
    assert.equal(t.adapter.seamCalls.length, 1);
    assert.deepEqual(Object.keys(t.adapter.seamCalls[0]).sort(), ['authority', 'classRef', 'imageId'],
      'the class read carries no selector, so it cannot have resolved a method');
    // And the Environment composes no method id anywhere: the Block ref is
    // Images-owned and only the authorized method read discloses it.
    assert.equal(JSON.stringify(presentation.context).includes('/method/'), false);
  } finally {
    await t.runtime.close();
  }
});

// ---------------------------------------------------------------------------
// E2 SLICE A: the native METHOD read is a SECOND, independent authorization.
// ---------------------------------------------------------------------------

test('class-read authority alone does not yield the Block; the method grant does', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    const subject = createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'});

    // (1) With ONLY the class grant — which already DISPLAYS the selector — the
    // method read is refused. This is the whole point of the second seam.
    const classOnly = await t.browser.browseMethod(subject, {authority: t.authorityFor(classRef.objectId)});
    assert.equal(classOnly.kind, 'unauthorized-reference',
      'class-read authority may show that baseValue exists; it must not reveal the Block behind it');
    assert.equal(classOnly.context.reason, 'not authorized to read this native method');

    // The Environment cannot even name the Block yet: nothing in the failure
    // presentation carries a method id.
    assert.equal(JSON.stringify(classOnly.context).includes('/method/'), false,
      'a denied method read discloses no Block locator');

    // (2) Images owns the Block ref. The test learns it from Images' OWN binding
    // enumeration — never by composing an id — and only to assert equality.
    const [binding] = await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef});
    assert.equal(binding.selector, 'baseValue');

    const granted = await t.browser.browseMethod(subject, {
      authority: t.authorityForMethod({classRef, selector: 'baseValue', objectIds: [classRef.objectId]}),
    });
    assert.equal(granted.kind, NATIVE_METHOD_PRESENTATION_KIND);
    const {smalltalkMethod} = granted.context;
    assert.equal(smalltalkMethod.format, 'smalltalk-method-description/v1');
    assert.equal(smalltalkMethod.selector, 'baseValue');
    assert.equal(smalltalkMethod.side, 'instance');
    assert.deepEqual(smalltalkMethod.class, classRef, 'the DECLARING class, not a receiver');
    assert.deepEqual(smalltalkMethod.method, binding.method, 'the exact Block Images has bound');
    // Truthful absences, preserved as null rather than invented or omitted from
    // the record (the PROJECTION omits their rows; the record keeps the fact).
    assert.equal(smalltalkMethod.source, null);
    assert.equal(smalltalkMethod.provenance, null);

    // The description is Images' object, by identity — not a copy.
    const descriptor = t.browser.toPresentationDescriptor(granted);
    assertDataRepresentable(descriptor, 'presentationDescriptor');
    assert.equal(descriptor.parameters.smalltalkMethod, smalltalkMethod);

    // Origin-blindness for the METHOD is asserted STRUCTURALLY, not by substring
    // scan. A scan over `selector` and `side` would be theatre — both are pinned
    // to exact values three lines above — and a scan over the Block id would be
    // WORSE than useless: it is base64url over caller-chosen content, so a short
    // token like 'oop' can appear there by chance (Bead bus). What actually
    // carries origin-blindness is that every field is pinned by identity to what
    // Images returned, and that the record has no field to smuggle origin in.
    assert.deepEqual(Object.keys(smalltalkMethod).sort(),
      ['class', 'format', 'method', 'provenance', 'selector', 'side', 'source'],
      'no extra field smuggles origin or storage into the record');
  } finally {
    await t.runtime.close();
  }
});

test('the Block ref comes from Images and is NOT derivable from the class ref and selector', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    // A FIRST definition's Block id is `<classId>/method/<b64url(selector)>` —
    // derivable from exactly what the Environment holds. Asserting against that
    // would be green even for an implementation that composed the id locally and
    // never called the seam. REDEFINING the method is what makes the assertion
    // discriminating: the bound ref then carries a `/revision/` segment over the
    // compiled program, which {classRef, selector} cannot produce.
    //
    // reconcileMethodsFromSource is the only redefinition path reachable FROM
    // SOURCE (defineMethods/defineMethodsFromSource set allowRedefinition:false
    // and throw; reconcileMethods is its program-form sibling). It is IMAGES-owned
    // test setup, not Environment method editing, which stays out of E2.
    const [before] = await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef});
    await imagesApi.reconcileMethodsFromSource({
      images: t.runtime.images, compilation: t.runtime.compilation, imageId: IMAGE, classRef,
      methods: [{selector: 'baseValue', source: '[ ^7 ]'}],
    });
    const [after] = await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef});
    assert.notDeepEqual(after.method, before.method, 'the redefinition actually rebound the selector');
    assert.ok(after.method.objectId.includes('/revision/'),
      `a redefinition must produce a revision id, got ${after.method.objectId}`);

    // The authority names the LOGICAL POSITION, not a revision. It was MINTED
    // BEFORE the redefinition existed -- from {imageId, classRef, selector} and
    // nothing else -- which is exactly the property Images ccd8321 (#231) added
    // and the reason a caller never has to predict a Block id.
    const positionAuthority = t.authorityForMethod({
      classRef, selector: 'baseValue', objectIds: [classRef.objectId],
    });
    const presentation = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}),
      {authority: positionAuthority},
    );
    assert.deepEqual(presentation.context.smalltalkMethod.method, after.method,
      'the description carries the ref Images has bound NOW, which no local derivation could have produced');
    assert.notDeepEqual(presentation.context.smalltalkMethod.method, before.method,
      'and the position grant followed the selector ACROSS the revision, which is the point of it');

    // REPLACES the old "a stale Block grant no longer opens the method" negative,
    // whose premise the repaired contract removed: a position grant deliberately
    // survives A -> B, so there is no longer any such thing as a stale one.
    // The property that MUST still hold is the other half -- generic Block
    // authority is not accepted for a semantic method read, in either direction.
    const blockGrantOnly = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}),
      {authority: t.authorityFor(classRef.objectId, after.method.objectId)},
    );
    assert.equal(blockGrantOnly.kind, 'unauthorized-reference',
      'object/read on the CURRENT Block does not authorize the semantic method read');
    const staleBlockGrantOnly = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}),
      {authority: t.authorityFor(classRef.objectId, before.method.objectId)},
    );
    assert.equal(staleBlockGrantOnly.kind, 'unauthorized-reference',
      'nor does object/read on a superseded revision');
  } finally {
    await t.runtime.close();
  }
});

test('the method seam is no existence oracle, and its licensed distinction is honest', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    const nothing = t.runtime.authority.issue({principal: 'mallory', grants: []});
    const classOnly = t.authorityFor(classRef.objectId);

    // WITHOUT class authority: an implemented and an unimplemented selector are
    // the IDENTICAL unauthorized outcome. Images authorizes the class before it
    // resolves anything, so nothing about existence leaks.
    const deniedImplemented = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}), {authority: nothing});
    const deniedMissing = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'neverImplemented'}), {authority: nothing});
    // Compare the WHOLE rendered documents. A hand-picked projection of
    // {kind, reason, objectId} would reduce to `kind === kind`, because the
    // reason is a constant selected BY kind and the objectId is the class's by
    // construction — it would advertise coverage it does not have.
    assert.deepEqual(
      semanticUiForPresentation(t.browser.toPresentationDescriptor(deniedImplemented)),
      semanticUiForPresentation(t.browser.toPresentationDescriptor(deniedMissing)),
      'an implemented and an unimplemented selector are byte-identical without class authority',
    );
    assert.equal(deniedImplemented.kind, 'unauthorized-reference');

    // WITH CLASS AUTHORITY ALONE the two are now IDENTICAL too, and this is a
    // STRENGTHENING that Images ccd8321 (#231) brought: the method-position check
    // happens BEFORE any selector resolution, so a caller holding only the class
    // cannot tell an implemented selector from an unimplemented one either.
    // Before the repair, class authority alone answered `unavailable` for a
    // missing selector and `unauthorized` for an implemented one -- licensed at
    // the time, because a class read had already listed every selector, but a
    // distinction all the same. It is gone.
    const missingClassOnly = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'neverImplemented'}), {authority: classOnly});
    const unreadableBlock = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}), {authority: classOnly});
    assert.equal(unreadableBlock.kind, 'unauthorized-reference',
      'an implemented selector is unauthorized without the method-position grant');
    assert.equal(missingClassOnly.kind, 'unauthorized-reference',
      'and so is an unimplemented one: the position check precedes resolution');
    assert.deepEqual(
      semanticUiForPresentation(t.browser.toPresentationDescriptor(missingClassOnly)),
      semanticUiForPresentation(t.browser.toPresentationDescriptor(unreadableBlock)),
      'byte-identical documents: class authority alone is no existence oracle either',
    );

    // The licensed distinction MOVED rather than vanished: it now requires the
    // POSITION grant, which a caller can mint for any {class, selector} pair
    // without reading anything. Holding it, an unimplemented selector is honestly
    // `unavailable` -- and that still discloses nothing a class read did not,
    // because the class description already listed every selector it implements.
    // Recorded on Bead azj as a collapsed cause.
    const missing = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'neverImplemented'}),
      {authority: t.authorityForMethod({classRef, selector: 'neverImplemented', objectIds: [classRef.objectId]})},
    );
    assert.equal(missing.kind, 'unavailable-reference',
      'a selector the class does not implement is unavailable to a caller authorized for that position');

    // Every failure reason is one of this module's own two constants — never an
    // Images message, which is what could carry a storage id. Asserted by
    // equality rather than by scanning for tokens the fixed strings obviously
    // do not contain.
    assert.equal(missing.context.reason, 'this native method could not be read');
    assert.equal(unreadableBlock.context.reason, 'not authorized to read this native method');
    assert.equal(deniedImplemented.context.reason, 'not authorized to read this native method');
  } finally {
    await t.runtime.close();
  }
});

// ---------------------------------------------------------------------------
// E2 SLICE B CENTRAL ACCEPTANCE (Bead gzz): a real live native-class view, a
// real host realization, the ONE activation owner, and a fresh independently
// authorized method read — against the REAL Images runtime.
//
// The host here is the headless fake renderer with the REAL projector injected:
// it projects on attach and emits the key IT REALIZED. That is the only lane
// where a real Images authority rule, a real Compositor and a real intent path
// meet — the native lane cannot install a selector at all (Bead aov).
// ---------------------------------------------------------------------------

// A bounded poll on the OBSERVABLE rather than a fixed sleep. For a positive
// assertion a short sleep merely fails loudly; for a NEGATIVE ("nothing moved")
// a too-short sleep passes for the wrong reason.
async function settleUntil(predicate, what, deadlineMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

// For a negative, let the activation lane drain and then assert nothing moved.
const drain = () => new Promise((r) => setTimeout(r, 50));

async function openNativeVertical(t) {
  const rendererAdapter = createFakeRendererAdapter({projector: projectSemanticUi});
  const compositor = createCompositor({rendererAdapter});
  const presentationRegistry = registryFor();
  const browser = createNativeSmalltalkBrowser({adapter: t.adapter, presentationRegistry, compositor});

  // A real shell over a real ObjectNavigator, so the generic-selection negative
  // is asserted against the thing that would actually move.
  const navigator = createObjectNavigator({
    adapter: {readObject: async () => { throw new Error('the native lane must not read generic objects'); }},
    presentationRegistry,
    commandRegistry: createCommandRegistry(),
    referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const shell = createEnvironmentShell({navigator, selectionModel, compositor});

  const grants = [];
  const authorityFor = (target) => {
    // Fresh per navigation action, from the composition's own provider — never
    // inherited from the subject, the descriptor or the shell.
    //
    // Images ccd8321 (#231): a METHOD target's authority is now built from the
    // public semantic locator -- {imageId, classRef, selector} -- through the
    // method-position vocabulary. The Block id `boundBlockFor` still supplies is
    // now REDUNDANT and is kept here only so this admission slice changes the
    // authority CONSTRUCTION and nothing else; deleting that bootstrap, and
    // proving a first read needs no Block identity at all, belongs to the E3
    // slice.
    const ids = [target.classRef.objectId];
    if (target.kind === 'native-method') {
      const bound = t.boundBlockFor?.(target);
      if (bound) ids.push(bound);
    }
    const authority = target.kind === 'native-method' && !t.withholdMethodPositionGrant
      ? t.authorityForMethod({classRef: target.classRef, selector: target.selector, objectIds: ids})
      : t.authorityFor(...ids);
    grants.push({target, ids, authority});
    return authority;
  };

  // E3 (Bead eij.3): the ORDINARY Command lane, wired exactly as any other --
  // a registry the composition registers into, the real CommandRouter, and the
  // adapter's ordinary authorized dispatch seam. Nothing here is native-specific
  // except the Command the browser owner supplies.
  const commandRegistry = createCommandRegistry();
  commandRegistry.register(createReplaceNativeMethodCommand());
  const writeDemands = [];
  const commandRouter = createCommandRouter({
    compositor,
    commandRegistry,
    // The REAL adapter's ordinary authorized dispatch seam. Deliberately not the
    // recording spy: the Command must receive the real ImageClientAdapter, which
    // is what carries the one authorized replacement seam. What the replacement
    // did is asserted against IMAGES' own state below, not against a spy.
    dispatch: t.realAdapter.dispatch,
    // FRESH per invocation, from the composition. It names the DECLARING CLASS
    // for object/write, which is the only thing Images demands -- never the Block,
    // and never anything derived from the token.
    authorityProvider: async (demand) => {
      writeDemands.push(demand);
      const subject = demand.subject;
      const authority = t.writeAuthorityFor
        ? t.writeAuthorityFor(subject)
        : t.runtime.authority.issue({
          principal: 'alice',
          grants: [{operation: imagesApi.OBJECT_WRITE_OPERATION, resource: imagesApi.objectResource(IMAGE, subject.classRef.objectId)}],
        });
      return authority;
    },
  });

  const activationErrors = [];
  const replacementErrors = [];
  shell.bindIntents({
    adapter: rendererAdapter,
    commandRouter,
    activationBindings: [browser.activationBinding({authorityFor})],
    inputBindings: [browser.replacementInputBinding({
      authorityFor,
      onReplacementError: (error) => replacementErrors.push(error),
    })],
    onActivateError: (error) => activationErrors.push(error),
  });
  return {
    rendererAdapter, compositor, browser, shell, selectionModel, grants,
    activationErrors, replacementErrors, commandRegistry, commandRouter, writeDemands,
  };
}

test('E2 acceptance: a live native-class view activates a selector into a freshly authorized method read', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;

    // (0) REDEFINITION FIRST, so the current Block is a `/revision/` id that
    // {classRef, selector} cannot produce. A locally composed id must not be
    // able to reach it — that is what makes the whole renderer -> method path
    // discriminating rather than just Slice A's API test.
    const [before] = await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef});
    await imagesApi.reconcileMethodsFromSource({
      images: t.runtime.images, compilation: t.runtime.compilation, imageId: IMAGE, classRef,
      methods: [{selector: 'baseValue', source: '[ ^7 ]'}],
    });
    const [current] = await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef});
    assert.ok(current.method.objectId.includes('/revision/'));
    assert.notDeepEqual(current.method, before.method);
    t.boundBlockFor = (target) => (target.selector === 'baseValue' ? current.method.objectId : null);

    const v = await openNativeVertical(t);

    // (1) open a real native-class view through the Compositor.
    await v.browser.open(createNativeClassSubject({imageId: IMAGE, classRef}), {
      authority: t.authorityFor(classRef.objectId),
      viewDescriptor: {kind: 'surface', width: 200, height: 200},
    });
    const handle = v.compositor.surfaceHandleForView(v.browser.viewId);

    // (2) the host REALIZED selector and class-locator actions.
    const actions = v.rendererAdapter.realizedActions(handle);
    assert.deepEqual(actions.map((a) => a.label),
      ['baseValue', `superclass -> ${IMAGE}/smalltalk/class/Object`, `class-side -> ${IMAGE}/smalltalk/metaclass/BrowseImported`]);
    // (3) every action carries ONLY a descriptor-local integer key.
    for (const action of actions) assert.deepEqual(Object.keys(action).sort(), ['key', 'kind', 'label']);
    assert.deepEqual(actions.map((a) => a.key), [0, 1, 2], 'ONE key space across both groups');

    const selectionBefore = v.selectionModel.selectedSubject();

    // (4)(5)(6)(7)(8) press the realized SELECTOR row: the host emits only the
    // key it realized, the shell resolves the handle to the live view and picks
    // its one binding, the browser-owned array resolves the key to the existing
    // native-method subject, and the browser performs a fresh method browse.
    const intent = v.rendererAdapter.activateAction(handle, 0);
    assert.deepEqual(intent, {kind: 'activate-item', key: 0});
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor.kind === 'native-method',
      'the selector activation to present a native method',
    );
    assert.deepEqual(v.activationErrors, []);

    // (10)(11) the SAME logical view now presents the native method, and it is
    // the CURRENT revision — reached through Images, not composed here.
    const live = v.compositor.liveView(v.browser.viewId);
    assert.equal(live.presentationDescriptor.kind, 'native-method');
    assert.deepEqual(live.presentationDescriptor.parameters.smalltalkMethod.method, current.method);
    assert.equal(live.presentationDescriptor.parameters.smalltalkMethod.selector, 'baseValue');
    // The authority used was FRESH and named the current Block, not the class alone.
    const methodGrant = v.grants.find((g) => g.target.kind === 'native-method');
    assert.deepEqual(methodGrant.ids, [classRef.objectId, current.method.objectId]);
    assert.equal(methodGrant.ids.includes(before.method.objectId), false,
      'the stale pre-redefinition Block is never what authority was sought for');

    // (14) NOTHING generic moved: this was navigation, not selection.
    assert.equal(v.selectionModel.selectedSubject(), selectionBefore);
    // (An assertion that no inspector view exists would be tautological here —
    // this composition never opens one. The real generic-state negative, with an
    // inspector actually live, is the never-skipped shell lane's.)

    await v.compositor.destroy();
  } finally {
    await t.runtime.close();
  }
});

test('E2 acceptance: class authority alone cannot open the method through the live view', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    // The composition supplies the CLASS grant only for a method target: the
    // second authorization is the one that must fail. Under Images ccd8321 (#231)
    // that second check is `smalltalk-method/read` on the logical position rather
    // than `object/read` on the Block, so withholding the POSITION grant is what
    // makes this negative test the same test it always was.
    t.boundBlockFor = () => null;
    t.withholdMethodPositionGrant = true;
    const v = await openNativeVertical(t);
    await v.browser.open(createNativeClassSubject({imageId: IMAGE, classRef}), {
      authority: t.authorityFor(classRef.objectId),
      viewDescriptor: {kind: 'surface', width: 200, height: 200},
    });
    const handle = v.compositor.surfaceHandleForView(v.browser.viewId);
    v.rendererAdapter.activateAction(handle, 0);
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor.kind !== 'native-class',
      'the denied method activation to re-present',
    );

    const live = v.compositor.liveView(v.browser.viewId);
    assert.equal(live.presentationDescriptor.kind, 'unauthorized-reference',
      'class-read authority displays the selector but never opens the Block behind it');
    const rendered = JSON.stringify(projectSemanticUi(live.presentationDescriptor));
    assert.equal(rendered.includes('/method/'), false, 'no Block locator is disclosed by the denial');
    await v.compositor.destroy();
  } finally {
    await t.runtime.close();
  }
});

test('E2 acceptance: a class locator activates into a freshly authorized class read on the same view', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    const v = await openNativeVertical(t);
    await v.browser.open(createNativeClassSubject({imageId: IMAGE, classRef}), {
      authority: t.authorityFor(classRef.objectId),
      viewDescriptor: {kind: 'surface', width: 200, height: 200},
    });
    const handle = v.compositor.surfaceHandleForView(v.browser.viewId);
    const before = v.compositor.liveView(v.browser.viewId).presentationDescriptor;

    // (11)(12)(13) press the SUPERCLASS row (key 1 — after the selector, which
    // is exactly the offset a per-group key space would get wrong).
    const superclassAction = v.rendererAdapter.realizedActions(handle)[1];
    assert.match(superclassAction.label, /^superclass -> /);
    v.rendererAdapter.activateAction(handle, 1);
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor !== before,
      'the class locator activation to re-present',
    );
    assert.deepEqual(v.activationErrors, []);

    const live = v.compositor.liveView(v.browser.viewId);
    assert.equal(live.presentationDescriptor.kind, 'native-class');
    assert.equal(live.presentationDescriptor.parameters.smalltalkClass.name, 'Object',
      'the SAME logical view now presents the target class');
    assert.notEqual(live.presentationDescriptor, before, 'a new snapshot was presented, not a mutation');
    // The target was a native-class SUBJECT, and fresh authority was sought for it.
    const classGrant = v.grants.find((g) => g.target.kind === 'native-class');
    assert.deepEqual(classGrant.ids, [before.parameters.smalltalkClass.superclass.objectId]);
    assert.equal(v.selectionModel.selectedSubject(), null, 'a locator is not a selection gesture');
    await v.compositor.destroy();
  } finally {
    await t.runtime.close();
  }
});

test('E2 acceptance: a re-opened view keeps its binding under a NEW handle; the old one routes nowhere', {skip}, async () => {
  const t = await setup();
  try {
    const classRef = t.importedClassRef;
    t.boundBlockFor = () => null;
    const v = await openNativeVertical(t);
    const subject = createNativeClassSubject({imageId: IMAGE, classRef});
    const viewDescriptor = {kind: 'surface', width: 200, height: 200};
    await v.browser.open(subject, {authority: t.authorityFor(classRef.objectId), viewDescriptor});
    const firstHandle = v.compositor.surfaceHandleForView(v.browser.viewId);

    // (15) close and re-open the SAME logical view -> a NEW renderer handle.
    await v.compositor.closeView(v.browser.viewId);
    await v.browser.open(subject, {authority: t.authorityFor(classRef.objectId), viewDescriptor});
    const secondHandle = v.compositor.surfaceHandleForView(v.browser.viewId);
    assert.notEqual(secondHandle, firstHandle);

    // (16) the view-keyed binding still routes, with NO rebind...
    v.rendererAdapter.activateAction(secondHandle, 1);
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor.parameters.smalltalkClass?.name === 'Object',
      'the re-opened view to route its activation',
    );
    assert.deepEqual(v.activationErrors, []);

    // (17) ...and the STALE handle carries nothing to activate: closing the view
    // destroyed its surface, so the host has no realization for it any more.
    // NOTE what this does and does not prove: the intent is never emitted, so the
    // Compositor's handle -> live view guard is not what is exercised here. That
    // guard has its own never-skipped proof in test/environment-shell.test.js
    // ('a DELEGATED binding survives close + re-open', and the older ref twin).
    const settled = v.compositor.liveView(v.browser.viewId).presentationDescriptor;
    assert.throws(() => v.rendererAdapter.activateAction(firstHandle, 1), /no realized action/);
    await drain();
    assert.equal(v.compositor.liveView(v.browser.viewId).presentationDescriptor, settled, 'nothing moved');
    await v.compositor.destroy();
  } finally {
    await t.runtime.close();
  }
});


// ---------------------------------------------------------------------------
// E3 (Bead eij.3): REPLACE one imported native method through the ORDINARY
// authorized Command lane.
//
// The vertical under proof, end to end and with nothing stubbed in the middle:
//
//   realized SemanticUi/v2 input  ->  submit-input intent (key + text only)
//   ->  EnvironmentShell input binding  ->  transient position token
//   ->  CommandRouter (explicit commandId)  ->  authorityProvider (fresh)
//   ->  CommandDispatcher  ->  replace-native-method Command
//   ->  ImageClientAdapter.replaceSmalltalkMethod
//   ->  Images' authorizedReplaceSmalltalkMethod (the ONE authorized write).
//
// THE CONSUMER'S AUTHORITY IS FIXED BEFORE THE OPERATION, and this is the whole
// discipline of this fixture. A first draft of it staged the future replacements
// up front, learned their Block ids through Images-private helpers, moved the
// binding back, and PRE-GRANTED `object/read` on every id the user flow would
// later land on. That staged data legitimately -- and then handed the acceptance
// FUTURE AUTHORITY INFORMATION the production Environment can neither derive nor
// obtain. It made "the fresh reread works" true only because the fixture knew
// every future Block id, which is exactly the wrong implementation these proofs
// must reject. An adversarial review caught it; the pre-staging is gone.
//
// What a composition may legitimately hold before a replacement:
//   * `object/read` on the declaring Class -- from browsing it;
//   * `object/read` on the Block CURRENTLY bound -- the one the authorized method
//     read it is displaying already disclosed;
//   * `object/write` on the declaring Class -- what the replacement demands.
// Nothing may name a Block that does not exist yet, because nothing could.
//
// (The first grant of the pair is staged here, as a deployment's policy would
// already have issued it for the method being browsed. That pre-existing E2-era
// circularity -- a method read needs the Block grant that only a method read
// discloses -- is not what these proofs are about; the FUTURE id is.)
const SOURCE_C = '[ ^22 ]';
const SOURCE_D = '[ ^33 ]';

async function e3Setup() {
  const t = await setup();
  const classRef = t.importedClassRef;
  const selector = 'baseValue';
  const writeAuthority = t.runtime.authority.issue({
    principal: 'alice',
    grants: [{operation: imagesApi.OBJECT_WRITE_OPERATION, resource: imagesApi.objectResource(IMAGE, classRef.objectId)}],
  });

  // THE TEST'S OWN OBSERVATION, never the consumer's. An observer standing
  // outside the Environment may look at Images however it likes; what it must not
  // do is feed that knowledge into the composition's authority, and it does not.
  const boundNow = async () => (
    await imagesApi.methodBindings({images: t.runtime.images, imageId: IMAGE, classRef})
  ).find((b) => b.selector === selector).method;
  const observeMethod = async () => t.realAdapter.describeSmalltalkMethod({
    imageId: IMAGE, classRef, selector,
    authority: t.authorityFor(classRef.objectId, (await boundNow()).objectId),
  });

  // A replacement performed OUTSIDE the Environment's interaction path, through
  // the same public seams: this is "someone else", the second client whose write
  // makes the user's observation stale.
  const replaceOutside = async (source) => {
    const current = await boundNow();
    const read = await t.realAdapter.readSmalltalkMethodForUpdate({
      imageId: IMAGE, classRef, selector, authority: t.authorityFor(classRef.objectId, current.objectId),
    });
    await t.realAdapter.replaceSmalltalkMethod({
      imageId: IMAGE, classRef, selector, source, versionToken: read.versionToken, authority: writeAuthority,
    });
    return boundNow();
  };

  // The ONE Block the composition may read: the one bound right now, which is
  // what it is about to display. No future id appears anywhere in this grant.
  const displayed = await boundNow();
  t.boundBlockFor = (target) => (target.selector === selector ? displayed.objectId : null);

  return {t, classRef, selector, writeAuthority, boundNow, observeMethod, replaceOutside, displayed};
}

// Open the method view the way a user reaches it: browse the class, press the
// realized selector row. E2 proves that leg; here it is the PRECONDITION, so the
// replacement is proven against the descriptor the renderer actually realized.
async function openMethodView(e3) {
  const v = await openNativeVertical(e3.t);
  await v.browser.open(createNativeClassSubject({imageId: IMAGE, classRef: e3.classRef}), {
    authority: e3.t.authorityFor(e3.classRef.objectId),
    viewDescriptor: {kind: 'surface', width: 200, height: 200},
  });
  const handle = v.compositor.surfaceHandleForView(v.browser.viewId);
  v.rendererAdapter.activateAction(handle, 0);
  await settleUntil(
    () => v.compositor.liveView(v.browser.viewId).presentationDescriptor.kind === NATIVE_METHOD_PRESENTATION_KIND,
    'the selector activation to present a native method',
  );
  assert.deepEqual(v.activationErrors, []);
  return {v, handle};
}

test('E3: a realized input replaces the method through the ordinary Command lane -- and the MANDATED FRESH REREAD IS UNOBTAINABLE (Images #218, eij.3 BLOCKED)', {skip}, async () => {
  const e3 = await e3Setup();
  const {t, classRef, selector} = e3;
  try {
    const {v, handle} = await openMethodView(e3);

    // (1) THE AFFORDANCE IS REALIZED, and carries only what a renderer may see.
    const inputs = v.rendererAdapter.realizedInputs(handle);
    assert.equal(inputs.length, 1, 'exactly one transient input on a displayed method');
    assert.deepEqual(inputs[0], {
      kind: 'input', key: 0, label: 'New source', valueKind: 'text', submitLabel: 'Replace',
    });
    assert.equal(JSON.stringify(inputs).includes('native-method-source'), false,
      'the semantic ROLE stays with the Environment: the renderer never learns what an input MEANS');
    const before = v.compositor.liveView(v.browser.viewId).presentationDescriptor;
    assert.deepEqual(before.parameters.smalltalkMethod.method, e3.displayed, 'the view shows the CURRENT revision');
    assert.equal(before.parameters.smalltalkMethod.source, null, 'Images keeps no source, before');

    // (2) THE USER SUBMITS. The host emits the key it realized plus the text; it
    // names no Command, no subject, no token and no method.
    const intent = v.rendererAdapter.submitInput(handle, 0, SOURCE_C);
    assert.deepEqual(intent, {kind: 'submit-input', key: 0, text: SOURCE_C});
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor !== before,
      'the replacement to complete and the view to be re-presented',
    );

    // (3) EXACTLY ONE AUTHORIZED INVOCATION, named by the Command that ran. The
    // router builds the demand from the SELECTED command id, so it can never name
    // a Command other than the one dispatched.
    assert.equal(v.writeDemands.length, 1);
    assert.equal(v.writeDemands[0].commandId, 'replace-native-method');
    assert.deepEqual(v.writeDemands[0].subject, createNativeMethodSubject({imageId: IMAGE, classRef, selector}));
    // The demand carries the SEMANTIC intent descriptor and no user text: what is
    // authorized is "this Command on this subject", never the argument bag.
    assert.deepEqual(v.writeDemands[0].intent, {kind: 'submit-input', key: 0});
    assert.equal(JSON.stringify(v.writeDemands[0]).includes(SOURCE_C), false,
      'the supplied source must not travel inside an authority demand');

    // (4) THE WRITE LANDED. Observed from OUTSIDE the Environment: the method's
    // semantic identity is unchanged -- same class, same selector -- and its
    // revision is new. Everything up to and including the authorized write works.
    const replaced = await e3.boundNow();
    assert.notDeepEqual(replaced, e3.displayed, 'Images rebound the selector to a fresh revision');
    assert.equal((await e3.observeMethod()).source, null, 'and still keeps no source afterwards');

    // (5) THE BLOCKER. #218 point 4 makes a FRESH AUTHORIZED READ the displayed
    // truth, and the Environment cannot perform one. Images' method read demands
    // `object/read` on the CURRENT Block; that Block did not exist when any
    // authority could have been issued, its id is deliberately not disclosed by
    // the `{replaced:true}` receipt, and the AuthorityService accepts only exact
    // `{operation, resource}` grants -- no wildcard, no inheritance, no resource
    // tree. So the reread is DENIED and the view falls back to the ordinary
    // unauthorized route.
    //
    // This is the honest current outcome, asserted rather than engineered away.
    // When Images repairs the lower contract, THIS assertion is what changes: the
    // live descriptor becomes the authoritative new method, reached without
    // predicting its Block identity.
    const after = v.compositor.liveView(v.browser.viewId).presentationDescriptor;
    assert.equal(after.kind, 'unauthorized-reference',
      'the mandated fresh reread is unobtainable: it needs read authority for a Block id that could not exist yet');
    assert.equal(after.parameters.reason, 'not authorized to read this native method');
    assert.equal(after.subject.objectId, classRef.objectId,
      'and the failure names the CLASS the caller already reads, never the Block it may not');

    // AND IT IS SILENT. The reread failure is a PRESENTED failure, not a rejection,
    // so no error reaches the composition's channel: a user who pressed Replace
    // sees the method they were editing turn into "not authorized" with nothing
    // said. That silence is part of the defect, and part of what the repair must
    // remove.
    assert.deepEqual(v.replacementErrors, []);

    // NOT A WORKAROUND, asserted as a rule rather than left to review: the
    // Environment must not reach the new revision by predicting it. The supplied
    // source never becomes displayed state, and no Block id is composed here.
    assert.equal(JSON.stringify(after).includes(SOURCE_C), false);
    assert.equal(JSON.stringify(after).includes(replaced.objectId), false,
      'the new Block id is not disclosed to the Environment anywhere');
  } finally {
    await t.runtime.close();
  }
});

test('E3: an overtaken observation is a CONFLICT -- refused and surfaced -- and its authoritative reread is UNOBTAINABLE too (eij.3 BLOCKED)', {skip}, async () => {
  const e3 = await e3Setup();
  const {t} = e3;
  try {
    const {v, handle} = await openMethodView(e3);
    const shown = v.compositor.liveView(v.browser.viewId).presentationDescriptor;
    assert.deepEqual(shown.parameters.smalltalkMethod.method, e3.displayed);

    // SOMEONE ELSE WINS while this view is open. The token paired with the
    // displayed descriptor now names a binding that is no longer current.
    const winner = await e3.replaceOutside(SOURCE_D);
    assert.notDeepEqual(winner, e3.displayed);

    v.rendererAdapter.submitInput(handle, 0, SOURCE_C);
    await settleUntil(() => v.replacementErrors.length > 0, 'the stale replacement to be refused');

    // The Environment's OWN conflict outcome: Images' SmalltalkStaleMethodPositionError
    // is a LOST UPDATE, so CommandDispatcher classifies it as one. This half works.
    assert.equal(v.replacementErrors[0].name, 'CommandConflictError');
    assert.deepEqual(await e3.boundNow(), winner, "the loser's source never became the binding");

    // The OTHER half does not. "Surfaced, then authoritatively reread" needs read
    // authority for the WINNER's Block -- another id the consumer could not have
    // been granted, for exactly the same reason. The repair is the same repair.
    await settleUntil(
      () => v.compositor.liveView(v.browser.viewId).presentationDescriptor !== shown,
      'the conflict to be followed by a reread attempt',
    );
    const after = v.compositor.liveView(v.browser.viewId).presentationDescriptor;
    assert.equal(after.kind, 'unauthorized-reference',
      'after a lost update the winner cannot be displayed either');
    assert.equal(JSON.stringify(after).includes(winner.objectId), false,
      "and the winner's Block id is not disclosed by the refusal");
  } finally {
    await t.runtime.close();
  }
});

test('E3: a caller who may READ the method but not WRITE the class changes nothing, and its display is left alone', {skip}, async () => {
  const e3 = await e3Setup();
  const {t} = e3;
  try {
    // The composition mints an authority carrying the FULL read authority that
    // minted the token -- and no write. Holding a valid, current token confers
    // nothing: a token is an assumption about state, never a capability.
    //
    // This leg is UNAFFECTED by the reread blocker, and that is the point of
    // keeping it: a denial does not move the position, so no reread is owed, no
    // unknowable Block id is involved, and it proves the whole path on authority
    // the consumer legitimately holds.
    t.writeAuthorityFor = (subject) => t.authorityFor(subject.classRef.objectId, e3.displayed.objectId);
    const {v, handle} = await openMethodView(e3);
    const shown = v.compositor.liveView(v.browser.viewId).presentationDescriptor;

    v.rendererAdapter.submitInput(handle, 0, SOURCE_C);
    await settleUntil(() => v.replacementErrors.length > 0, 'the unauthorized replacement to be refused');

    assert.equal(v.replacementErrors[0].name, 'CommandAuthorizationError');
    assert.deepEqual(await e3.boundNow(), e3.displayed, 'a denied write changes nothing');
    await drain();
    // A denial is NOT a conflict: the observed position did not move, so the
    // descriptor on screen is still exactly what Images would answer, and
    // rereading would throw the user's attempt off the screen for no reason.
    assert.equal(v.compositor.liveView(v.browser.viewId).presentationDescriptor, shown,
      'the view is left alone; only a conflict earns an authoritative reread');
    assert.equal(v.replacementErrors.length, 1);
  } finally {
    await t.runtime.close();
  }
});
