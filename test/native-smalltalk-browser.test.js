import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCATOR_RELATION,
  NATIVE_CLASS_PRESENTATION_KIND,
  NATIVE_CLASS_SUBJECT_KIND,
  NATIVE_METHOD_PRESENTATION_KIND,
  NATIVE_METHOD_SUBJECT_KIND,
  NativeClassPresentationError,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeMethodPresentationProvider,
  createNativeMethodSubject,
  createNativeSmalltalkBrowser,
  resolveNativeClassLocator,
} from '../src/native-smalltalk-browser.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {
  createUnauthorizedRefProvider,
  createUnavailableRefProvider,
} from '../src/object-presentation-providers.js';
import {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND} from '../src/object-navigator.js';
import {semanticUiForPresentation} from '../src/semantic-ui.js';
import {assertDataRepresentable} from '../src/compositor.js';
import {Presentation} from '../src/model.js';

// Unit proofs for the NativeSmalltalkBrowser (no image runtime). The real
// same-identity falsifier — a hand-authored native class and a Cuis-origin
// native-imported class through this one path — lives in
// native-smalltalk-browser.integration.test.js, against a real Images runtime.

const IMAGE = 'img';
const ref = (objectId) => Object.freeze({kind: 'ref', imageId: IMAGE, objectId});

const CLASS_REF = ref('smalltalk/class/BrowseChild');
const SUPER_REF = ref('smalltalk/class/BrowseBase');
const META_REF = ref('smalltalk/metaclass/BrowseChild');

// A canonical Images description. Built here as DATA the fake adapter returns;
// nothing in the browser may interpret it beyond selecting locator relations.
function description(overrides = {}) {
  return Object.freeze({
    format: 'smalltalk-class-description/v1',
    class: CLASS_REF,
    name: 'BrowseChild',
    side: 'instance',
    superclass: SUPER_REF,
    classSide: META_REF,
    layout: Object.freeze({instanceVariables: Object.freeze(['baseValue', 'childFirst']), indexed: 'none'}),
    selectors: Object.freeze(['childFirst', 'childSecond']),
    provenance: null,
    ...overrides,
  });
}

function registryWithNativeClass(extraProviders = []) {
  const registry = createPresentationRegistry();
  registry.register(createNativeClassPresentationProvider());
  registry.register(createNativeMethodPresentationProvider());
  for (const provider of extraProviders) registry.register(provider);
  registry.register(createUnavailableRefProvider());
  registry.register(createUnauthorizedRefProvider());
  return registry;
}

const SELECTOR = 'childFirst';
const BLOCK_REF = ref('smalltalk/class/BrowseChild/method/Y2hpbGRGaXJzdA');

// A canonical Images method description, as DATA the fake adapter returns.
function methodDescription(overrides = {}) {
  return Object.freeze({
    format: 'smalltalk-method-description/v1',
    class: CLASS_REF,
    side: 'instance',
    selector: SELECTOR,
    method: BLOCK_REF,
    source: null,
    provenance: null,
    ...overrides,
  });
}

