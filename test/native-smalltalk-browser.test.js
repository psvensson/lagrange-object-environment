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
  resolveNativeTarget,
} from '../src/native-smalltalk-browser.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {
  createUnauthorizedRefProvider,
  createUnavailableRefProvider,
} from '../src/object-presentation-providers.js';
import {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND} from '../src/object-navigator.js';
import {semanticUiForPresentation} from '../src/semantic-ui.js';
import {assertDataRepresentable, createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';
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

// A REAL Compositor over the headless fake renderer: the browser now admits and
// re-presents its own logical view, so its unit lane exercises the real
// admission path rather than a stub.
function compositorFor() {
  return createCompositor({rendererAdapter: createFakeRendererAdapter()});
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
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
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

test('the Images description is preserved BY IDENTITY; targets hold its own refs and selectors', async () => {
  const canonical = description();
  const adapter = fakeAdapter({describe: () => canonical});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});

  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));

  assert.equal(presentation.context.smalltalkClass, canonical,
    'the canonical description is the SAME object — never copied, normalized or re-shaped');
  // ONE ordered array: the class's own selectors, then its relations.
  assert.deepEqual(presentation.context.targets.map((entry) => [entry.group, entry.label]), [
    ['selector', 'childFirst'],
    ['selector', 'childSecond'],
    ['relation', `superclass -> ${IMAGE}/${SUPER_REF.objectId}`],
    ['relation', `class-side -> ${IMAGE}/${META_REF.objectId}`],
  ]);
  // The targets carry the DESCRIPTION's own objects, by identity — not
  // re-spelled refs and not copied selector strings.
  assert.equal(presentation.context.targets[0].target.classRef, canonical.class);
  assert.equal(presentation.context.targets[0].target.selector, canonical.selectors[0]);
  assert.equal(presentation.context.targets[2].target.classRef, canonical.superclass);
  assert.equal(presentation.context.targets[3].target.classRef, canonical.classSide);
  assert.equal(presentation.context.targets[2].target.kind, 'native-class');
  assert.equal(presentation.context.targets[0].target.kind, 'native-method');
});

test('a root class contributes no superclass target and a Metaclass no class-side target', async () => {
  const relations = (presentation) => presentation.context.targets
    .filter((entry) => entry.group === 'relation')
    .map((entry) => entry.label.split(' ->')[0]);

  const rootAdapter = fakeAdapter({describe: () => description({superclass: null})});
  const rootBrowser = createNativeSmalltalkBrowser({adapter: rootAdapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
  const root = await rootBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  // The kernel's nil TERMINATES the chain; a root class does not have a
  // superclass named "nil", so there is nothing to navigate to.
  assert.deepEqual(relations(root), [LOCATOR_RELATION.CLASS_SIDE]);

  const metaAdapter = fakeAdapter({describe: () => description({classSide: null})});
  const metaBrowser = createNativeSmalltalkBrowser({adapter: metaAdapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
  const meta = await metaBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  assert.deepEqual(relations(meta), [LOCATOR_RELATION.SUPERCLASS]);

  // A class with NO selectors contributes no selector targets, so the relation
  // keys start at 0 — which is exactly why the key-agreement proof needs a
  // fixture carrying BOTH groups.
  const bare = fakeAdapter({describe: () => description({selectors: []})});
  const bareBrowser = createNativeSmalltalkBrowser({adapter: bare, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
  const bareClass = await bareBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  assert.deepEqual(bareClass.context.targets.map((entry) => entry.group), ['relation', 'relation']);
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
        id: 'shadow', subject, kind: NATIVE_CLASS_PRESENTATION_KIND, context: {targets: []}, state: {},
      });
    },
  });
  const browser = createNativeSmalltalkBrowser({
    adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass([shadow]), compositor: compositorFor(),
  });
  await assert.rejects(
    browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    (error) => error instanceof NativeClassPresentationError && /ambiguous native class presentations/.test(error.message),
  );

  const empty = createPresentationRegistry();
  const noneBrowser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: empty, compositor: compositorFor()});
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
  const wrongKindBrowser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: wrongKind, compositor: compositorFor()});
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
  const doubledBrowser = createNativeSmalltalkBrowser({adapter, presentationRegistry: doubled, compositor: compositorFor()});
  await assert.rejects(
    doubledBrowser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF})),
    /ambiguous presentations for a unauthorized-ref native class read/,
  );

  // None at all is loud too, rather than returning undefined.
  const bare = createNativeSmalltalkBrowser({adapter, presentationRegistry: createPresentationRegistry(), compositor: compositorFor()});
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
    () => provider.present(subject, {smalltalkClass: description({class: ref('smalltalk/class/Other')}), targets: []}),
    /description of ITS OWN subject/,
  );
  // The ordered target array is the BROWSER's. The provider must not derive one
  // when it is missing: that would be a second locus for the array that owns the
  // key space, and a silent one.
  assert.throws(
    () => provider.present(subject, {smalltalkClass: description()}),
    /browser-owned ordered targets array/,
  );
});

