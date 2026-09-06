import {Command, Presentation} from './model.js';
import {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND} from './object-navigator.js';

/**
 * NativeSmalltalkBrowser: the single owner of ref -> authorized native class
 * READ selection and class browse orchestration (docs/ownership.md).
 *
 * Images owns every native Smalltalk semantic. This module consumes ONE public
 * function — `ImageClientAdapter.describeSmalltalkClass`, which is Images'
 * `authorizedDescribeSmalltalkClass` (Images ADR 0087) — and preserves the
 * returned `smalltalk-class-description/v1` record BY IDENTITY, exactly as
 * `ProjectBrowser` preserves the canonical ProjectDescriptor. It decodes
 * nothing: no Behavior slot, no MethodDictionary, no Shape, no object-id
 * spelling, no Spur oop. There is no importer, no Cuis model, no shadow class
 * graph and no second lane here.
 *
 * ORIGIN IS NOT IDENTITY. A class that arrived through Images' Cuis native
 * import IS a native class, and takes this one route. Nothing in this module
 * can branch on origin even in principle: the description carries no origin,
 * and `provenance` is `null` because Images owns no durable association today
 * (that is the truthful answer, not a stub — see Bead eij.2 and Images jtz.1).
 *
 * A REF IS NEVER AUTHORITY (ADR 0005, as amended). The `superclass` and
 * `classSide` refs a description carries are LOCATORS. This module never
 * follows one implicitly, never walks the superclass chain, and never fetches
 * the graph recursively to filter afterward: browsing a locator is a FRESH
 * `browse()` under that object's OWN authority, which the caller threads per
 * call and which is never stored here.
 *
 * SELECTOR NAMES ARE NOT METHODS. A class description exposes the class's own
 * canonical selector names and NO method refs. Class-read authority may show
 * that `foo` exists; it must not reveal the Block that implements it. Browsing
 * a method is therefore a SECOND, separately authorized read through its own
 * seam (`browseMethod`), never a richer reading of the class description: the
 * Images method seam re-resolves the selector against the class's CURRENT
 * dictionary and authorizes the resolved Block before disclosing its locator.
 * The Environment never derives, predicts or reconstructs that Block ref — it
 * composes no object id at all.
 *
 * NOT OWNED HERE: discovery (`PresentationRegistry`), rendering, and the
 * renderer activate-item routing itself (`EnvironmentShell`, ownership row 64 —
 * this owner CONTRIBUTES the activation binding that one table routes to, and
 * owns only what a target MEANS; the shell owns handle -> live view, binding
 * choice, resolver validation and delegation, and learns nothing about
 * Smalltalk). Generic object navigation stays with `ObjectNavigator`, which a
 * native activation never touches: delegated navigation performs no selection,
 * no focus and no inspector reread. This owner DOES admit and re-present its own
 * one logical view through the Compositor (the ProjectBrowser precedent), but
 * the Compositor remains the sole owner of view admission and lifecycle. A
 * native Presentation is deliberately NOT Perspective-persistable —
 * `encodePresentations` requires a ref subject — exactly as a Project
 * Presentation is not.
 */

const NATIVE_CLASS_SUBJECT_KIND = 'native-class';
const NATIVE_CLASS_PRESENTATION_KIND = 'native-class';
const NATIVE_METHOD_SUBJECT_KIND = 'native-method';
const NATIVE_METHOD_PRESENTATION_KIND = 'native-method';
const SMALLTALK_CLASS_DESCRIPTION_V1 = 'smalltalk-class-description/v1';
const SMALLTALK_METHOD_DESCRIPTION_V1 = 'smalltalk-method-description/v1';

// The relations a class description owns and that a browser may follow. Each is
// a LOCATOR naming an independently authoritative object, never an inherited
// grant. The kernel stores class -> metaclass and no inverse, so there is no
// "instance side" relation to offer from a Metaclass: a browser that wants to
// toggle sides keeps the ref it started from.
const LOCATOR_RELATION = Object.freeze({
  SUPERCLASS: 'superclass',
  CLASS_SIDE: 'class-side',
});

// Display bucketing for the one target array. VISUAL only: it groups rows, it
// never partitions the key space.
const TARGET_GROUP = Object.freeze({
  SELECTOR: 'selector',
  RELATION: 'relation',
});

// The one logical view a native browse presents into. Class and method
// presentations SHARE it: presentOn detaches before attaching, so the kind
// change is an ordinary re-presentation rather than a second view.
const NATIVE_SMALLTALK_VIEW_ID = 'native-smalltalk-view';

/**
 * E3 (Bead eij.3): the ONE transient input a displayed native method offers, and
 * the id of the ONE Command that consumes it.
 *
 * It is an INPUT, not a field (SemanticUi/v2, Bead ngh): the user supplies a
 * transient ARGUMENT — new source — to an interaction. It is emphatically not an
 * edit of a displayed value, and there is nothing here it could be an edit OF:
 * Images keeps no text a native method was compiled from, so
 * `descriptor.source` is truthfully `null` before AND after a replacement. E3 is
 * REPLACEMENT FROM EXPLICITLY SUPPLIED SOURCE, not a source editor, and this
 * affordance says exactly that and nothing more.
 *
 * The ARRAY is the key space, enumerated once — the projector keys each input by
 * its index here and `resolveMethodReplacementInput` indexes this same array, so
 * neither side derives a key independently (E2's lesson: two co-wrong
 * derivations agree with each other and prove nothing). `role` is the SEMANTIC
 * name and deliberately never crosses into the document: the renderer must not
 * learn what an input MEANS.
 */