function methodFakeAdapter({describeMethod, classifyMethod} = {}) {
  const calls = [];
  return {
    calls,
    describeSmalltalkClass: () => description(),
    classifySmalltalkClassReadError: (error) => (error?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable'),
    describeSmalltalkMethod(args) {
      calls.push(args);
      return describeMethod ? describeMethod(args) : methodDescription();
    },
    classifySmalltalkMethodReadError: classifyMethod
      ?? ((error) => (error?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable')),
  };
}

// A fake adapter with the same seam shape the real ImageClientAdapter exposes.
function fakeAdapter({describe, classify} = {}) {
  const calls = [];
  return {
    calls,
    describeSmalltalkClass(args) {
      calls.push(args);
      return describe ? describe(args) : description();
    },
    classifySmalltalkClassReadError: classify
      ?? ((error) => (error?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable')),
    describeSmalltalkMethod() { throw new TypeError('this fake adapter browses classes only'); },
    classifySmalltalkMethodReadError: (error) => (error?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable'),
  };
}

test('the native-class subject carries the EXACT Images ref and rejects a ref it cannot brow' +
  'se', () => {
  const subject = createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF});
  assert.equal(subject.kind, NATIVE_CLASS_SUBJECT_KIND);
  assert.equal(subject.classRef, CLASS_REF, 'the caller-supplied ref is carried by IDENTITY, never rebuilt');
  assert.ok(Object.isFrozen(subject));

  // A pinned-ref is refused HERE rather than at Images: the browse seam takes an
  // unpinned ref only, so letting one through would turn a caller mistake into
  // an "unavailable" presentation that reads like a missing class.
  assert.throws(
    () => createNativeClassSubject({imageId: IMAGE, classRef: {kind: 'pinned-ref', imageId: IMAGE, objectId: 'c', revision: 1}}),
    /unpinned \{kind: "ref"\} classRef/,
  );
  // A cross-image ref is a caller error, not a browse outcome.
  assert.throws(
    () => createNativeClassSubject({imageId: IMAGE, classRef: {kind: 'ref', imageId: 'other', objectId: 'c'}}),
    /classRef must name image img/,
  );
  assert.throws(() => createNativeClassSubject({imageId: IMAGE}), /unpinned/);
  assert.throws(() => createNativeClassSubject({classRef: CLASS_REF}), /imageId/);
});

test('browse makes ONE authorized adapter call with exactly the subject and threaded authority', async () => {
  const adapter = fakeAdapter();
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass()});
  const authority = Object.freeze({opaque: true});

  const presentation = await browser.browse(
    createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {authority},
  );

  assert.equal(adapter.calls.length, 1, 'exactly one authorized read per browse — no graph walk');
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), ['authority', 'classRef', 'imageId'],
    'the seam receives the subject and authority ONLY — no manifest, package, origin or provenance');
  assert.equal(adapter.calls[0].classRef, CLASS_REF, 'the exact ref crosses the seam');
  assert.equal(adapter.calls[0].authority, authority, 'authority is threaded per call');
  assert.equal(presentation.kind, NATIVE_CLASS_PRESENTATION_KIND);
});

test('the Images description is preserved BY IDENTITY; locators hold its own refs', async () => {
  const canonical = description();
  const adapter = fakeAdapter({describe: () => canonical});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass()});

  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));

  assert.equal(presentation.context.smalltalkClass, canonical,
    'the canonical description is the SAME object — never copied, normalized or re-shaped');
  assert.deepEqual(presentation.context.locators, [
    {relation: LOCATOR_RELATION.SUPERCLASS, ref: SUPER_REF},
    {relation: LOCATOR_RELATION.CLASS_SIDE, ref: META_REF},
  ]);
  assert.equal(presentation.context.locators[0].ref, SUPER_REF, 'locator refs are the description\'s own objects');
  assert.equal(presentation.context.locators[1].ref, META_REF);
});

test('a root class contributes no superclass locator and a Metaclass no class-side locator', async () => {
  const rootAdapter = fakeAdapter({describe: () => description({superclass: null})});
  const rootBrowser = createNativeSmalltalkBrowser({adapter: rootAdapter, presentationRegistry: registryWithNativeClass()});
  const root = await rootBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  // The kernel's nil TERMINATES the chain; a root class does not have a
  // superclass named "nil", so there is nothing to navigate to.
  assert.deepEqual(root.context.locators.map((l) => l.relation), [LOCATOR_RELATION.CLASS_SIDE]);

  const metaAdapter = fakeAdapter({describe: () => description({classSide: null})});
  const metaBrowser = createNativeSmalltalkBrowser({adapter: metaAdapter, presentationRegistry: registryWithNativeClass()});
  const meta = await metaBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  assert.deepEqual(meta.context.locators.map((l) => l.relation), [LOCATOR_RELATION.SUPERCLASS]);
});

