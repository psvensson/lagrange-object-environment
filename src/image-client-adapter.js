import {observeChanges} from './image-observation.js';
import {createCommandDispatcher} from './command-dispatcher.js';

/**
 * The ImageClientAdapter: the single owner of the Object Environment ->
 * Lagrange Images interaction (docs/ownership.md).
 *
 * This module composes the three verified pure cores against a REAL
 * lagrange-images runtime:
 *   - perspective-projection.js  (ADR 0008)  [blocked on substrate gap 6tm]
 *   - image-observation.js       (ADR 0009)  -> observe()
 *   - command-dispatcher.js      (ADR 0010)  -> dispatch()
 *
 * Renderer-independence and ADR 0002 are preserved by injection: the adapter
 * takes the lagrange-images public surface as an injected `client` and never
 * imports the substrate itself. `src/` stays dependency-free; the real wiring
 * lives in an integration test that resolves the sibling repo.
 *
 * Scope honesty: this slice proves the live loop with a leaf/edge-shaped
 * object. It does NOT save/load Perspectives — ADR 0008's nested presentations
 * and JSON metadata cannot cross image-creation-binding/v1 (leaf fields, slots
 * only, metadata hardcoded {}). That is the downward-proposal gap tracked
 * separately; see the Bead graph.
 */

// A Perspective-class / probe record uses the ADR 0008 shape vocabulary, but
// only the parts image-creation-binding/v1 can express: leaf (text) fields and
// ref/pinned-ref edge fields. Nested values and metadata are not writable here.
const PROBE_SHAPE_SLOTS = Object.freeze([
  {id: 'probe-title', name: 'title'},
  {id: 'probe-subject', name: 'subject'},
]);

// The callable-interface/v2 record type for the probe: title is a leaf string,
// subject is an edge target id travelling as a string (the lane canonicalizes
// it to a ref host-side). Declared once so the interface and the call agree.
const PROBE_TYPE_NAME = 'probe';
const PROBE_TYPE_DECLARATIONS = Object.freeze({
  [PROBE_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'title', type: 'string'}),
      Object.freeze({name: 'subject', type: 'string'}),
    ]),
  }),
});

/**
 * Map an ADR 0008 ref/pinned-ref Value to the edge-target string the creation
 * lane expects (parseEdgeTarget: '<id>' or 'pin:<id>@<revision>').
 *
 * The lane RE-HOMES a bare id string into the binding's image, so a ref naming
 * a DIFFERENT image must be rejected here, before the lane — otherwise the
 * adapter would silently point the edge at a same-named object in the wrong
 * image.
 */
function refToEdgeString(ref, imageId) {
  if (!ref || typeof ref !== 'object' || (ref.kind !== 'ref' && ref.kind !== 'pinned-ref')) {
    throw new TypeError(`edge subject must be a ref or pinned-ref Value, got kind ${ref?.kind}`);
  }
  if (ref.imageId !== imageId) {
    throw new TypeError(
      `edge subject must be in image ${imageId}; the creation lane cannot reference ${ref.imageId}`,
    );
  }
  if (ref.kind === 'ref') {
    return ref.objectId;
  }
  return `pin:${ref.objectId}@${ref.revision}`;
}