test('a denied read presents through the ORDINARY unauthorized route, with no Images message', async () => {
  const authorityError = Object.assign(new Error('not authorized: object/read on YXBw.c21hbGx0YWxr'), {name: 'AuthorityError'});
  const adapter = fakeAdapter({describe: () => { throw authorityError; }});
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});

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
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});

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
  const compositor = compositorFor();
  assert.throws(
    () => createNativeSmalltalkBrowser({adapter: {describeSmalltalkClass: () => {}}, presentationRegistry: registry, compositor}),
    /describeSmalltalkMethod/,
  );
  assert.throws(
    () => createNativeSmalltalkBrowser({
      adapter: {describeSmalltalkClass: () => {}, describeSmalltalkMethod: () => {}},
      presentationRegistry: registry,
      compositor,
    }),
    /classifySmalltalkMethodReadError/,
  );
  assert.throws(
    () => createNativeSmalltalkBrowser({
      adapter: {describeSmalltalkClass: () => {}, describeSmalltalkMethod: () => {}, classifySmalltalkMethodReadError: () => {}},
      presentationRegistry: registry,
      compositor,
    }),
    /classifySmalltalkClassReadError/,
  );
  assert.throws(() => createNativeSmalltalkBrowser({adapter: {}, presentationRegistry: registry, compositor}), /describeSmalltalkClass/);
  assert.throws(() => createNativeSmalltalkBrowser({adapter: fakeAdapter(), compositor}), /PresentationRegistry/);
  // The Compositor is REQUIRED (the ProjectBrowser precedent): a browser that
  // could not present would make its activation binding a promise it cannot keep.
  assert.throws(
    () => createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: registry}),
    /requires a Compositor/,
  );
});

test('the presentationDescriptor survives the JSON round trip the native host performs', async () => {
  const browser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  const descriptor = browser.toPresentationDescriptor(presentation);

  // The Compositor's own admission check, called directly: E1 opens no view, so
  // this is the only thing proving the descriptor is data-representable.
  assertDataRepresentable(descriptor, 'presentationDescriptor');
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  assert.equal(descriptor.kind, NATIVE_CLASS_PRESENTATION_KIND);
  assert.equal(descriptor.subject.classRef.objectId, CLASS_REF.objectId);
});