test('browse requires EXACTLY ONE discovered presentation (a second provider is loud, never first-match)', async () => {
  // The registry returns providers in registration order. Taking [0] would let a
  // SECOND provider — the shape an origin-selecting route would take — pass
  // unnoticed. It must be a loud failure instead.
  const shadow = Object.freeze({
    id: 'shadow-native-class',
    present(subject) {
      if (!subject || subject.kind !== NATIVE_CLASS_SUBJECT_KIND) return null;
      return new Presentation({
        id: 'shadow', subject, kind: NATIVE_CLASS_PRESENTATION_KIND, context: {}, state: {},
      });
    },
  });
  const browser = createNativeSmalltalkBrowser({
    adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass([shadow]),
  });
  await assert.rejects(
    browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    (error) => error instanceof NativeClassPresentationError && /ambiguous native class presentations/.test(error.message),
  );

  const empty = createPresentationRegistry();
  const noneBrowser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: empty});
  await assert.rejects(
    noneBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    /no native class presentation was discovered/,
  );

  // A provider answering this subject with a DIFFERENT kind is the other shape
  // an origin-selected route could take. Candidates are selected by SUBJECT, so
  // it is caught here rather than silently filtered out by a kind check.
  const wrongKind = createPresentationRegistry();
  wrongKind.register(Object.freeze({
    id: 'origin-flavoured-class',
    present(subject) {
      if (!subject || subject.kind !== NATIVE_CLASS_SUBJECT_KIND) return null;
      return new Presentation({id: 'other', subject, kind: 'cuis-class', context: {}, state: {}});
    },
  }));
  const wrongKindBrowser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: wrongKind});
  await assert.rejects(
    wrongKindBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    /is cuis-class, not native-class/,
  );
});

test('the FAILURE path applies the same exactly-one rule (it does not take a first match either)', async () => {
  const denied = Object.assign(new Error('denied'), {name: 'AuthorityError'});
  const adapter = fakeAdapter({describe: () => { throw denied; }});

  // Two providers answering the same unauthorized subject: ambiguous, not first-match.
  const doubled = createPresentationRegistry();
  doubled.register(createUnauthorizedRefProvider());
  doubled.register(createUnauthorizedRefProvider());
  const doubledBrowser = createNativeSmalltalkBrowser({adapter, presentationRegistry: doubled});
  await assert.rejects(
    doubledBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    /ambiguous presentations for a unauthorized-ref native class read/,
  );

  // None at all is loud too, rather than returning undefined.
  const bare = createNativeSmalltalkBrowser({adapter, presentationRegistry: createPresentationRegistry()});
  await assert.rejects(
    bare.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    /no presentation was discovered for a unauthorized-ref native class read/,
  );
});

test('the provider refuses a description that is not its own subject\'s', () => {
  const provider = createNativeClassPresentationProvider();
  const subject = createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF});
  assert.equal(provider.present({kind: 'ref', imageId: IMAGE, objectId: 'x'}), null, 'disjoint by subject kind');
  assert.throws(() => provider.present(subject, {}), /canonical smalltalk-class-description\/v1/);
  assert.throws(
    () => provider.present(subject, {smalltalkClass: description({class: ref('smalltalk/class/Other')}), locators: []}),
    /description of ITS OWN subject/,
  );
  // The ordered locator list is the BROWSER's. The provider must not derive one
  // when it is missing: that would be a second locus for a list the ownership
  // registry gives to a single owner, and a silent one.
  assert.throws(
    () => provider.present(subject, {smalltalkClass: description()}),
    /browser-owned ordered locators array/,
  );
});

test('a denied read presents through the ORDINARY unauthorized route, with no Images message', async () => {
  const authorityError = Object.assign(new Error('not authorized: object/read on YXBw.c21hbGx0YWxr'), {name: 'AuthorityError'});
  const adapter = fakeAdapter({describe: () => { throw authorityError; }});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass()});

  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));

  assert.equal(presentation.kind, 'unauthorized-reference', 'the SAME presentation any denied object read gets');
  assert.equal(presentation.subject.kind, UNAUTHORIZED_REF_KIND);
  assert.equal(presentation.subject.objectId, CLASS_REF.objectId);
  assert.equal(presentation.context.reason, 'not authorized to read this native class');
  assert.equal(presentation.context.reason.includes('object/read'), false,
    'the Images message never reaches a consumer');
});

