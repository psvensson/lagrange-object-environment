import {Presentation} from './model.js';
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
 * SELECTOR NAMES ARE NOT METHODS. The description exposes the class's own
 * canonical selector names and no method refs. Class-read authority may show
 * that `foo` exists; it must not reveal the Block that implements it. The
 * adapter exposes no method seam at all, so that is structurally true here
 * rather than merely untested. E2 adds method browsing with its own,
 * independent Block authorization.
 *
 * NOT OWNED HERE: discovery (`PresentationRegistry`), rendering, view admission
 * and lifecycle (`Compositor`), generic object navigation (`ObjectNavigator`),
 * and the renderer activate-item -> semantic ref coupling (`EnvironmentShell`,
 * ownership row 64; routing an ACTIVATED locator to this browser is Bead
 * lagrange-object-environment-gzz, with E2). A native-class Presentation is
 * deliberately NOT Perspective-persistable — `encodePresentations` requires a
 * ref subject — exactly as a Project Presentation is not.
 */

const NATIVE_CLASS_SUBJECT_KIND = 'native-class';
const NATIVE_CLASS_PRESENTATION_KIND = 'native-class';
const SMALLTALK_CLASS_DESCRIPTION_V1 = 'smalltalk-class-description/v1';

// The relations a class description owns and that a browser may follow. Each is
// a LOCATOR naming an independently authoritative object, never an inherited
// grant. The kernel stores class -> metaclass and no inverse, so there is no
// "instance side" relation to offer from a Metaclass: a browser that wants to
// toggle sides keeps the ref it started from.
const LOCATOR_RELATION = Object.freeze({
  SUPERCLASS: 'superclass',
  CLASS_SIDE: 'class-side',
});

// The reasons a failed browse presents. FIXED and Environment-owned: Images'
// own browse messages legitimately name storage (`not a
// smalltalk/behavior-shape/v1 behavior: <id>`), and rendering one would put an
// Images storage shape id in the UI. The adapter classifies; this module only
// names the outcome. Bead azj records what the collapse costs.
const UNAUTHORIZED_REASON = 'not authorized to read this native class';
const UNAVAILABLE_REASON = 'this native class could not be read';

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
 * The ordered locator list for one description: the SINGLE list a consumer
 * indexes. The refs are the description's own, held BY IDENTITY; a null
 * relation is skipped, so a root class contributes no superclass row and a
 * Metaclass contributes no class-side row (the kernel's `nil` terminates the
 * chain — a root class does not have a superclass named "nil").
 */
function nativeClassLocators(description) {
  const locators = [];
  if (description.superclass) {
    locators.push(Object.freeze({relation: LOCATOR_RELATION.SUPERCLASS, ref: description.superclass}));
  }
  if (description.classSide) {
    locators.push(Object.freeze({relation: LOCATOR_RELATION.CLASS_SIDE, ref: description.classSide}));
  }
  return Object.freeze(locators);
}

/**
 * Resolve one locator of the CURRENT native-class presentation descriptor to
 * the Images ref it names, or null. PURE over the descriptor and over the same
 * ordered array the projector renders, so there is no second decider. The
 * returned ref is a locator: browsing it needs its own authority.
 */
function resolveNativeClassLocator(presentationDescriptor, key) {
  if (presentationDescriptor?.kind !== NATIVE_CLASS_PRESENTATION_KIND) return null;
  const locators = presentationDescriptor?.parameters?.locators;
  if (!Array.isArray(locators)
      || !Number.isSafeInteger(key) || key < 0 || key >= locators.length) {
    return null;
  }
  const ref = locators[key]?.ref;
  if (!ref || ref.kind !== 'ref'
      || typeof ref.imageId !== 'string' || ref.imageId.length === 0
      || typeof ref.objectId !== 'string' || ref.objectId.length === 0) {
    return null;
  }
  return ref;
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
      // The ordered locator list is the BROWSER's, threaded in. Falling back to
      // deriving it here would make this provider a second locus for the list
      // the ownership registry says the browser solely owns — and a silent one.
      if (!Array.isArray(context.locators)) {
        throw new TypeError('native class presentation requires the browser-owned ordered locators array');
      }
      return new Presentation({
        id: nativeClassPresentationId(subject),
        subject,
        kind: NATIVE_CLASS_PRESENTATION_KIND,
        // The Images-owned description, preserved BY IDENTITY. No copied name,
        // selector array, layout or ref; no shadow class model.
        context: {smalltalkClass, locators: context.locators},
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

function createNativeSmalltalkBrowser({adapter, presentationRegistry} = {}) {
  if (!adapter || typeof adapter.describeSmalltalkClass !== 'function') {
    throw new TypeError('createNativeSmalltalkBrowser requires an adapter with describeSmalltalkClass');
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

  /**
   * The native-class presentationDescriptor: the Presentation's semantic
   * context as PLAIN data. Owned here, the way ProjectBrowser owns its own
   * (a descriptor is a consumer-facing projection, not a registry concern).
   */
  function toPresentationDescriptor(presentation) {
    return {
      kind: presentation.kind,
      subject: presentation.subject,
      parameters: {...(presentation.context ?? {})},
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
    const context = {smalltalkClass, locators: nativeClassLocators(smalltalkClass)};
    const {presentations, failures} = presentationRegistry.discover(required, context);
    return exactNativeClassPresentation({subject: required, presentations, failures});
  }

  return Object.freeze({browse, toPresentationDescriptor});
}

export {
  LOCATOR_RELATION,
  NATIVE_CLASS_PRESENTATION_KIND,
  NATIVE_CLASS_SUBJECT_KIND,
  NativeClassPresentationError,
  SMALLTALK_CLASS_DESCRIPTION_V1,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeSmalltalkBrowser,
  nativeClassLocators,
  resolveNativeClassLocator,
};