const NATIVE_METHOD_SOURCE_INPUT_ROLE = 'native-method-source';
const NATIVE_METHOD_INPUTS = Object.freeze([
  Object.freeze({
    role: NATIVE_METHOD_SOURCE_INPUT_ROLE,
    label: 'New source',
    submitLabel: 'Replace',
  }),
]);
const REPLACE_NATIVE_METHOD_COMMAND_ID = 'replace-native-method';

// The reasons a failed browse presents. FIXED and Environment-owned: Images'
// own browse messages legitimately name storage (`not a
// smalltalk/behavior-shape/v1 behavior: <id>`), and rendering one would put an
// Images storage shape id in the UI. The adapter classifies; this module only
// names the outcome. Bead azj records what the collapse costs.
const UNAUTHORIZED_REASON = 'not authorized to read this native class';
const UNAVAILABLE_REASON = 'this native class could not be read';
const METHOD_UNAUTHORIZED_REASON = 'not authorized to read this native method';
const METHOD_UNAVAILABLE_REASON = 'this native method could not be read';

class NativeClassPresentationError extends Error {
  constructor(message, {failures = []} = {}) {
    super(message);
    this.name = 'NativeClassPresentationError';
    this.failures = failures;
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * The native-class subject: an image plus the EXACT class ref Images issued.
 *
 * The ref is carried unchanged — never re-spelled, never rebuilt from an id,
 * never normalized. `pinned-ref` is rejected here rather than at Images,
 * because the browse seam takes an UNPINNED ref only: letting it through would
 * turn a caller mistake into an "unavailable" presentation that reads like a
 * missing class.
 */
function createNativeClassSubject({imageId, classRef} = {}) {
  requiredText(imageId, 'native class subject imageId');
  if (!classRef || typeof classRef !== 'object' || classRef.kind !== 'ref') {
    throw new TypeError('native class subject requires an unpinned {kind: "ref"} classRef');
  }
  requiredText(classRef.objectId, 'native class subject classRef.objectId');
  if (classRef.imageId !== imageId) {
    throw new TypeError(
      `native class subject classRef must name image ${imageId}, got ${classRef.imageId}`,
    );
  }
  return Object.freeze({kind: NATIVE_CLASS_SUBJECT_KIND, imageId, classRef});
}

function requireNativeClassSubject(subject) {
  if (!subject || subject.kind !== NATIVE_CLASS_SUBJECT_KIND) {
    throw new TypeError('NativeSmalltalkBrowser requires a native-class subject');
  }
  return createNativeClassSubject(subject);
}

function sameNativeClassSubject(a, b) {
  return Boolean(a && b
    && a.kind === NATIVE_CLASS_SUBJECT_KIND && b.kind === NATIVE_CLASS_SUBJECT_KIND
    && a.imageId === b.imageId
    && a.classRef?.objectId === b.classRef?.objectId);
}

function nativeClassPresentationId(subject) {
  // JSON string encoding keeps the pair unambiguous when either opaque id
  // contains punctuation (native class ids routinely do).
  return `native-class:${JSON.stringify(subject.imageId)}:${JSON.stringify(subject.classRef.objectId)}`;
}

/**
 * The native-method subject: a class ref plus ONE canonical selector.
 *
 * This is a BROWSE LOCATOR, not a manufactured method identity. The pair is
 * something the Environment legitimately holds before any method authorization,
 * because an authorized CLASS description discloses the class's own selector
 * names — so naming {class, selector} reveals nothing that class read did not.
 * The method's identity is the Block ref, which only Images owns and only the
 * authorized method read discloses.
 *
 * It deliberately does NOT police that the selector came from a description:
 * that is how the string legitimately arrives, not an invariant this API can
 * enforce, and a guessed selector is harmless — Images re-resolves it against
 * the CURRENT dictionary, so it either does not exist or yields the Block that
 * is bound right now. A pinned-ref is rejected for E1's reason: a caller
 * mistake must not come back looking like a missing method.
 */
function createNativeMethodSubject({imageId, classRef, selector} = {}) {
  requiredText(imageId, 'native method subject imageId');
  if (!classRef || typeof classRef !== 'object' || classRef.kind !== 'ref') {
    throw new TypeError('native method subject requires an unpinned {kind: "ref"} classRef');
  }
  requiredText(classRef.objectId, 'native method subject classRef.objectId');
  if (classRef.imageId !== imageId) {
    throw new TypeError(
      `native method subject classRef must name image ${imageId}, got ${classRef.imageId}`,
    );
  }
  requiredText(selector, 'native method subject selector');
  return Object.freeze({kind: NATIVE_METHOD_SUBJECT_KIND, imageId, classRef, selector});
}

function requireNativeMethodSubject(subject) {
  if (!subject || subject.kind !== NATIVE_METHOD_SUBJECT_KIND) {
    throw new TypeError('NativeSmalltalkBrowser requires a native-method subject');
  }
  return createNativeMethodSubject(subject);
}

function sameNativeMethodSubject(a, b) {
  return Boolean(a && b
    && a.kind === NATIVE_METHOD_SUBJECT_KIND && b.kind === NATIVE_METHOD_SUBJECT_KIND
    && a.imageId === b.imageId
    && a.classRef?.objectId === b.classRef?.objectId
    && a.selector === b.selector);
}

function nativeMethodPresentationId(subject) {
  return `native-method:${JSON.stringify(subject.imageId)}:${JSON.stringify(subject.classRef.objectId)}:${JSON.stringify(subject.selector)}`;
}

/**
 * The native-method presentation provider. Presents the Images description of
 * ONE method, preserved by identity, for the subject that was browsed.
 */
function createNativeMethodPresentationProvider() {
  return Object.freeze({
    id: 'native-smalltalk-method',
    present(subject, context = {}) {
      if (!subject || subject.kind !== NATIVE_METHOD_SUBJECT_KIND) return null;
      const smalltalkMethod = context.smalltalkMethod;
      if (!smalltalkMethod || typeof smalltalkMethod !== 'object'
          || smalltalkMethod.format !== SMALLTALK_METHOD_DESCRIPTION_V1) {
        throw new TypeError(
          `native method presentation requires the canonical ${SMALLTALK_METHOD_DESCRIPTION_V1} description`,
        );
      }
      if (smalltalkMethod.selector !== subject.selector
          || smalltalkMethod.class?.objectId !== subject.classRef.objectId
          || smalltalkMethod.class?.imageId !== subject.imageId) {
        throw new TypeError('native method presentation requires the description of ITS OWN subject');
      }
      return new Presentation({
        id: nativeMethodPresentationId(subject),
        subject,
        kind: NATIVE_METHOD_PRESENTATION_KIND,
        // Images' record by IDENTITY. `method` is the Block ref Images bound —
        // the method's identity, disclosed only after its own authorization.
        context: {smalltalkMethod},
        state: {},
      });
    },
  });
}

/**
 * THE ONE ordered activation-target array for a native-class description.
 *
 * This is the E2 key-space invariant. A class presents two visually separate
 * groups — its own selectors and its class relations — and if each group were
 * keyed from zero the SAME emitted integer would name two different semantic
 * targets. So there is exactly ONE array, this one, and every action key is an
 * index into it. The projector buckets by `group` for display and derives each
 * key from the entry's POSITION HERE; the resolver indexes this same array.
 * Neither reconstructs a target, and neither does offset arithmetic.
 *
 * Each `target` is an EXISTING browse subject — the same values `browse` and
 * `browseMethod` already take — built from the description's own refs and
 * canonical selector strings BY IDENTITY. There is deliberately no
 * `{kind:'navigation-target'}` wrapper: these subjects already mean exactly
 * "browse this", and because both carry an `imageId`, SemanticUi's ref
 * detection catches one that ever leaks into a node.
 *
 * Order: the class's own selectors, then superclass, then class side. A null
 * relation is skipped, so a root class contributes no superclass entry and a
 * Metaclass no class-side entry (the kernel's `nil` terminates the chain — a
 * root class does not have a superclass named "nil").
 */
function nativeClassActivationTargets(subject, description) {
  const entries = [];
  for (const selector of description.selectors ?? []) {
    entries.push(Object.freeze({
      // `description.class` rather than `subject.classRef`: Images echoes the
      // caller's ref, so today they are the same object — but the invariant this
      // module states is that a target holds the DESCRIPTION's own refs, and it
      // should be true by construction rather than by coincidence.
      target: createNativeMethodSubject({imageId: subject.imageId, classRef: description.class, selector}),
      group: TARGET_GROUP.SELECTOR,
      label: selector,
    }));
  }
  const relation = (kind, ref) => Object.freeze({
    target: createNativeClassSubject({imageId: subject.imageId, classRef: ref}),
    group: TARGET_GROUP.RELATION,
    label: `${kind} -> ${ref.imageId}/${ref.objectId}`,
  });
  if (description.superclass) entries.push(relation(LOCATOR_RELATION.SUPERCLASS, description.superclass));
  if (description.classSide) entries.push(relation(LOCATOR_RELATION.CLASS_SIDE, description.classSide));
  return Object.freeze(entries);
}

/**
 * Resolve one descriptor-local activation key of the CURRENT native-class
 * presentation descriptor to the semantic target it names, or null.
 *
 * PURE over the descriptor, and it INDEXES the same ordered array the projector
 * keyed — it never re-derives a target from `smalltalkClass.superclass`,
 * `classSide` or `selectors`. A re-deriving resolver and a re-deriving
 * projector would agree with each other while both ignoring the browser, which
 * is exactly the failure the A->B descriptor-transition proof is built to catch.
 *
 * The returned subject is a browse LOCATOR: acting on it is a fresh authorized
 * read under whatever authority the caller supplies then.
 */
function resolveNativeTarget(presentationDescriptor, key) {
  if (presentationDescriptor?.kind !== NATIVE_CLASS_PRESENTATION_KIND) return null;
  const targets = presentationDescriptor?.parameters?.targets;
  if (!Array.isArray(targets)
      || !Number.isSafeInteger(key) || key < 0 || key >= targets.length) {
    return null;
  }
  const target = targets[key]?.target;
  if (!target || (target.kind !== NATIVE_CLASS_SUBJECT_KIND && target.kind !== NATIVE_METHOD_SUBJECT_KIND)) {
    return null;
  }
  return target;
}

/**
 * Resolve a transient SemanticUi/v2 INPUT key against the CURRENT native-method
 * presentation descriptor to the SEMANTIC input it supplies (`{role}`), or null
 * (E3, Bead eij.3).
 *
 * PURE over the descriptor, and the exact twin of `resolveNativeTarget`: it
 * INDEXES the same ordered `parameters.inputs` array the projector keyed, and
 * derives nothing. Only the ROLE crosses back — never the label, never the
 * subject, never a token. A null answer is an ordinary no-op (a stale key, or a
 * descriptor that is not a native method), never a wrong input.
 */
function resolveMethodReplacementInput(presentationDescriptor, key) {
  if (presentationDescriptor?.kind !== NATIVE_METHOD_PRESENTATION_KIND) return null;
  const inputs = presentationDescriptor?.parameters?.inputs;
  if (!Array.isArray(inputs)
      || !Number.isSafeInteger(key) || key < 0 || key >= inputs.length) {
    return null;
  }
  const role = inputs[key]?.role;
  return typeof role === 'string' && role.length > 0 ? Object.freeze({role}) : null;
}

/**
 * THE replacement Command (E3, Bead eij.3) — an ORDINARY Command, built here
 * because this owner defines the native-method subject kind and the input role
 * it consumes, and because a second copy in each composition would be two
 * co-wrong definitions that agree with each other.
 *
 * It is ordinary in every way that matters: the CommandRegistry discovers it by
 * applicability, the CommandRouter selects it by the binding's EXPLICIT
 * commandId, the CommandDispatcher authorizes and invokes it through the image
 * seam, and the Environment's conflict taxonomy classifies its failures. This
 * factory adds no lane and no privilege.
 *
 * APPLICABILITY IS NOT AUTHORIZATION: it applies to any native-method subject,
 * including one the caller may not write. Whether the write is allowed is
 * Images' decision at invocation, taken against the per-invocation authority the
 * router mints -- never anticipated here.
 *
 * WHAT IT REFUSES TO GUESS. It requires the resolver's own `{role}` to be the
 * source input, the caller's `text` to be non-empty, and a `versionToken` to be
 * present. A missing token is a REFUSAL, never a token-free replacement: the
 * token is the caller's assumption about what it was shown, and replacing
 * without one would silently overwrite whatever happens to be current -- the
 * lost update this whole lane exists to make impossible.
 */
function createReplaceNativeMethodCommand() {
  return new Command({
    id: REPLACE_NATIVE_METHOD_COMMAND_ID,
    title: 'Replace method source',
    appliesTo: (subject) => subject?.kind === NATIVE_METHOD_SUBJECT_KIND,
    invoke: async (subject, context = {}) => {
      const required = requireNativeMethodSubject(subject);
      const {adapter, authority = null, text, versionToken, input} = context;
      if (!adapter || typeof adapter.replaceSmalltalkMethod !== 'function') {
        throw new TypeError(`${REPLACE_NATIVE_METHOD_COMMAND_ID} requires the ImageClientAdapter's replaceSmalltalkMethod seam`);
      }
      if (input?.role !== NATIVE_METHOD_SOURCE_INPUT_ROLE) {
        throw new TypeError(
          `${REPLACE_NATIVE_METHOD_COMMAND_ID} consumes the ${NATIVE_METHOD_SOURCE_INPUT_ROLE} input, `
          + `not ${JSON.stringify(input?.role ?? null)}`,
        );
      }
      if (typeof text !== 'string' || text.length === 0) {
        throw new TypeError(`${REPLACE_NATIVE_METHOD_COMMAND_ID} requires the supplied source text`);
      }
      if (typeof versionToken !== 'string' || versionToken.length === 0) {
        throw new TypeError(
          `${REPLACE_NATIVE_METHOD_COMMAND_ID} requires the version token paired with the method that was `
          + 'displayed; replacing without one would overwrite whatever is current',
        );
      }
      // Images' receipt, unchanged: {replaced: true}. Nothing is read back from
      // it -- the displayed truth comes from a fresh authorized reread.
      return adapter.replaceSmalltalkMethod({
        imageId: required.imageId,
        classRef: required.classRef,
        selector: required.selector,
        source: text,
        versionToken,
        authority,
      });
    },
  });
}

/**
 * The native-class presentation provider. Presents a native-class subject from
 * the Images description the browser read. It validates only that the
 * description is the canonical record FOR THIS SUBJECT — it never repairs,
 * normalizes or copies one.
 */
function createNativeClassPresentationProvider() {
  return Object.freeze({
    id: 'native-smalltalk-class',
    present(subject, context = {}) {
      if (!subject || subject.kind !== NATIVE_CLASS_SUBJECT_KIND) return null;
      const smalltalkClass = context.smalltalkClass;
      if (!smalltalkClass || typeof smalltalkClass !== 'object'
          || smalltalkClass.format !== SMALLTALK_CLASS_DESCRIPTION_V1) {
        throw new TypeError(
          `native class presentation requires the canonical ${SMALLTALK_CLASS_DESCRIPTION_V1} description`,
        );
      }
      if (smalltalkClass.class?.objectId !== subject.classRef.objectId
          || smalltalkClass.class?.imageId !== subject.imageId) {
        throw new TypeError('native class presentation requires the description of ITS OWN subject');
      }
      // The ordered activation-target array is the BROWSER's, threaded in.
      // Deriving it here would make this provider a second locus for the one
      // array that owns the key space — and a silent one.
      if (!Array.isArray(context.targets)) {
        throw new TypeError('native class presentation requires the browser-owned ordered targets array');
      }
      return new Presentation({
        id: nativeClassPresentationId(subject),
        subject,
        kind: NATIVE_CLASS_PRESENTATION_KIND,
        // The Images-owned description, preserved BY IDENTITY. No copied name,
        // selector array, layout or ref; no shadow class model.
        context: {smalltalkClass, targets: context.targets},
        state: {},
      });
    },
  });
}

function exactNativeClassPresentation({subject, presentations, failures}) {
  // Candidates are selected by SUBJECT, not by kind. Filtering on the kind first
  // would silently discard a second provider that answered the same subject with
  // a DIFFERENT kind — one plausible shape of the origin-selected route this
  // check exists to catch — leaving it invisible instead of loud.
  const candidates = presentations.filter((presentation) => (
    sameNativeClassSubject(presentation.subject, subject)
  ));
  const where = `${subject.imageId}/${subject.classRef.objectId}`;
  if (candidates.length !== 1) {
    throw new NativeClassPresentationError(
      candidates.length === 0
        ? `no native class presentation was discovered for ${where}`
        : `ambiguous native class presentations for ${where}: ${candidates.length}`,
      {failures},
    );
  }
  if (candidates[0].kind !== NATIVE_CLASS_PRESENTATION_KIND) {
    throw new NativeClassPresentationError(
      `the presentation discovered for ${where} is ${candidates[0].kind}, not ${NATIVE_CLASS_PRESENTATION_KIND}`,
      {failures},
    );
  }
  return candidates[0];
}

function createNativeSmalltalkBrowser({adapter, presentationRegistry, compositor} = {}) {
  if (!adapter || typeof adapter.describeSmalltalkClass !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires an adapter with describeSmalltalkClass');
  }
  // E3 (Bead eij.3): the WRITER-FACING method read replaces the plain describe as
  // this owner's method read. Not an extra read beside it -- an extra read would
  // pair a token with a resolution the user was never shown, and Images is
  // explicit that a hidden fresh read substituted for the caller's assumption
  // makes a lost update unobservable. One read, one resolution, one token.
  if (typeof adapter.readSmalltalkMethodForUpdate !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires an adapter with readSmalltalkMethodForUpdate');
  }
  if (typeof adapter.classifySmalltalkMethodReadError !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires adapter.classifySmalltalkMethodReadError');
  }
  if (typeof adapter.classifySmalltalkClassReadError !== 'function') {
    // Loud: without the interaction owner's mapping this module would have to
    // classify Images errors itself, which is precisely the second decider the
    // boundary forbids.
    throw new TypeError('createNativeSmalltalkBrowser requires adapter.classifySmalltalkClassReadError');
  }
  if (!presentationRegistry || typeof presentationRegistry.discover !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires a PresentationRegistry');
  }
  // REQUIRED, the ProjectBrowser precedent: this owner presents into one logical
  // view, and a browser that could not present would make `activationBinding`
  // a promise it cannot keep.
  // `liveView` joins the pair with E3: the transient method token is masked when
  // the Compositor no longer shows the exact descriptor it was paired with, and
  // liveness is the Compositor's call, never this owner's guess.
  if (!compositor
      || typeof compositor.openView !== 'function'
      || typeof compositor.presentOn !== 'function'
      || typeof compositor.liveView !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires a Compositor (openView, presentOn, liveView)');
  }

  /**
   * THE TRANSIENT NATIVE-METHOD REPLACEMENT TOKEN (E3, Bead eij.3; the okv
   * Slice B precedent). Images' writer-facing read answers
   * `{descriptor, versionToken}`; ONLY the descriptor reaches the Presentation.
   * The token is held here, privately, paired STRONGLY with the EXACT
   * presentationDescriptor object the Compositor admitted.
   *
   * It is paired only AFTER admission, CLEARED before every open/present (so a
   * failed read leaves no usable token), and MASKED at read time when the
   * Compositor no longer shows that exact descriptor as this owner's live view.
   * It never enters a Presentation, a presentationDescriptor, a SemanticUi
   * document, a durable intent, a Perspective or a subject, and this module never
   * interprets it or decides a conflict outcome -- Images owns the check and
   * CommandDispatcher owns the taxonomy.
   *
   * WEAKER THAN ProjectBrowser's ON PURPOSE, and the difference is licensed: that
   * owner has a generation counter and a serialized lane with unfiltered follow
   * rereads, so it pairs on identity + generation + active subject + liveness.
   * This owner has no generation and no follow loop -- its descriptor is replaced
   * only by its own open/present, each of which clears first -- so descriptor
   * IDENTITY plus Compositor LIVENESS is the whole of it. A structurally equal
   * copy is not the paired object and gets nothing.
   */
  let pairedMethod = null;
  function clearMethodToken() {
    pairedMethod = null;
  }
  function pairMethodToken({presentationDescriptor, versionToken}) {
    // A class descriptor, or a failed/denied method read, carries no token; the
    // pairing simply stays cleared rather than storing a null one.
    if (typeof versionToken !== 'string' || versionToken.length === 0) return;
    pairedMethod = Object.freeze({presentationDescriptor, versionToken});
  }

  /**
   * The consumer-owned transient-token supplier for the shell's input-binding
   * contract: the token paired with EXACTLY this displayed descriptor, or null.
   *
   * Null is not an error here -- it is the honest answer for a descriptor this
   * owner is not currently showing. The Command refuses a token-free replacement
   * loudly, which is where that refusal belongs.
   */
  function methodTokenFor(descriptor) {
    if (!pairedMethod || !descriptor) return null;
    if (descriptor !== pairedMethod.presentationDescriptor) return null;
    const live = compositor.liveView(NATIVE_SMALLTALK_VIEW_ID);
    if (!live || live.presentationDescriptor !== descriptor) return null;
    return pairedMethod.versionToken;
  }

  /**
   * The native-class presentationDescriptor: the Presentation's semantic
   * context as PLAIN data. Owned here, the way ProjectBrowser owns its own
   * (a descriptor is a consumer-facing projection, not a registry concern).
   */
  function toPresentationDescriptor(presentation) {
    const parameters = {...(presentation.context ?? {})};
    // THE ONE PRODUCTION AFFORDANCE (E3, Bead eij.3), threaded exactly the way
    // ProjectBrowser threads `writable`: it is this owner's fact about what a
    // displayed native method offers, not something Images said. A CLASS
    // descriptor gets none -- there is no class-level replacement -- and no other
    // descriptor kind is touched.
    if (presentation.kind === NATIVE_METHOD_PRESENTATION_KIND) parameters.inputs = NATIVE_METHOD_INPUTS;
    return {
      kind: presentation.kind,
      subject: presentation.subject,
      parameters,
    };
  }

  // A denied or failed read becomes the SAME materialized subject the generic
  // object lane uses, so it presents through the SAME unauthorized/unavailable
  // providers. There is no native-specific failure presentation, and the reason
  // is this module's fixed string — never an Images message.
  function readFailureSubject(subject, error) {
    const classification = adapter.classifySmalltalkClassReadError(error);
    const unauthorized = classification === 'unauthorized';
    return Object.freeze({
      kind: unauthorized ? UNAUTHORIZED_REF_KIND : UNAVAILABLE_REF_KIND,
      imageId: subject.imageId,
      objectId: subject.classRef.objectId,
      reason: unauthorized ? UNAUTHORIZED_REASON : UNAVAILABLE_REASON,
    });
  }

  /**
   * browse(subject, {authority}) -> Promise<Presentation>
   *
   * ONE authorized read of ONE class, then discovery. On success the result is
   * EXACTLY ONE native-class Presentation for that subject; 0 or >1 is a loud
   * NativeClassPresentationError, never a silent first-match. On failure the
   * result is the discovered unavailable/unauthorized Presentation for the
   * materialized subject.
   *
   * `authority` is threaded per call and NEVER stored. To browse a superclass
   * or class side, resolve its locator and call this again with THAT object's
   * authority: following a locator is a new authorization, not an inherited one.
   */
  async function browse(subject, {authority = null} = {}) {
    const required = requireNativeClassSubject(subject);
    let smalltalkClass = null;
    try {
      smalltalkClass = await adapter.describeSmalltalkClass({
        imageId: required.imageId,
        classRef: required.classRef,
        authority,
      });
    } catch (error) {
      const failed = readFailureSubject(required, error);
      // The generic providers read the reason from the SUBJECT (they take no
      // context), and the same exactly-one rule applies here: the failure path
      // must not quietly take a first match either.
      const {presentations, failures} = presentationRegistry.discover(failed);
      if (presentations.length !== 1) {
        throw new NativeClassPresentationError(
          presentations.length === 0
            ? `no presentation was discovered for a ${failed.kind} native class read of ${failed.imageId}/${failed.objectId}`
            : `ambiguous presentations for a ${failed.kind} native class read of ${failed.imageId}/${failed.objectId}: ${presentations.length}`,
          {failures},
        );
      }
      return presentations[0];
    }
    const context = {smalltalkClass, targets: nativeClassActivationTargets(required, smalltalkClass)};
    const {presentations, failures} = presentationRegistry.discover(required, context);
    return exactNativeClassPresentation({subject: required, presentations, failures});
  }

  // A failed METHOD read materializes through the same generic subjects, with
  // this module's own fixed reasons and the adapter's classification.
  function methodReadFailureSubject(subject, error) {
    const unauthorized = adapter.classifySmalltalkMethodReadError(error) === 'unauthorized';
    return Object.freeze({
      kind: unauthorized ? UNAUTHORIZED_REF_KIND : UNAVAILABLE_REF_KIND,
      imageId: subject.imageId,
      // The CLASS object is the thing the caller named and may already read; the
      // Block's id is deliberately not used, because a denied caller must not
      // learn it from a failure presentation.
      objectId: subject.classRef.objectId,
      reason: unauthorized ? METHOD_UNAUTHORIZED_REASON : METHOD_UNAVAILABLE_REASON,
    });
  }

  /**
   * browseMethod(subject, {authority}) -> Promise<Presentation>
   *
   * ONE authorized read of ONE method. This is a SECOND authorization, never a
   * richer reading of a class description: Images checks the class, resolves the
   * selector against that class's CURRENT dictionary, then checks the resolved
   * Block independently before disclosing its locator. Holding class-read
   * authority is therefore not enough, which is the point.
   */
  async function browseMethodWithToken(subject, {authority = null} = {}) {
    const required = requireNativeMethodSubject(subject);
    let read = null;
    try {
      read = await adapter.readSmalltalkMethodForUpdate({
        imageId: required.imageId,
        classRef: required.classRef,
        selector: required.selector,
        authority,
      });
    } catch (error) {
      const failed = methodReadFailureSubject(required, error);
      const {presentations, failures} = presentationRegistry.discover(failed);
      if (presentations.length !== 1) {
        throw new NativeClassPresentationError(
          presentations.length === 0
            ? `no presentation was discovered for a ${failed.kind} native method read of ${failed.imageId}/${failed.objectId}`
            : `ambiguous presentations for a ${failed.kind} native method read of ${failed.imageId}/${failed.objectId}: ${presentations.length}`,
          {failures},
        );
      }
      return Object.freeze({presentation: presentations[0], versionToken: null});
    }
    // SHAPE ONLY (presence + string-ness), the ProjectBrowser rule: the token is
    // never interpreted here, and this owner has no code that could look inside
    // it. Checked OUTSIDE the catch above ON PURPOSE -- a broken seam is a
    // PROGRAMMER error, not a denied or missing method, and classifying it as one
    // would present an affordance that renders and then always refuses. (It was
    // inside at first, and the falsifier below caught exactly that.)
    if (!read || typeof read !== 'object' || !read.descriptor || typeof read.descriptor !== 'object'
        || typeof read.versionToken !== 'string' || read.versionToken.length === 0) {
      throw new TypeError('adapter.readSmalltalkMethodForUpdate must return {descriptor, versionToken} (the writer-facing Images method read)');
    }
    const smalltalkMethod = read.descriptor;
    const versionToken = read.versionToken;
    const {presentations, failures} = presentationRegistry.discover(required, {smalltalkMethod});
    const candidates = presentations.filter((presentation) => (
      sameNativeMethodSubject(presentation.subject, required)
    ));
    const where = `${required.imageId}/${required.classRef.objectId}>>${required.selector}`;
    if (candidates.length !== 1) {
      throw new NativeClassPresentationError(
        candidates.length === 0
          ? `no native method presentation was discovered for ${where}`
          : `ambiguous native method presentations for ${where}: ${candidates.length}`,
        {failures},
      );
    }
    if (candidates[0].kind !== NATIVE_METHOD_PRESENTATION_KIND) {
      throw new NativeClassPresentationError(
        `the presentation discovered for ${where} is ${candidates[0].kind}, not ${NATIVE_METHOD_PRESENTATION_KIND}`,
        {failures},
      );
    }
    return Object.freeze({presentation: candidates[0], versionToken});
  }

  /**
   * PUBLIC and deliberately TOKEN-FREE (the ProjectBrowser rule): a browse-obtained
   * token would be a second, unpaired token source, and the only token that may
   * ever be used is the one paired with a descriptor the Compositor is SHOWING.
   */
  async function browseMethod(subject, options = {}) {
    return (await browseMethodWithToken(subject, options)).presentation;
  }

  // Browse a subject of EITHER kind. The only place that maps a semantic target
  // to the read it implies — one small dispatch, in the owner that defines both
  // subject kinds, so the shell never learns what a target means.
  async function browseTargetWithToken(target, {authority = null} = {}) {
    if (target?.kind === NATIVE_METHOD_SUBJECT_KIND) return browseMethodWithToken(target, {authority});
    // A CLASS carries no replacement token: there is no class-level replacement,
    // and answering one here would be a token with nothing to pair it to.
    return Object.freeze({presentation: await browse(target, {authority}), versionToken: null});
  }

  async function browseTarget(target, options = {}) {
    return (await browseTargetWithToken(target, options)).presentation;
  }

  /**
   * open(subject, {authority, viewDescriptor}) — read, then admit ONE logical
   * native Smalltalk view through the Compositor.
   */
  async function open(subject, {authority = null, viewDescriptor} = {}) {
    clearMethodToken(); // the previously displayed method's token dies here
    const {presentation, versionToken} = await browseTargetWithToken(subject, {authority});
    const presentationDescriptor = toPresentationDescriptor(presentation);
    await compositor.openView({viewId: NATIVE_SMALLTALK_VIEW_ID, viewDescriptor, presentationDescriptor});
    // AFTER admission, never before: a token paired with a descriptor the
    // Compositor rejected would be usable against something nobody is looking at.
    pairMethodToken({presentationDescriptor, versionToken});
    return presentationDescriptor;
  }

  /**
   * present(subject, {authority}) — read afresh and re-present into the SAME
   * logical view. Class and method descriptors share it; presentOn detaches
   * before attaching, so the kind change is an ordinary re-presentation.
   */
  async function present(subject, {authority = null} = {}) {
    clearMethodToken();
    const {presentation, versionToken} = await browseTargetWithToken(subject, {authority});
    const presentationDescriptor = toPresentationDescriptor(presentation);
    await compositor.presentOn(NATIVE_SMALLTALK_VIEW_ID, presentationDescriptor);
    pairMethodToken({presentationDescriptor, versionToken});
    return presentationDescriptor;
  }

  /**
   * The activation binding this owner contributes to EnvironmentShell's one
   * activation table (ownership row 64). The shell owns handle -> live view,
   * binding choice, resolver validation and delegation; this owner supplies the
   * pure resolver over its own key space and the consumer that says what a
   * target MEANS.
   *
   * `authorityFor(target)` is the COMPOSITION's: authority is fresh per
   * navigation action and is never inherited from the subject, the descriptor or
   * the shell (the delegated context carries none, by design). Error reporting
   * stays with the composition too, through bindIntents' top-level
   * onActivateError — the ProjectBrowser precedent, which likewise leaves
   * onEdited/onEditError to its composition.
   */
  function activationBinding({authorityFor} = {}) {
    if (typeof authorityFor !== 'function') {
      throw new TypeError('activationBinding requires authorityFor(target) — authority is per action, never inherited');
    }
    return Object.freeze({
      viewId: NATIVE_SMALLTALK_VIEW_ID,
      resolveItem: resolveNativeTarget,
      activateTarget: async (target) => present(target, {authority: authorityFor(target)}),
    });
  }

  /**
   * The REPLACEMENT INPUT BINDING this owner contributes to EnvironmentShell's
   * input table (E3, Bead eij.3) — the third table, beside activation and edit.
   *
   * The shell owns handle -> live view, binding choice, resolver validation and
   * dispatch through the CommandRouter. This owner supplies what only it can
   * know: its view id, the EXPLICIT commandId (never a hint -- Bead 4c4), the
   * pure resolver over its own input array, the transient token supplier, and
   * THE MUTATION -> REREAD ORCHESTRATION, which is this owner's by definition.
   *
   * REREAD, NEVER PATCH. A completed replacement is followed by a FRESH
   * AUTHORIZED READ of the same method, re-presented into the same view. Nothing
   * is copied out of Images' receipt -- it carries `{replaced: true}` and
   * deliberately nothing else -- and nothing local is patched. A successful
   * replacement legitimately rebinds the selector to a FRESH Block identity, so
   * the only honest displayed truth is what a new authorized read answers.
   *
   * A CONFLICT IS ALSO REREAD, and that is the point of surfacing it: the
   * caller's observation was overtaken, so the view is showing a method position
   * that has moved. The error is reported to the composition FIRST (it owns
   * failure presentation, the ProjectBrowser precedent) and the authoritative
   * reread follows. Every OTHER failure -- denied write, malformed call, rejected
   * source, transient contention -- leaves the display alone, because in every
   * one of those the observed position did not move and the descriptor on screen
   * is still exactly what Images would answer.
   *
   * `authorityFor(subject)` is the COMPOSITION's: authority is fresh per action
   * and never inherited from a subject, a descriptor, a token or this owner.
   */
  function replacementInputBinding({authorityFor, onReplacementError} = {}) {
    if (typeof authorityFor !== 'function') {
      throw new TypeError('replacementInputBinding requires authorityFor(subject) — authority is per action, never inherited');
    }
    if (typeof onReplacementError !== 'function') {
      // The shell requires an error channel on every input binding (Bead z9b);
      // requiring it HERE too means the composition cannot accidentally build a
      // replacement affordance whose failures are invisible.
      throw new TypeError('replacementInputBinding requires onReplacementError(error) — the composition owns failure presentation');
    }

    // The method currently ON SCREEN, from the Compositor's own live view. Never
    // remembered here: what to reread is a property of what is displayed now.
    function displayedMethodSubject() {
      const live = compositor.liveView(NATIVE_SMALLTALK_VIEW_ID);
      const subject = live?.presentationDescriptor?.subject ?? null;
      return subject?.kind === NATIVE_METHOD_SUBJECT_KIND ? subject : null;
    }

    async function rereadDisplayedMethod() {
      const subject = displayedMethodSubject();
      if (!subject) return null; // the view moved on; there is nothing to reread
      return present(subject, {authority: authorityFor(subject)});
    }

    return Object.freeze({
      viewId: NATIVE_SMALLTALK_VIEW_ID,
      commandId: REPLACE_NATIVE_METHOD_COMMAND_ID,
      resolveInput: resolveMethodReplacementInput,
      tokenFor: methodTokenFor,
      onSubmitted: async (result) => {
        // `null` is the router saying "not routed" (the view is gone / has no
        // subject / nothing applies) -- not a replacement, so nothing to reread.
        // Anything else means the Command ran; its VALUE is not inspected.
        if (result === null || result === undefined) return null;
        return rereadDisplayedMethod();
      },
      onInputError: async (error) => {
        // REPORTING MUST NOT VETO RECOVERY. The composition owns failure
        // presentation, and it is told first -- but a reporter that THROWS must not
        // leave the view showing a method position that has moved. An earlier
        // version awaited the reporter directly, so its failure skipped the reread
        // entirely and the stale display survived; a review caught it and the
        // falsifier for it now lives beside the others.
        let reportFailure = null;
        try {
          await onReplacementError(error);
        } catch (failure) {
          reportFailure = failure;
        }

        // The Environment's OWN conflict outcome (CommandDispatcher's taxonomy),
        // not an Images error class: a lost update means the position moved, so
        // the display is stale and must be replaced by authoritative truth.
        // Images' transient contention deliberately does NOT arrive as one, and a
        // still-current display is left exactly as it is.
        if (error?.name === 'CommandConflictError') {
          try {
            await rereadDisplayedMethod();
          } catch (rereadError) {
            // Reported at most ONCE, and never followed by another reread: a
            // reporting loop would be worse than the failure it reports. A reporter
            // that is already known to throw is not asked again.
            if (reportFailure === null) {
              try {
                await onReplacementError(rereadError);
              } catch (secondFailure) {
                reportFailure = secondFailure;
              }
            }
          }
        }

        // Surfaced only AFTER recovery, and contained by the shell's own
        // report path (`reportInputError` swallows a failing reporter so it cannot
        // start a second reporting loop). Rethrowing keeps a broken reporter from
        // being invisible without letting it block the repair.
        if (reportFailure !== null) throw reportFailure;
        return null;
      },
    });
  }

  return Object.freeze({
    viewId: NATIVE_SMALLTALK_VIEW_ID,
    browse,
    browseMethod,
    browseTarget,
    open,
    present,
    activationBinding,
    replacementInputBinding,
    toPresentationDescriptor,
  });
}

export {
  LOCATOR_RELATION,
  NATIVE_METHOD_INPUTS,
  NATIVE_METHOD_SOURCE_INPUT_ROLE,
  NATIVE_SMALLTALK_VIEW_ID,
  REPLACE_NATIVE_METHOD_COMMAND_ID,
  TARGET_GROUP,
  NATIVE_CLASS_PRESENTATION_KIND,
  NATIVE_CLASS_SUBJECT_KIND,
  NATIVE_METHOD_PRESENTATION_KIND,
  NATIVE_METHOD_SUBJECT_KIND,
  NativeClassPresentationError,
  SMALLTALK_CLASS_DESCRIPTION_V1,
  SMALLTALK_METHOD_DESCRIPTION_V1,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeMethodPresentationProvider,
  createNativeMethodSubject,
  createNativeSmalltalkBrowser,
  createReplaceNativeMethodCommand,
  resolveMethodReplacementInput,
  // nativeClassActivationTargets is deliberately NOT exported: the ordered array
  // has ONE locus (browse), and an importable builder would quietly reopen the
  // second one the provider's fallback used to be.
  resolveNativeTarget,
};