test('any other failure presents as unavailable and NEVER leaks an Images storage token', async () => {
  // The realistic leak: readBehavior naming the Behavior SHAPE id of a ref that
  // exists but is not a class. That message must not reach the UI one line after
  // this module promises to decode no storage.
  const notABehavior = new TypeError('not a smalltalk/behavior-shape/v1 behavior: smalltalk/class/BrowseChild');
  const adapter = fakeAdapter({describe: () => { throw notABehavior; }});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass()});

  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));

  assert.equal(presentation.kind, 'unavailable-reference');
  assert.equal(presentation.subject.kind, UNAVAILABLE_REF_KIND);
  assert.equal(presentation.context.reason, 'this native class could not be read');
  const rendered = JSON.stringify(semanticUiForPresentation({
    kind: presentation.kind, subject: presentation.subject, parameters: presentation.context,
  }));
  for (const storageToken of ['smalltalk/behavior-shape', 'behavior-', 'method-dictionary', 'instance-shape']) {
    assert.equal(rendered.includes(storageToken), false, `the rendered document must not carry ${storageToken}: ${rendered}`);
  }
});

test('the browser refuses an adapter without the interaction owner\'s error mapping', () => {
  const registry = createPresentationRegistry();
  assert.throws(
    () => createNativeSmalltalkBrowser({adapter: {describeSmalltalkClass: () => {}}, presentationRegistry: registry}),
    /describeSmalltalkMethod/,
  );
  assert.throws(
    () => createNativeSmalltalkBrowser({
      adapter: {describeSmalltalkClass: () => {}, describeSmalltalkMethod: () => {}},
      presentationRegistry: registry,
    }),
    /classifySmalltalkMethodReadError/,
  );
  assert.throws(
    () => createNativeSmalltalkBrowser({
      adapter: {describeSmalltalkClass: () => {}, describeSmalltalkMethod: () => {}, classifySmalltalkMethodReadError: () => {}},
      presentationRegistry: registry,
    }),
    /classifySmalltalkClassReadError/,
  );
  assert.throws(() => createNativeSmalltalkBrowser({adapter: {}, presentationRegistry: createPresentationRegistry()}), /describeSmalltalkClass/);
  assert.throws(() => createNativeSmalltalkBrowser({adapter: fakeAdapter()}), /PresentationRegistry/);
});

test('the presentationDescriptor survives the JSON round trip the native host performs', async () => {
  const browser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass()});
  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  const descriptor = browser.toPresentationDescriptor(presentation);

  // The Compositor's own admission check, called directly: E1 opens no view, so
  // this is the only thing proving the descriptor is data-representable.
  assertDataRepresentable(descriptor, 'presentationDescriptor');
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  assert.equal(descriptor.kind, NATIVE_CLASS_PRESENTATION_KIND);
  assert.equal(descriptor.subject.classRef.objectId, CLASS_REF.objectId);
});

test('resolveNativeClassLocator indexes the SAME ordered array the projector renders', async () => {
  const browser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass()});
  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  const descriptor = browser.toPresentationDescriptor(presentation);

  assert.equal(resolveNativeClassLocator(descriptor, 0), SUPER_REF, 'the exact Images ref, by identity');
  assert.equal(resolveNativeClassLocator(descriptor, 1), META_REF);
  // Out of range, negative, non-integer and a foreign descriptor kind resolve to
  // nothing rather than to a neighbouring ref.
  assert.equal(resolveNativeClassLocator(descriptor, 2), null);
  assert.equal(resolveNativeClassLocator(descriptor, -1), null);
  assert.equal(resolveNativeClassLocator(descriptor, 1.5), null);
  assert.equal(resolveNativeClassLocator({...descriptor, kind: 'inspector'}, 0), null);

  // The projector renders the locators in the SAME order this resolver indexes,
  // so the displayed row and the resolved ref cannot drift apart (Bead 2je).
  const doc = semanticUiForPresentation(descriptor);
  const locatorRows = doc.root.children.find((child) => child.kind === 'collection' && child.label === 'Locators');
  assert.deepEqual(locatorRows.items.map((item) => item.text), [
    'superclass -> img/smalltalk/class/BrowseBase',
    'class-side -> img/smalltalk/metaclass/BrowseChild',
  ]);
  locatorRows.items.forEach((item, index) => {
    assert.equal(item.kind, 'text', 'E1 ships no activation route, so a locator row is TEXT (Bead gzz)');
    assert.equal(item.text.endsWith(`/${resolveNativeClassLocator(descriptor, index).objectId}`), true,
      `row ${index} displays exactly the ref the resolver returns for ${index}`);
  });
});