test('resolveNativeTarget indexes the SAME ordered array the projector keys', async () => {
  const browser = createNativeSmalltalkBrowser({adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
  const presentation = await browser.browse(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}));
  const descriptor = browser.toPresentationDescriptor(presentation);
  const targets = descriptor.parameters.targets;

  // Every entry resolves to ITS OWN target, by identity.
  targets.forEach((entry, key) => {
    assert.equal(resolveNativeTarget(descriptor, key), entry.target, `key ${key} resolves to targets[${key}].target`);
  });
  // Out of range, negative, non-integer and a foreign descriptor kind resolve to
  // nothing rather than to a neighbouring target.
  assert.equal(resolveNativeTarget(descriptor, targets.length), null);
  assert.equal(resolveNativeTarget(descriptor, -1), null);
  assert.equal(resolveNativeTarget(descriptor, 1.5), null);
  assert.equal(resolveNativeTarget({...descriptor, kind: 'inspector'}, 0), null);

  // ONE KEY SPACE ACROSS BOTH COLLECTIONS. The projected document's action keys
  // are a BIJECTION onto 0..n-1 — selectors and relations can never share an
  // integer — and every key resolves to the target at that position.
  const doc = semanticUiForPresentation(descriptor);
  const actions = [];
  const walk = (node) => {
    if (node.kind === 'action') actions.push(node);
    for (const child of node.children ?? []) walk(child);
    for (const item of node.items ?? []) walk(item);
  };
  walk(doc.root);
  assert.equal(actions.length, targets.length);
  assert.deepEqual([...actions.map((a) => a.key)].sort((a, b) => a - b), targets.map((_, i) => i));
  const collections = doc.root.children.filter((child) => child.kind === 'collection');
  assert.deepEqual(collections.map((c) => c.label), ['Selectors', 'Relations'],
    'two visual groups, one key space');
  for (const action of actions) {
    assert.equal(action.label, targets[action.key].label, 'the label belongs to the entry the key names');
    assert.equal(resolveNativeTarget(descriptor, action.key), targets[action.key].target);
    // An action carries the key and nothing else: the validator would reject a
    // nested ref but would ACCEPT a stray `selector` string.
    assert.deepEqual(Object.keys(action).sort(), ['key', 'kind', 'label']);
  }
});

test('the projection INDEXES the browser-owned target array, never re-deriving it from the description', () => {
  // A description carrying two selectors AND both relations, with an EMPTY
  // target array. If either port re-derived rows from smalltalkClass.selectors /
  // superclass / classSide it would become a second decider of what is
  // navigable, and this document would sprout rows the browser never offered.
  const doc = semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description(), targets: []},
  });
  assert.deepEqual(doc.root.children.filter((child) => child.kind === 'collection'), [],
    'no rows exist when the browser offered none, however many selectors and refs the description carries');
});

test('the projection keeps a null layout and an EMPTY declared layout different', () => {
  const project = (layout) => semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description({layout}), targets: []},
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
    parameters: {smalltalkClass: {...description(), layout: undefined}, targets: []},
  });
  assert.deepEqual(labels(absent).slice(3), ['Layout=(no declared instance layout)']);
  assert.notDeepEqual(labels(project(null)), labels(project({instanceVariables: [], indexed: 'none'})));
});

