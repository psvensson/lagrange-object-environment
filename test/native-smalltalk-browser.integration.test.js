import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createImageClientAdapter} from '../src/image-client-adapter.js';
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
  resolveNativeClassLocator,
} from '../src/native-smalltalk-browser.js';
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
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryFor()});
  const registry = registryFor();

  const grant = (objectId) => ({
    operation: imagesApi.OBJECT_READ_OPERATION,
    resource: imagesApi.objectResource(IMAGE, objectId),
  });
  const authorityFor = (...objectIds) => runtime.authority.issue({
    principal: 'alice', grants: objectIds.map(grant),
  });

  return {
    runtime,
    adapter,
    realAdapter,
    browser,
    registry,
    authorityFor,
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
        {smalltalkClass: presentation.context.smalltalkClass, locators: presentation.context.locators},
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
    // The locators are the description's own refs, in the browser's order.
    assert.deepEqual(imported.context.locators.map((l) => l.relation),
      [LOCATOR_RELATION.SUPERCLASS, LOCATOR_RELATION.CLASS_SIDE]);
    assert.deepEqual(imported.context.locators[0].ref, imported.context.smalltalkClass.superclass);
    assert.deepEqual(imported.context.locators[1].ref, imported.context.smalltalkClass.classSide);

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
    assert.deepEqual(resolveNativeClassLocator(descriptor, 0), superclass);
    assert.deepEqual(resolveNativeClassLocator(descriptor, 1), classSide);

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
    assert.deepEqual(
      Object.keys(t.realAdapter).filter((key) => /Method/.test(key)).sort(),
      ['classifySmalltalkMethodReadError', 'describeSmalltalkMethod'],
      'the adapter exposes exactly ONE method capability plus its error mapping',
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
      authority: t.authorityFor(classRef.objectId, binding.method.objectId),
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

    const presentation = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}),
      {authority: t.authorityFor(classRef.objectId, after.method.objectId)},
    );
    assert.deepEqual(presentation.context.smalltalkMethod.method, after.method,
      'the description carries the ref Images has bound NOW, which no local derivation could have produced');

    // The stale pre-redefinition Block grant no longer opens the method: authority
    // names an object, and the object changed.
    const stale = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}),
      {authority: t.authorityFor(classRef.objectId, before.method.objectId)},
    );
    assert.equal(stale.kind, 'unauthorized-reference');
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

    // WITH class authority the two DO differ — and that is licensed, not a leak:
    // the class description already listed every selector the class implements,
    // so "this class does not implement that selector" tells the caller nothing
    // a class read did not. Recorded on Bead azj as a collapsed cause.
    const missing = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'neverImplemented'}), {authority: classOnly});
    assert.equal(missing.kind, 'unavailable-reference',
      'a selector the class does not implement is unavailable, not unauthorized');
    const unreadableBlock = await t.browser.browseMethod(
      createNativeMethodSubject({imageId: IMAGE, classRef, selector: 'baseValue'}), {authority: classOnly});
    assert.equal(unreadableBlock.kind, 'unauthorized-reference',
      'an implemented selector whose Block the caller may not read is unauthorized');

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