test('the projection INDEXES the browser-owned locator list, never re-deriving it from the description', () => {
  // A description carrying both relations, with an EMPTY locator list. If the
  // projector re-derived the rows from smalltalkClass.superclass/classSide it
  // would become a second decider of which relations are navigable and in what
  // order — and this document would sprout rows the browser never offered.
  const doc = semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description(), locators: []},
  });
  assert.equal(doc.root.children.some((child) => child.label === 'Locators'), false,
    'no locator rows exist when the browser offered none, however many refs the description carries');
});

test('the projection keeps a null layout and an EMPTY declared layout different', () => {
  const project = (layout) => semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description({layout}), locators: []},
  });
  const labels = (doc) => doc.root.children.filter((c) => c.kind === 'field').map((c) => `${c.label}=${c.text}`);

  // null: the class declares NO instance layout at all (a Metaclass, an abstract
  // kernel class). Not the same claim as "declares zero instance variables".
  assert.deepEqual(labels(project(null)).slice(3), ['Layout=(no declared instance layout)']);
  // []: an empty layout — the class declares zero instance variables and its
  // instances exist.
  assert.deepEqual(labels(project({instanceVariables: [], indexed: 'none'})).slice(3),
    ['Instance variables=', 'Indexed=none']);
  // An ABSENT layout key is treated exactly like null (the rule both ports state).
  const absent = semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: {...description(), layout: undefined}, locators: []},
  });
  assert.deepEqual(labels(absent).slice(3), ['Layout=(no declared instance layout)']);
  assert.notDeepEqual(labels(project(null)), labels(project({instanceVariables: [], indexed: 'none'})));
});

test('the projection shows selector NAMES as text and never a Provenance row', () => {
  const doc = semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description(), locators: []},
  });
  const selectors = doc.root.children.find((child) => child.kind === 'collection' && child.label === 'Selectors');
  assert.deepEqual(selectors.items, [
    {kind: 'text', text: 'childFirst'},
    {kind: 'text', text: 'childSecond'},
  ], 'selector rows are TEXT: class-read authority must not imply a method ref exists');
  // provenance is null today (Images owns no durable association); an empty
  // Provenance row would imply a field that does not exist.
  assert.equal(doc.root.children.some((child) => child.label === 'Provenance'), false);
  // An empty selector list omits the collection entirely rather than showing an
  // empty one.
  const none = semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description({selectors: []}), locators: []},
  });
  assert.equal(none.root.children.some((child) => child.label === 'Selectors'), false);
});

// --- the METHOD twin of the class unit proofs above (E2 Slice A) ---

test('the native-method subject carries class + selector and rejects what it cannot browse', () => {
  const subject = createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});
  assert.equal(subject.kind, NATIVE_METHOD_SUBJECT_KIND);
  assert.equal(subject.classRef, CLASS_REF, 'the caller-supplied ref is carried by IDENTITY');
  assert.equal(subject.selector, SELECTOR);
  assert.ok(Object.isFrozen(subject));

  // Same reason as the class subject: a pinned-ref is a caller mistake and must
  // not come back looking like a missing method.
  assert.throws(
    () => createNativeMethodSubject({imageId: IMAGE, classRef: {kind: 'pinned-ref', imageId: IMAGE, objectId: 'c', revision: 1}, selector: SELECTOR}),
    /unpinned \{kind: "ref"\} classRef/,
  );
  assert.throws(
    () => createNativeMethodSubject({imageId: IMAGE, classRef: {kind: 'ref', imageId: 'other', objectId: 'c'}, selector: SELECTOR}),
    /classRef must name image img/,
  );
  assert.throws(() => createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF}), /selector/);
  assert.throws(() => createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: ''}), /selector/);
});