test('the projection renders selectors and relations as actions, and never a Provenance row', () => {
  const targets = [
    {target: {kind: 'native-method', imageId: IMAGE, classRef: CLASS_REF, selector: 'childFirst'}, group: 'selector', label: 'childFirst'},
    {target: {kind: 'native-class', imageId: IMAGE, classRef: SUPER_REF}, group: 'relation', label: 'superclass -> img/x'},
  ];
  const project = (entries) => semanticUiForPresentation({
    kind: NATIVE_CLASS_PRESENTATION_KIND,
    subject: {kind: NATIVE_CLASS_SUBJECT_KIND, imageId: IMAGE, classRef: CLASS_REF},
    parameters: {smalltalkClass: description(), targets: entries},
  });

  const doc = project(targets);
  const collections = doc.root.children.filter((c) => c.kind === 'collection');
  assert.deepEqual(collections.map((c) => c.label), ['Selectors', 'Relations']);
  assert.deepEqual(collections[0].items, [{kind: 'action', key: 0, label: 'childFirst'}]);
  assert.deepEqual(collections[1].items, [{kind: 'action', key: 1, label: 'superclass -> img/x'}]);
  // provenance is null today; an empty row would imply a durable field exists.
  assert.equal(doc.root.children.some((child) => child.label === 'Provenance'), false);

  // An EMPTY bucket is omitted entirely; an UNKNOWN group lands in one trailing
  // bucket rather than being dropped — the rule both ports carry verbatim.
  const selectorsOnly = project([targets[0]]);
  assert.deepEqual(selectorsOnly.root.children.filter((c) => c.kind === 'collection').map((c) => c.label), ['Selectors']);
  const unknown = project([targets[0], {target: targets[1].target, group: 'future', label: 'f'}]);
  assert.deepEqual(unknown.root.children.filter((c) => c.kind === 'collection').map((c) => c.label), ['Selectors', 'Other']);
  assert.equal(project([]).root.children.some((c) => c.kind === 'collection'), false);
});

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
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryWithNativeClass(), compositor: compositorFor()});
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

  const none = createNativeSmalltalkBrowser({adapter: methodFakeAdapter(), presentationRegistry: createPresentationRegistry(), compositor: compositorFor()});
  await assert.rejects(none.browseMethod(subject), /no native method presentation was discovered/);

  const wrongKind = createPresentationRegistry();
  wrongKind.register(Object.freeze({
    id: 'origin-flavoured-method',
    present(s) {
      if (!s || s.kind !== NATIVE_METHOD_SUBJECT_KIND) return null;
      return new Presentation({id: 'other', subject: s, kind: 'cuis-method', context: {}, state: {}});
    },
  }));
  const wrongKindBrowser = createNativeSmalltalkBrowser({adapter: methodFakeAdapter(), presentationRegistry: wrongKind, compositor: compositorFor()});
  await assert.rejects(wrongKindBrowser.browseMethod(subject), /is cuis-method, not native-method/);

  // The FAILURE path takes no first match either.
  const denied = Object.assign(new Error('denied'), {name: 'AuthorityError'});
  const failing = methodFakeAdapter({describeMethod: () => { throw denied; }});
  const doubled = createPresentationRegistry();
  doubled.register(createUnauthorizedRefProvider());
  doubled.register(createUnauthorizedRefProvider());
  await assert.rejects(
    createNativeSmalltalkBrowser({adapter: failing, presentationRegistry: doubled, compositor: compositorFor()}).browseMethod(subject),
    /ambiguous presentations for a unauthorized-ref native method read/,
  );
  await assert.rejects(
    createNativeSmalltalkBrowser({adapter: failing, presentationRegistry: createPresentationRegistry(), compositor: compositorFor()}).browseMethod(subject),
    /no presentation was discovered for a unauthorized-ref native method read/,
  );
});

test('a failed method read presents through the ordinary route and names the CLASS, not the Block', async () => {
  const subject = createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});
  const denied = Object.assign(new Error('not authorized: object/read on YXBw.blah'), {name: 'AuthorityError'});
  const unauthorized = await createNativeSmalltalkBrowser({
    adapter: methodFakeAdapter({describeMethod: () => { throw denied; }}),
    presentationRegistry: registryWithNativeClass(),
    compositor: compositorFor(),
  }).browseMethod(subject);
  assert.equal(unauthorized.kind, 'unauthorized-reference');
  assert.equal(unauthorized.context.reason, 'not authorized to read this native method');
  assert.equal(unauthorized.subject.objectId, CLASS_REF.objectId,
    'a denied caller is told about the class it named, never about the Block it may not read');
  assert.equal(JSON.stringify(unauthorized.context).includes('/method/'), false);

  const missing = await createNativeSmalltalkBrowser({
    adapter: methodFakeAdapter({describeMethod: () => { throw new TypeError('native class X does not implement Y'); }}),
    presentationRegistry: registryWithNativeClass(),
    compositor: compositorFor(),
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
    'a native method pane offers no actions');
});

test('a native-method presentation carries NO targets: E2 adds no speculative method navigation', async () => {
  const browser = createNativeSmalltalkBrowser({
    adapter: methodFakeAdapter(), presentationRegistry: registryWithNativeClass(), compositor: compositorFor(),
  });
  const presentation = await browser.browseMethod(
    createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR}),
  );
  const descriptor = browser.toPresentationDescriptor(presentation);
  assert.equal('targets' in descriptor.parameters, false,
    'E2 transitions are class -> method and class -> class; a method view navigates nowhere yet');
  assert.equal(resolveNativeTarget(descriptor, 0), null, 'and nothing resolves against it');
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