function createImageClientAdapter(client) {
  if (!client || typeof client !== 'object') {
    throw new TypeError('createImageClientAdapter requires the lagrange-images public surface');
  }
  for (const service of ['images', 'invocations', 'executor']) {
    if (!client[service] || typeof client[service] !== 'object') {
      throw new TypeError(`lagrange-images client is missing required service: ${service}`);
    }
  }
  const {
    images,
    invocations,
    executor,
    // Helpers consumed from the public exports (createRuntime's module barrels).
    defineClass,
    installCallableInterfaceV2,
    installImageCreationBinding,
    findSmalltalkKernel,
    objectRef,
    objectResource,
    parseObjectResource,
    textValue,
    packCompositeValue,
    normalizeTypeDeclarations,
  } = client;

  for (const [name, fn] of Object.entries({defineClass, installCallableInterfaceV2, installImageCreationBinding, findSmalltalkKernel, objectRef, objectResource, parseObjectResource, textValue, packCompositeValue, normalizeTypeDeclarations})) {
    if (typeof fn !== 'function') {
      throw new TypeError(`lagrange-images client is missing required helper: ${name}`);
    }
  }

  const objectIdFromVersionToken = makeObjectIdDecoder(objectResource, parseObjectResource);

  const dispatcher = createCommandDispatcher({
    image: async ({command, subject, authority, context}) => {
      return command.invoke(subject, {...context, authority, adapter: api});
    },
  });

  /**
   * Provision the probe/class schema into an image, idempotently. The kernel
   * is a PRECONDITION: it is checked and reported, never silently installed on
   * a foreign image.
   */
  async function ensureSchema(imageId, {shapeId, className, interfaceId, bindingId, blockId} = {}) {
    // Validate ids eagerly: a missing id would otherwise flow into the
    // substrate as undefined (or, for putShape, mint a random id and silently
    // break idempotence), surfacing a confusing error far from the cause.
    for (const [key, value] of Object.entries({shapeId, className, interfaceId, bindingId, blockId})) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`ensureSchema requires a non-empty ids.${key}`);
      }
    }
    const kernel = await findSmalltalkKernel({images, imageId});
    if (!kernel) {
      throw new TypeError(`image ${imageId} has no Smalltalk kernel; provision one before installing the environment schema`);
    }

    let shape = await images.getShape(imageId, shapeId);
    if (!shape) {
      shape = await images.putShape(imageId, {id: shapeId, slots: PROBE_SHAPE_SLOTS});
    }

    let classRecord = await images.getObject(imageId, classIdFor(className));
    if (!classRecord) {
      await defineClass({
        images,
        imageId,
        name: className,
        instanceShapeRef: objectRef(imageId, shapeId),
      });
      classRecord = await images.getObject(imageId, classIdFor(className));
    }

    const interfaceRef = objectRef(imageId, interfaceId);
    if (!(await images.getCodeArtifact(imageId, interfaceId))) {
      await installCallableInterfaceV2({
        images,
        imageId,
        functionName: 'create',
        parameters: ['string', PROBE_TYPE_NAME],
        result: 'string',
        types: PROBE_TYPE_DECLARATIONS,
        interfaceId,
      });
    }

    if (!(await images.getBlock(imageId, blockId))) {
      await installImageCreationBinding({
        images,
        callableInterface: interfaceRef,
        imageId,
        fields: [
          {name: 'title', slot: 'probe-title', edge: false},
          {name: 'subject', slot: 'probe-subject', edge: true},
        ],
        bindingId,
        blockId,
      });
    }

    return Object.freeze({shape, classRecord, interfaceRef, blockRef: objectRef(imageId, blockId)});
  }

  /**
   * Create a probe object through the authorized creation lane. Returns
   * {objectId, versionToken}. Authority (object/create on the class, plus
   * object/edge-write on the subject target) is passed through per call.
   */
  async function createObject({imageId, classId, title, subject, authority, blockId}) {
    const subjectString = refToEdgeString(subject, imageId);
    const types = normalizeTypeDeclarations(PROBE_TYPE_DECLARATIONS);
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [
      textValue(classId),
      packCompositeValue({title, subject: subjectString}, PROBE_TYPE_NAME, types),
    ]);
    const result = await executor.execute(activation, {authority});
    const token = result?.value;
    // The create lane returns only the object-scoped version token
    // (object-version/v0:<scope>:<version>). The scope embeds the minted id via
    // objectResource, so the id is recovered by decoding the token's scope; the
    // token itself remains the concurrency proof (ADR 0062 §6).
    const objectId = objectIdFromVersionToken(token, imageId);
    return Object.freeze({objectId, versionToken: token});
  }

  // Reads return the substrate's stored record; slot Values are already in the
  // ADR 0008 ref/pinned-ref form, so no adapter transform is applied here.
  async function readObject(imageId, objectId) {
    return await images.getObject(imageId, objectId);
  }

  function observe(imageId, options = {}) {
    return observeChanges({
      poll: (afterRevision) => images.history(imageId, {afterRevision}),
      ...options,
    });
  }

  async function dispatch(command, subject, {authority = null, context = {}} = {}) {
    return dispatcher.dispatch({command, subject, authority, context});
  }

  const api = Object.freeze({
    ensureSchema,
    createObject,
    readObject,
    observe,
    dispatch,
    refToEdgeString: (ref, imageId) => refToEdgeString(ref, imageId),
  });
  return api;
}

function classIdFor(className) {
  return `smalltalk/class/${className}`;
}

// Decode the object id embedded in an object-scoped version token's scope, via
// the public objectResource/parseObjectResource codec (never string-splitting,
// which ADR 0039 forbids).
function makeObjectIdDecoder(objectResource, parseObjectResource) {
  return function objectIdFromVersionToken(token, imageId) {
    if (typeof token !== 'string') {
      throw new TypeError('creation did not return a version token');
    }
    const parts = token.split(':');
    if (parts.length !== 3) {
      throw new TypeError('malformed object version token');
    }
    const {imageId: scopeImage, objectId} = parseObjectResource(parts[1]);
    // Sanity: re-encoding must reproduce the scope, and the image must match.
    if (objectResource(scopeImage, objectId) !== parts[1] || scopeImage !== imageId) {
      throw new TypeError('object version token scope does not match the image');
    }
    return objectId;
  };
}

export {
  PROBE_SHAPE_SLOTS,
  PROBE_TYPE_DECLARATIONS,
  classIdFor,
  createImageClientAdapter,
  refToEdgeString,
};