test('browseMethod makes ONE authorized call carrying exactly the subject and authority', async () => {
  const adapter = methodFakeAdapter();
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass()});
  const authority = Object.freeze({opaque: true});

  const presentation = await browser.browseMethod(
    createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR}), {authority},
  );

  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), ['authority', 'classRef', 'imageId', 'selector'],
    'the method seam receives the subject and authority ONLY');
  assert.equal(adapter.calls[0].classRef, CLASS_REF);
  assert.equal(adapter.calls[0].selector, SELECTOR);
  assert.equal(adapter.calls[0].authority, authority, 'authority is threaded per call, never stored');
  assert.equal(presentation.kind, NATIVE_METHOD_PRESENTATION_KIND);
  assert.equal(presentation.context.smalltalkMethod.method, BLOCK_REF, 'the Images record, by identity');
});

test('the method provider refuses a description that is not its own subject\'s', () => {
  const provider = createNativeMethodPresentationProvider();
  const subject = createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});
  assert.equal(provider.present({kind: 'ref', imageId: IMAGE, objectId: 'x'}), null, 'disjoint by subject kind');
  assert.equal(provider.present(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {}), null,
    'a class subject is not a method subject');
  assert.throws(() => provider.present(subject, {}), /canonical smalltalk-method-description\/v1/);
  // A description for a DIFFERENT selector, or a different declaring class, is
  // not this subject's — accepting either would let one authorized read stand in
  // for another.
  assert.throws(
    () => provider.present(subject, {smalltalkMethod: methodDescription({selector: 'somethingElse'})}),
    /description of ITS OWN subject/,
  );
  assert.throws(
    () => provider.present(subject, {smalltalkMethod: methodDescription({class: ref('smalltalk/class/Other')})}),
    /description of ITS OWN subject/,
  );
});

test('browseMethod requires EXACTLY ONE presentation, on both the success and failure paths', async () => {
  const subject = createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});

  const none = createNativeSmalltalkBrowser({adapter: methodFakeAdapter(), presentationRegistry: createPresentationRegistry()});
  await assert.rejects(none.browseMethod(subject), /no native method presentation was discovered/);

  const wrongKind = createPresentationRegistry();
  wrongKind.register(Object.freeze({
    id: 'origin-flavoured-method',
    present(s) {
      if (!s || s.kind !== NATIVE_METHOD_SUBJECT_KIND) return null;
      return new Presentation({id: 'other', subject: s, kind: 'cuis-method', context: {}, state: {}});
    },
  }));
  const wrongKindBrowser = createNativeSmalltalkBrowser({adapter: methodFakeAdapter(), presentationRegistry: wrongKind});
  await assert.rejects(wrongKindBrowser.browseMethod(subject), /is cuis-method, not native-method/);

  // The FAILURE path takes no first match either.
  const denied = Object.assign(new Error('denied'), {name: 'AuthorityError'});
  const failing = methodFakeAdapter({describeMethod: () => { throw denied; }});
  const doubled = createPresentationRegistry();
  doubled.register(createUnauthorizedRefProvider());
  doubled.register(createUnauthorizedRefProvider());
  await assert.rejects(
    createNativeSmalltalkBrowser({adapter: failing, presentationRegistry: doubled}).browseMethod(subject),
    /ambiguous presentations for a unauthorized-ref native method read/,
  );
  await assert.rejects(
    createNativeSmalltalkBrowser({adapter: failing, presentationRegistry: createPresentationRegistry()}).browseMethod(subject),
    /no presentation was discovered for a unauthorized-ref native method read/,
  );
});