test('gzz key agreement: a NEW descriptor moves the labels AND the resolver together', async () => {
  // The falsifier goes through the normal descriptor transition owner: admit A,
  // record what it projects and resolves, then present a DIFFERENT descriptor B
  // and prove both follow B. Descriptor A is never mutated behind the
  // Compositor — a presentationDescriptor is a snapshot, other Environment code
  // relies on its identity, and mutating admitted data would prove only that two
  // sides can observe an illicit change.
  //
  // This kills the co-wrong implementation a per-key round trip cannot: a
  // projector AND resolver that both re-derive from
  // smalltalkClass.selectors/superclass agree with each other while ignoring the
  // browser, so they do not move when only `targets` changes.
  const rendererAdapter = createFakeRendererAdapter({projector: semanticUiForPresentation});
  const compositor = createCompositor({rendererAdapter});
  const browser = createNativeSmalltalkBrowser({
    adapter: fakeAdapter(), presentationRegistry: registryWithNativeClass(), compositor,
  });

  const descriptorA = await browser.open(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {
    viewDescriptor: {kind: 'surface', width: 10, height: 10},
  });
  const handle = compositor.surfaceHandleForView(browser.viewId);
  const labelsOf = () => rendererAdapter.realizedActions(handle).map((a) => a.label);
  const resolvedOf = (descriptor) => rendererAdapter.realizedActions(handle)
    .map((a) => resolveNativeTarget(descriptor, a.key));

  const labelsA = labelsOf();
  const resolvedA = resolvedOf(descriptorA);
  assert.deepEqual(labelsA, ['childFirst', 'childSecond',
    `superclass -> ${IMAGE}/${SUPER_REF.objectId}`, `class-side -> ${IMAGE}/${META_REF.objectId}`]);
  assert.deepEqual(resolvedA.map((t) => t.kind),
    ['native-method', 'native-method', 'native-class', 'native-class']);

  // DESCRIPTOR B: the same class, the SAME smalltalkClass record, but a
  // deliberately reordered and substituted target array.
  const reordered = [
    descriptorA.parameters.targets[3],
    descriptorA.parameters.targets[0],
  ];
  const descriptorB = {
    kind: descriptorA.kind,
    subject: descriptorA.subject,
    parameters: {smalltalkClass: descriptorA.parameters.smalltalkClass, targets: reordered},
  };
  await compositor.presentOn(browser.viewId, descriptorB);

  // BOTH follow B. Note the shape this produces: the relation entry is FIRST in
  // the array (key 0) but renders SECOND, because buckets are ordered by group
  // and the array orders keys. Document order therefore differs from key order —
  // the case that separates "reads the realized key" from "returns the position".
  const actionsB = rendererAdapter.realizedActions(handle);
  assert.deepEqual(actionsB.map((a) => a.label), [
    'childFirst',
    `class-side -> ${IMAGE}/${META_REF.objectId}`,
  ]);
  assert.deepEqual(actionsB.map((a) => a.key), [1, 0], 'keys follow the ARRAY, buckets follow the group');
  // ...and so did the resolver, to the SAME entries, by identity.
  const resolvedB = resolvedOf(descriptorB);
  assert.equal(resolvedB[0], reordered[1].target, 'the first rendered row resolves to targets[1]');
  assert.equal(resolvedB[1], reordered[0].target, 'the second rendered row resolves to targets[0]');
  assert.notDeepEqual(labelsOf(), labelsA, 'the observable mapping really changed');
  // The key space is still a bijection over the NEW array.
  assert.deepEqual(rendererAdapter.realizedActions(handle).map((a) => a.key).sort(), [0, 1]);
  // Descriptor A was never touched.
  assert.equal(descriptorA.parameters.targets.length, 4);
  await compositor.destroy();
});
