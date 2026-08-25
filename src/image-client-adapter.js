import {observeChanges} from './image-observation.js';
import {createCommandDispatcher} from './command-dispatcher.js';
import {decodePerspective, encodePerspectiveRecord, encodePresentations} from './perspective-projection.js';

/**
 * The ImageClientAdapter: the single owner of the Object Environment ->
 * Lagrange Images interaction (docs/ownership.md).
 *
 * This module composes the three verified pure cores against a REAL
 * lagrange-images runtime:
 *   - perspective-projection.js  (ADR 0012)  [child-object form; save/load planned]
 *   - image-observation.js       (ADR 0009)  -> observe()
 *   - command-dispatcher.js      (ADR 0010)  -> dispatch()
 *
 * Renderer-independence and ADR 0002 are preserved by injection: the adapter
 * takes the lagrange-images public surface as an injected `client` and never
 * imports the substrate itself. `src/` stays dependency-free; the real wiring
 * lives in an integration test that resolves the sibling repo.
 *
 * Scope honesty: the leaf/edge probe (`createObject`) and the Perspective
 * save/load round trip (`savePerspective`/`loadPerspective`) are both proven
 * against a real runtime. The Perspective uses the ADR 0012 indexed form
 * (formatVersion 3): a Perspective object holding its ordered presentation
 * refs in its indexed part, plus one child object per presentation — created
 * presentations-first, Perspective-last (the Perspective is the commit point,
 * substrate ADR 0064 §6).
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

// The probe mutation lane (image-mutation-binding/v1, ADR 0042/0010): writes a
// leaf slot on an EXISTING object under object/write + an optimistic-concurrency
// version token. Only the leaf title is mutable here (v1 slot writes are
// leaf-only); the type carries just the mutable field.
const PROBE_MUTATION_TYPE_NAME = 'probe-mutation';
const PROBE_MUTATION_TYPE_DECLARATIONS = Object.freeze({
  [PROBE_MUTATION_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'title', type: 'string'}),
    ]),
  }),
});
const PROBE_MUTATION_FIELDS = Object.freeze([
  Object.freeze({name: 'title', slot: 'probe-title'}),
]);

// --- The authorized whole-record object-read lane (image-object-read-binding/v1,
// substrate ADR 0068) --------------------------------------------------------
//
// The environment's SINGLE user-facing "read an object" seam. Unlike the
// creation/mutation lanes it maps nothing: the lane returns the COMPLETE
// generic object (every named slot + the indexed part verbatim) plus an opaque
// version token, under require({operation: 'object/read', resource}). The
// composite codec is ref-free, so the record crosses as a record of lists; each
// slot-entry/slot-value carries the canonical JSON of a stored Value as a
// string, so refs/pinned-refs survive as identity (never followed).
//
// `object-record` keys slots by durable slot id; `object-read-result` couples
// the token to the same read the value came from.
const OBJECT_READ_TYPE_DECLARATIONS = Object.freeze({
  'slot-value': Object.freeze({
    kind: 'record',
    fields: Object.freeze([Object.freeze({name: 'value', type: 'string'})]),
  }),
  'slot-entry': Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'name', type: 'string'}),
      Object.freeze({name: 'value', type: 'slot-value'}),
    ]),
  }),
  'object-record': Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'slots', type: Object.freeze({kind: 'list', element: 'slot-entry'})}),
      Object.freeze({name: 'indexed', type: Object.freeze({kind: 'list', element: 'slot-value'})}),
    ]),
  }),
  'object-read-result': Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'version-token', type: 'string'}),
      Object.freeze({name: 'value', type: 'object-record'}),
    ]),
  }),
});

// --- Perspective schema (ADR 0012 indexed form, formatVersion 3) -------------
//
// The Perspective object: leaf slots for scalars, plus an ordered INDEXED part
// of presentation refs (the membership + ordering, one owner). The class has
// an indexed instance Shape (indexed: 'values').
const PERSPECTIVE_SHAPE_SLOTS = Object.freeze([
  {id: 'persp-subject', name: 'subject'},
  {id: 'persp-title', name: 'title'},
  {id: 'persp-layout', name: 'layout'},
  {id: 'persp-format', name: 'formatVersion'},
]);
// The presentation child object: leaf scalars + a ref edge to its subject. No
// ordinal, no perspective back-edge (order/membership live on the parent).
const PRESENTATION_SHAPE_SLOTS = Object.freeze([
  {id: 'pres-subject', name: 'subject'},
  {id: 'pres-id', name: 'id'},
  {id: 'pres-kind', name: 'kind'},
  {id: 'pres-context', name: 'context'},
  {id: 'pres-state', name: 'state'},
]);

// The Perspective creation record: scalar slots travel as strings (layout and
// formatVersion too — the lane stores them as text/integer per the binding),
// and `presentations` is the ONE edge indexed field: a list<string> of
// ref-target ids, canonicalized per-element by the lane (object/edge-write).
const PERSPECTIVE_TYPE_NAME = 'perspective';
const PERSPECTIVE_TYPE_DECLARATIONS = Object.freeze({
  [PERSPECTIVE_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'subject', type: 'string'}),
      Object.freeze({name: 'title', type: 'string'}),
      Object.freeze({name: 'layout', type: 'string'}),
      Object.freeze({name: 'format-version', type: 'string'}),
      Object.freeze({name: 'presentations', type: Object.freeze({kind: 'list', element: 'string'})}),
    ]),
  }),
});
const PERSPECTIVE_FIELDS = Object.freeze([
  Object.freeze({name: 'subject', slot: 'persp-subject', edge: true}),
  Object.freeze({name: 'title', slot: 'persp-title'}),
  Object.freeze({name: 'layout', slot: 'persp-layout'}),
  Object.freeze({name: 'format-version', slot: 'persp-format'}),
  Object.freeze({name: 'presentations', indexed: true, edge: true}),
]);

// The presentation child creation record: leaf strings + one edge (subject).
const PRESENTATION_TYPE_NAME = 'presentation';
const PRESENTATION_TYPE_DECLARATIONS = Object.freeze({
  [PRESENTATION_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'subject', type: 'string'}),
      Object.freeze({name: 'id', type: 'string'}),
      Object.freeze({name: 'kind', type: 'string'}),
      Object.freeze({name: 'context', type: 'string'}),
      Object.freeze({name: 'state', type: 'string'}),
    ]),
  }),
});
const PRESENTATION_FIELDS = Object.freeze([
  Object.freeze({name: 'subject', slot: 'pres-subject', edge: true}),
  Object.freeze({name: 'id', slot: 'pres-id'}),
  Object.freeze({name: 'kind', slot: 'pres-kind'}),
  Object.freeze({name: 'context', slot: 'pres-context'}),
  Object.freeze({name: 'state', slot: 'pres-state'}),
]);

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
    installImageMutationBinding,
    installImageObjectReadBinding,
    findSmalltalkKernel,
    objectRef,
    objectResource,
    parseObjectResource,
    objectVersionToken,
    textValue,
    packCompositeValue,
    unpackCompositeValue,
    normalizeTypeDeclarations,
  } = client;

  for (const [name, fn] of Object.entries({defineClass, installCallableInterfaceV2, installImageCreationBinding, installImageMutationBinding, installImageObjectReadBinding, findSmalltalkKernel, objectRef, objectResource, parseObjectResource, objectVersionToken, textValue, packCompositeValue, unpackCompositeValue, normalizeTypeDeclarations})) {
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
  async function ensureSchema(imageId, {shapeId, className, interfaceId, bindingId, blockId, mutationInterfaceId, mutationBindingId, mutationBlockId, readInterfaceId, readBindingId, readBlockId} = {}) {
    // Validate ids eagerly: a missing id would otherwise flow into the
    // substrate as undefined (or, for putShape, mint a random id and silently
    // break idempotence), surfacing a confusing error far from the cause.
    for (const [key, value] of Object.entries({shapeId, className, interfaceId, bindingId, blockId, mutationInterfaceId, mutationBindingId, mutationBlockId, readInterfaceId, readBindingId, readBlockId})) {
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

    // Control-plane/schema read (trusted host), not a user-facing object read.
    let classRecord = await images.getObject(imageId, classIdFor(className));
    if (!classRecord) {
      await defineClass({
        images,
        imageId,
        name: className,
        instanceShapeRef: objectRef(imageId, shapeId),
      });
      // Control-plane/schema read (trusted host), not a user-facing object read.
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

    // The mutation lane (image-mutation-binding/v1): writes a leaf slot on an
    // existing object under object/write + a version token.
    const mutationInterfaceRef = objectRef(imageId, mutationInterfaceId);
    if (!(await images.getCodeArtifact(imageId, mutationInterfaceId))) {
      await installCallableInterfaceV2({
        images,
        imageId,
        functionName: 'mutate',
        parameters: ['string', 'string', PROBE_MUTATION_TYPE_NAME],
        result: 'string',
        types: PROBE_MUTATION_TYPE_DECLARATIONS,
        interfaceId: mutationInterfaceId,
      });
    }
    if (!(await images.getBlock(imageId, mutationBlockId))) {
      await installImageMutationBinding({
        images,
        callableInterface: mutationInterfaceRef,
        imageId,
        fields: PROBE_MUTATION_FIELDS,
        bindingId: mutationBindingId,
        blockId: mutationBlockId,
      });
    }

    // The authorized whole-record read lane (image-object-read-binding/v1,
    // substrate ADR 0068): the environment's single user-facing read seam.
    const readInterfaceRef = objectRef(imageId, readInterfaceId);
    if (!(await images.getCodeArtifact(imageId, readInterfaceId))) {
      await installCallableInterfaceV2({
        images,
        imageId,
        functionName: 'read-object',
        parameters: ['string'],
        result: 'object-read-result',
        types: OBJECT_READ_TYPE_DECLARATIONS,
        interfaceId: readInterfaceId,
      });
    }
    if (!(await images.getBlock(imageId, readBlockId))) {
      await installImageObjectReadBinding({
        images,
        callableInterface: readInterfaceRef,
        imageId,
        bindingId: readBindingId,
        blockId: readBlockId,
      });
    }

    return Object.freeze({
      shape, classRecord, interfaceRef, blockRef: objectRef(imageId, blockId),
      mutationBlockRef: objectRef(imageId, mutationBlockId),
      readBlockRef: objectRef(imageId, readBlockId),
    });
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

  /**
   * Mutate a leaf slot on an EXISTING object through the authorized mutation
   * lane (image-mutation-binding/v1, ADR 0042/0010). Requires object/write on
   * the target plus the current version token (optimistic concurrency). The
   * token is read fresh here; the caller may pass a versionToken to surface a
   * CommandConflictError on a stale write.
   *
   * Returns {objectId, versionToken} (the new object-scoped token).
   */
  async function mutateObject({imageId, objectId, value, authority, blockId, versionToken = null}) {
    // Control-plane/schema read (trusted host), not a user-facing object read:
    // the optimistic-concurrency version-token fetch for the mutation lane.
    const token = versionToken ?? objectVersionToken(imageId, objectId, (await images.getObject(imageId, objectId))?._version);
    const normalized = normalizeTypeDeclarations(PROBE_MUTATION_TYPE_DECLARATIONS);
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [
      textValue(objectId),
      textValue(token),
      packCompositeValue(value, PROBE_MUTATION_TYPE_NAME, normalized),
    ]);
    const result = await executor.execute(activation, {authority});
    return Object.freeze({objectId, versionToken: result?.value});
  }

  /**
   * The authorized whole-record object read (image-object-read-binding/v1,
   * substrate ADR 0068): the environment's SINGLE user-facing "read an object"
   * seam. Invokes the read block and executes it under the caller's authority;
   * the substrate enforces require({operation: 'object/read', resource}) BEFORE
   * any existence check, so a denied read surfaces AuthorityError whether or not
   * the object exists (no existence oracle). An authorized read of a nonexistent
   * object surfaces a distinct not-found TypeError; backend failure propagates.
   *
   * Returns ONLY what the lane discloses across the ref-free codec —
   * {slots: {slotId: Value}, indexed: [Value], versionToken} — NOT the
   * substrate's stored record: there is no kind/shape/behavior here (ADR 0068
   * carries slots + indexed only). Each slot-entry/slot-value string is
   * JSON.parsed back into the canonical ADR 0008 Value (leaf OR ref/pinned-ref
   * identity, never followed). Downstream consumers that need references must
   * walk slots + indexed only (see ObjectNavigator's referencesOfLaneRecord);
   * shape/behavior are unavailable from this seam by design.
   *
   * AuthorityError and the not-found TypeError are deliberately NOT caught or
   * collapsed here: the distinction is the point of the lane, and collapsing it
   * would discard substrate PR #127's benefit.
   */
  async function authorizedReadObject({imageId, objectId, authority, blockId}) {
    const types = normalizeTypeDeclarations(OBJECT_READ_TYPE_DECLARATIONS);
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [textValue(objectId)]);
    const packed = await executor.execute(activation, {authority});
    const result = unpackCompositeValue(packed, 'object-read-result', types);
    const slots = Object.fromEntries(
      (result.value.slots ?? []).map(({name, value}) => [name, JSON.parse(value.value)]),
    );
    const indexed = (result.value.indexed ?? []).map((entry) => JSON.parse(entry.value));
    return Object.freeze({slots, indexed, versionToken: result['version-token']});
  }

  /**
   * readObject is the environment's single runtime read abstraction: it routes
   * through the authorized whole-record read lane (never the privileged
   * images.getObject) so every user-facing object read crosses the object/read
   * authority boundary. ObjectNavigator and loadPerspective both consume it.
   */
  async function readObject({imageId, objectId, authority, blockId}) {
    return await authorizedReadObject({imageId, objectId, authority, blockId});
  }

  // --- Perspective save/load (ADR 0012 indexed form) --------------------------

  // Run a creation-lane block: invoke the binding block with the class id and
  // the packed value record, execute under `authority`, and return the minted
  // object id (recovered from the object-scoped version token).
  async function runCreate({imageId, blockId, typeName, types, classId, value, authority}) {
    const normalized = normalizeTypeDeclarations(types);
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [
      textValue(classId),
      packCompositeValue(value, typeName, normalized),
    ]);
    const result = await executor.execute(activation, {authority});
    return objectIdFromVersionToken(result?.value, imageId);
  }

  /**
   * Provision the Perspective + presentation schema, idempotently. The kernel
   * is a precondition. The Perspective class is given an indexed instance
   * Shape; the presentation class a plain one.
   */
  async function ensurePerspectiveSchema(imageId, ids = {}) {
    const {
      perspectiveShapeId, perspectiveClassName, presentationShapeId, presentationClassName,
      perspectiveInterfaceId, perspectiveBindingId, perspectiveBlockId,
      presentationInterfaceId, presentationBindingId, presentationBlockId,
    } = ids;
    for (const [key, value] of Object.entries(ids)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`ensurePerspectiveSchema requires a non-empty ids.${key}`);
      }
    }
    const kernel = await findSmalltalkKernel({images, imageId});
    if (!kernel) {
      throw new TypeError(`image ${imageId} has no Smalltalk kernel; provision one before installing the environment schema`);
    }

    // The Perspective class: an INDEXED instance Shape (the ordered
    // presentation-ref part). putShape accepts indexed:'values' (substrate ADR
    // 0047/0064); the class builder requires the inherited indexed kind match.
    let perspectiveShape = await images.getShape(imageId, perspectiveShapeId);
    if (!perspectiveShape) {
      perspectiveShape = await images.putShape(imageId, {
        id: perspectiveShapeId, slots: PERSPECTIVE_SHAPE_SLOTS, indexed: 'values',
      });
    }
    // Control-plane/schema read (trusted host), not a user-facing object read.
    let perspectiveClass = await images.getObject(imageId, classIdFor(perspectiveClassName));
    if (!perspectiveClass) {
      await defineClass({images, imageId, name: perspectiveClassName, instanceShapeRef: objectRef(imageId, perspectiveShapeId)});
      // Control-plane/schema read (trusted host), not a user-facing object read.
      perspectiveClass = await images.getObject(imageId, classIdFor(perspectiveClassName));
    }

    let presentationShape = await images.getShape(imageId, presentationShapeId);
    if (!presentationShape) {
      presentationShape = await images.putShape(imageId, {id: presentationShapeId, slots: PRESENTATION_SHAPE_SLOTS});
    }
    // Control-plane/schema read (trusted host), not a user-facing object read.
    let presentationClass = await images.getObject(imageId, classIdFor(presentationClassName));
    if (!presentationClass) {
      await defineClass({images, imageId, name: presentationClassName, instanceShapeRef: objectRef(imageId, presentationShapeId)});
      // Control-plane/schema read (trusted host), not a user-facing object read.
      presentationClass = await images.getObject(imageId, classIdFor(presentationClassName));
    }

    if (!(await images.getCodeArtifact(imageId, perspectiveInterfaceId))) {
      await installCallableInterfaceV2({
        images, imageId, functionName: 'create', parameters: ['string', PERSPECTIVE_TYPE_NAME],
        result: 'string', types: PERSPECTIVE_TYPE_DECLARATIONS, interfaceId: perspectiveInterfaceId,
      });
    }
    if (!(await images.getBlock(imageId, perspectiveBlockId))) {
      await installImageCreationBinding({
        images, callableInterface: objectRef(imageId, perspectiveInterfaceId), imageId,
        fields: PERSPECTIVE_FIELDS, bindingId: perspectiveBindingId, blockId: perspectiveBlockId,
      });
    }

    if (!(await images.getCodeArtifact(imageId, presentationInterfaceId))) {
      await installCallableInterfaceV2({
        images, imageId, functionName: 'create', parameters: ['string', PRESENTATION_TYPE_NAME],
        result: 'string', types: PRESENTATION_TYPE_DECLARATIONS, interfaceId: presentationInterfaceId,
      });
    }
    if (!(await images.getBlock(imageId, presentationBlockId))) {
      await installImageCreationBinding({
        images, callableInterface: objectRef(imageId, presentationInterfaceId), imageId,
        fields: PRESENTATION_FIELDS, bindingId: presentationBindingId, blockId: presentationBlockId,
      });
    }

    return Object.freeze({
      perspectiveClassId: classIdFor(perspectiveClassName),
      presentationClassId: classIdFor(presentationClassName),
      perspectiveBlockRef: objectRef(imageId, perspectiveBlockId),
      presentationBlockRef: objectRef(imageId, presentationBlockId),
    });
  }

  /**
   * Persist a Perspective as ordinary image data (ADR 0012 indexed form) via a
   * STAGED AUTHORIZED WORKFLOW. The creation lane mints child ids server-side
   * and authority matches resources exactly (no wildcards), so no single
   * up-front context can authorize both the children's subject edges and the
   * Perspective's indexed edges to those not-yet-existing children.
   *
   * `authorityProvider` is a connection/control-plane seam: an async function
   * the adapter calls to obtain a FRESH, OPAQUE authority context for each
   * image invocation, after that invocation's exact resources are known. It is
   * called with a request describing the invocation:
   *   authorityProvider({kind: 'create-presentation', imageId, classId, subjectRef})
   *   authorityProvider({kind: 'create-perspective', imageId, classId, subjectRef, childRefs})
   * and must return an authority context authorizing exactly that invocation.
   * The adapter neither issues nor inspects the returned contexts — it passes
   * them through opaquely (ADR 0010).
   *
   * Commit semantics: the indexed Perspective is the commit point; a failure
   * before its create may leave orphan presentation children (unreachable,
   * observable on the change feed) until multi-record transactions exist.
   *
   * Returns {perspectiveId, presentationIds} (in presentation order).
   */
  async function savePerspective({imageId, perspective, authorityProvider, schema}) {
    if (typeof authorityProvider !== 'function') {
      throw new TypeError('savePerspective requires an authorityProvider function');
    }
    const presentationRecords = encodePresentations(perspective);

    // Stage 1: create each child (complete and durable on commit), each with a
    // fresh context authorizing that child's subject edge. Child ids are now
    // server-minted and known.
    const presentationIds = [];
    const childRefs = [];
    for (const record of presentationRecords) {
      const s = record.slots;
      const authority = await authorityProvider({
        kind: 'create-presentation', imageId,
        classId: schema.presentationClassId, subjectRef: s.subject,
      });
      const objectId = await runCreate({
        imageId, blockId: schema.presentationBlockRef.objectId,
        typeName: PRESENTATION_TYPE_NAME, types: PRESENTATION_TYPE_DECLARATIONS,
        classId: schema.presentationClassId,
        value: {
          subject: refToEdgeString(s.subject, imageId),
          id: s.id.value, kind: s.kind.value, context: s.context.value, state: s.state.value,
        },
        authority,
      });
      presentationIds.push(objectId);
      childRefs.push(objectRef(imageId, objectId));
    }

    // Stage 2: a fresh context authorizing the Perspective subject edge plus an
    // object/edge-write per now-known child id, then create the Perspective
    // (the commit point) with its ordered indexed ref-list.
    const record = encodePerspectiveRecord(perspective, childRefs);
    const perspectiveAuthority = await authorityProvider({
      kind: 'create-perspective', imageId,
      classId: schema.perspectiveClassId, subjectRef: record.slots.subject, childRefs,
    });
    const perspectiveId = await runCreate({
      imageId, blockId: schema.perspectiveBlockRef.objectId,
      typeName: PERSPECTIVE_TYPE_NAME, types: PERSPECTIVE_TYPE_DECLARATIONS,
      classId: schema.perspectiveClassId,
      value: {
        subject: refToEdgeString(record.slots.subject, imageId),
        title: record.slots.title.value,
        layout: record.slots.layout.value,
        // format-version travels as a string but is stored as an integer Value
        // (see the note in loadPerspective): send the decimal-string payload.
        'format-version': record.slots.formatVersion.value,
        presentations: childRefs.map((ref) => refToEdgeString(ref, imageId)),
      },
      authority: perspectiveAuthority,
    });

    return Object.freeze({perspectiveId, presentationIds: Object.freeze(presentationIds)});
  }

  /**
   * Load a durable Perspective. Reads the Perspective record (object/read-level
   * getObject — the unguarded host path per substrate ADR 0064 §4) and
   * enumerates its children from the indexed part, in order.
   *
   * The substrate keys stored slots by slot ID (persp-subject, ...), while the
   * projection contract reads them by name (subject, ...), so the adapter
   * translates. A non-indexed slot the binding did not map is nil-filled by the
   * creation lane (a ref to smalltalk/nil); for the optional text slots
   * title/layout that nil reads as "absent", mapped to an empty text slot. The
   * format-version binding field is a string, so the lane stores it as a text
   * Value; the projection's version contract is integer-shaped, so it is
   * re-wrapped here.
   */
  function perspectiveSlotsForProjection(slots) {
    const text = (value) => (value && value.kind === 'text' ? value : {kind: 'text', value: ''});
    return {
      subject: slots['persp-subject'],
      title: text(slots['persp-title']),
      layout: text(slots['persp-layout']),
      formatVersion: {kind: 'integer', value: slots['persp-format']?.value ?? ''},
    };
  }

  function presentationSlotsForProjection(slots) {
    const text = (value) => (value && value.kind === 'text' ? value : {kind: 'text', value: ''});
    return {
      subject: slots['pres-subject'],
      id: text(slots['pres-id']),
      kind: text(slots['pres-kind']),
      context: text(slots['pres-context']),
      state: text(slots['pres-state']),
    };
  }

  /**
   * Load a durable Perspective through the authorized whole-record read lane.
   * Every read — the Perspective record and each presentation child — is a
   * SEPARATE authorized read (image-object-read-binding/v1), never the
   * privileged host getObject.
   *
   * ref != authority: reading Perspective P authorizes P only; each child read
   * is authorized independently. `authorityProvider` is the connection/control-
   * plane seam (mirroring savePerspective): an async function the adapter calls
   * with a request describing the read —
   *   authorityProvider({kind: 'read-perspective', imageId, perspectiveId})
   *   authorityProvider({kind: 'read-presentation', imageId, perspectiveId, objectId})
   * and which must return an opaque authority context authorizing exactly that
   * read. The adapter neither issues nor inspects the returned contexts; it
   * passes them through (ADR 0010). "Can read P" is NOT treated as "can read
   * P's children": a child the provider does not authorize surfaces AuthorityError.
   *
   * A denied read (AuthorityError) and a missing object (not-found TypeError)
   * propagate distinctly, never collapsed.
   */
  async function loadPerspective({imageId, perspectiveId, authorityProvider, readBlockId}) {
    if (typeof authorityProvider !== 'function') {
      throw new TypeError('loadPerspective requires an authorityProvider function');
    }
    const perspectiveAuthority = await authorityProvider({kind: 'read-perspective', imageId, perspectiveId});
    const record = await readObject({
      imageId, objectId: perspectiveId, authority: perspectiveAuthority, blockId: readBlockId,
    });
    return decodePerspective({
      id: perspectiveId,
      perspectiveRecord: {slots: perspectiveSlotsForProjection(record.slots), indexed: record.indexed ?? []},
      resolveChild: async (childRef) => {
        const childAuthority = await authorityProvider({
          kind: 'read-presentation', imageId, perspectiveId, objectId: childRef.objectId,
        });
        const child = await readObject({
          imageId, objectId: childRef.objectId, authority: childAuthority, blockId: readBlockId,
        });
        return {slots: presentationSlotsForProjection(child.slots)};
      },
    });
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
    mutateObject,
    ensurePerspectiveSchema,
    savePerspective,
    loadPerspective,
    readObject,
    authorizedReadObject,
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