test('a failed method read presents through the ordinary route and names the CLASS, not the Block', async () => {
  const subject = createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});
  const denied = Object.assign(new Error('not authorized: object/read on YXBw.blah'), {name: 'AuthorityError'});
  const unauthorized = await createNativeSmalltalkBrowser({
    adapter: methodFakeAdapter({describeMethod: () => { throw denied; }}),
    presentationRegistry: registryWithNativeClass(),
  }).browseMethod(subject);
  assert.equal(unauthorized.kind, 'unauthorized-reference');
  assert.equal(unauthorized.context.reason, 'not authorized to read this native method');
  assert.equal(unauthorized.subject.objectId, CLASS_REF.objectId,
    'a denied caller is told about the class it named, never about the Block it may not read');
  assert.equal(JSON.stringify(unauthorized.context).includes('/method/'), false);

  const missing = await createNativeSmalltalkBrowser({
    adapter: methodFakeAdapter({describeMethod: () => { throw new TypeError('native class X does not implement Y'); }}),
    presentationRegistry: registryWithNativeClass(),
  }).browseMethod(subject);
  assert.equal(missing.kind, 'unavailable-reference');
  assert.equal(missing.context.reason, 'this native method could not be read');
  assert.equal(missing.context.reason.includes('does not implement'), false,
    'the Images message never reaches a consumer');
});

test('the native-method projection shows only what Images owns, and omits absent rows', () => {
  const doc = semanticUiForPresentation({
    kind: NATIVE_METHOD_PRESENTATION_KIND,
    subject: {kind: NATIVE_METHOD_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR},
    parameters: {smalltalkMethod: methodDescription()},
  });
  assert.deepEqual(doc.root.children.filter((c) => c.kind === 'field').map((c) => c.label),
    ['Selector', 'Side', 'Declaring class', 'Method']);
  // source and provenance are null: the rows are ABSENT, not empty. An empty row
  // would suggest a durable field exists (Images jtz.1).
  for (const absent of ['Source', 'Provenance']) {
    assert.equal(doc.root.children.some((c) => c.label === absent), false, `${absent} must not be rendered`);
  }
  assert.equal(doc.root.children.some((c) => c.kind === 'action'), false,
    'Slice A ships no activation on a native method pane');
});

test('the Environment composes NO Images object id anywhere in src/', async () => {
  // The plan's structural companion to the redefinition proof: a method's Block
  // id is Images' identity, and the only honest way to have one is to be given
  // it. A template like `${classId}/method/${...}` in src/ would mean the
  // Environment could manufacture a method identity without an authorized read —
  // which is exactly the wrong implementation the integration proof is designed
  // to catch at runtime. This catches it at rest, in any file, forever.
  const {readdirSync, readFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  const walk = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap((entry) => (
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  ));
  // Method and Block id fragments are forbidden OUTRIGHT: composing one would
  // manufacture a method identity without an authorized read.
  const forbiddenEverywhere = ['/method/', '/revision/', 'smalltalk/block/', 'smalltalk/metaclass/'];
  // Class id composition has exactly ONE pre-existing site, `classIdFor` in the
  // adapter, used only on the control-plane/schema path (`images.getObject` for
  // the probe and Perspective classes, never a user-facing read). It predates
  // native browsing and is pinned here rather than hidden, so a SECOND site —
  // or any spread into the browsing lane — goes red. Bead lagrange-object-
  // environment-c9v records the smell itself.
  const classFragmentAllowance = new Set(['src/image-client-adapter.js']);
  const offenders = [];
  const root = new URL('../src', import.meta.url).pathname;
  for (const file of walk(root).filter((f) => f.endsWith('.js'))) {
    const relative = `src/${file.slice(root.length + 1)}`;
    const source = readFileSync(file, 'utf8');
    const fragments = classFragmentAllowance.has(relative)
      ? forbiddenEverywhere
      : [...forbiddenEverywhere, 'smalltalk/class/'];
    for (const fragment of fragments) {
      // A LITERAL id fragment in code, not the word in prose: the fragment
      // adjacent to a string/template delimiter.
      for (const quote of ['`', "'", '"']) {
        if (source.includes(`${quote}${fragment}`) || source.includes(`${fragment}${quote}`)) {
          offenders.push(`${relative}: ${fragment}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    'no module under src/ may compose or parse an Images METHOD/Block id, and only the one '
    + 'documented control-plane site may compose a class id; identity comes from Images');
  // The allowance is not a blank cheque: the browsing lane itself must be clean.
  assert.equal(
    readFileSync(new URL('../src/native-smalltalk-browser.js', import.meta.url), 'utf8').includes("'smalltalk/"),
    false,
    'the native browsing owner composes no Images id at all',
  );
});
