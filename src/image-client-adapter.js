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
 *   - image-observation.js       (ADR 0009 as superseded by substrate ADR 0070) -> observe()
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
  {id: 'probe-count', name: 'count'},
  {id: 'probe-flag', name: 'flag'},
]);

// The callable-interface/v2 record type for the probe: title is a leaf string,
// subject is an edge target id travelling as a string (the lane canonicalizes
// it to a ref host-side), count/flag are the canonical scalar Values (integer
// s32, boolean bool) that prove browsing already handles heterogeneous scalars.
// Declared once so the interface and the call agree.
const PROBE_TYPE_NAME = 'probe';
const PROBE_TYPE_DECLARATIONS = Object.freeze({
  [PROBE_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'title', type: 'string'}),
      Object.freeze({name: 'subject', type: 'string'}),
      Object.freeze({name: 'count', type: 's32'}),
      Object.freeze({name: 'flag', type: 'bool'}),
    ]),
  }),
});

// The probe mutation lane (image-mutation-binding/v1, ADR 0042/0010): writes a
// leaf slot on an EXISTING object under object/write + an optimistic-concurrency
// version token. Only the leaf title is mutable here (v1 slot writes are
// leaf-only). The substrate requires every mutation record field be MAPPED to a
// slot (image-mutation-binding.js assertFieldMappingCovers), so the record
// carries ONLY the writable title — count/flag are NOT in the mutation type at
// all. They are real browseable scalars on the object (created via the creation
// lane) but deliberately read-only: there is no writable path to them in this
// slice. This is the minimal honest S1 — no clobber risk, no read-modify-write.
const PROBE_MUTATION_TYPE_NAME = 'probe-mutation';
const PROBE_MUTATION_TYPE_DECLARATIONS = Object.freeze({
  [PROBE_MUTATION_TYPE_NAME]: Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'title', type: 'string'}),
    ]),
  }),
});
// Only probe-title is writable: the mutation binding maps the title field alone.
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

// --- The authorized observation lane (image-observation-binding/v1, substrate
// ADR 0070) -------------------------------------------------------------------
//
// The environment's SINGLE user-facing live-observation seam. The lane scans
// the image's PRIVATE history internally and emits, for each `object.put` the
// caller may `object/read`, ONLY identity + kind + an opaque per-event cursor —
// never the record payload, never the raw global revision. The result cursor
// is an opaque, integrity-protected STRING high-water token (encrypted
// lane-side; the consumer cannot parse, compare or forge it), closing the
// global-revision gap-analysis channel. State disclosure stays in ONE place:
// the consumer re-reads through authorizedReadObject (ADR 0068).
//
// `obs-event` is the declared record {object-id, kind, cursor} (kebab-case
// field names per the composite codec); `obs-result` couples the event list
// to the scan's opaque high-water cursor.
const OBSERVATION_TYPE_DECLARATIONS = Object.freeze({
  'obs-event': Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'object-id', type: 'string'}),
      Object.freeze({name: 'kind', type: 'string'}),
      Object.freeze({name: 'cursor', type: 'string'}),
    ]),
  }),
  'obs-result': Object.freeze({
    kind: 'record',
    fields: Object.freeze([
      Object.freeze({name: 'events', type: Object.freeze({kind: 'list', element: 'obs-event'})}),
      Object.freeze({name: 'cursor', type: 'string'}),
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
  for (const service of ['images', 'invocations', 'executor', 'authority']) {
    if (!client[service] || typeof client[service] !== 'object') {
      throw new TypeError(`lagrange-images client is missing required service: ${service}`);
    }
  }
  const {
    images,
    invocations,
    executor,
    authority: authorityService,
    // Helpers consumed from the public exports (createRuntime's module barrels).
    defineClass,
    installCallableInterfaceV2,
    installImageCreationBinding,
    installImageMutationBinding,
    installImageObjectReadBinding,
    installImageObservationBinding,
    findSmalltalkKernel,
    objectRef,
    objectResource,
    parseObjectResource,
    objectVersionToken,
    textValue,
    packCompositeValue,
    unpackCompositeValue,
    normalizeTypeDeclarations,
    authorizedReadProject,
    authorizedRenameProject,
    authorizedDescribeSmalltalkClass,
  } = client;

  if (typeof authorityService.require !== 'function') {
    throw new TypeError('lagrange-images client authority service is missing required operation: require');
  }

  for (const [name, fn] of Object.entries({defineClass, installCallableInterfaceV2, installImageCreationBinding, installImageMutationBinding, installImageObjectReadBinding, installImageObservationBinding, findSmalltalkKernel, objectRef, objectResource, parseObjectResource, objectVersionToken, textValue, packCompositeValue, unpackCompositeValue, normalizeTypeDeclarations, authorizedReadProject, authorizedRenameProject, authorizedDescribeSmalltalkClass})) {
    if (typeof fn !== 'function') {
      throw new TypeError(`lagrange-images client is missing required helper: ${name}`);
    }
  }

  const objectIdFromVersionToken = makeObjectIdDecoder(objectResource, parseObjectResource);

  /**
   * Read one durable Project through Images' authorized VERSION-AWARE semantic
   * seam (Images ADR 0080 `authorizedReadProject`).
   *
   * Returns Images' result UNCHANGED: `{descriptor, versionToken}` — the
   * canonical ProjectDescriptor plus an OPAQUE version token that describes the
   * Project object the descriptor was read from (one read; Images owns the
   * coupling and the token's scope). Images owns the demand,
   * authorization-before-existence ordering, backing member storage unit and
   * canonicalization. The adapter owns only bridging the caller's opaque
   * authority context to the injected runtime's check-only
   * `require(context, demand)`. It never constructs, inspects, caches or
   * broadens a demand/context; it never names the Project's backing object id
   * or a slot; it never inspects, decodes, defaults or mints the token.
   */
  async function readProject({imageId, projectId, authority = null} = {}) {
    return authorizedReadProject({
      images,
      imageId,
      projectId,
      require: (demand) => authorityService.require(authority, demand),
    });
  }

  /**
   * Rename one durable Project through Images' authorized rename seam (Images
   * ADR 0080 `authorizedRenameProject`). The ONLY translation here is the
   * argument name: the Environment's `versionToken` (the token paired with the
   * Project read the caller holds) becomes Images' `expectedVersionToken`, a
   * storage CAS precondition Images enforces. Returns Images' result unchanged
   * (`{versionToken}`, the new opaque token). The adapter forwards the token
   * VERBATIM — no default, no validation, no fetch — and performs no conflict
   * translation: a stale token surfaces as Images' own
   * ObjectMutationConflictError, which CommandDispatcher (the Environment's
   * Command error owner) maps to CommandConflictError. Not routed through the
   * generic object/slot mutation lane: Images owns the Project's field -> slot
   * translation.
   */
  // The Project fields this adapter can write through an Images-owned seam —
  // an Images-contract FACT surfaced by the interaction owner (the same way
  // writableSlots surfaces the mutation lane's map), never a slot id. Exactly
  // the fields with a seam below: `name` <-> renameProject. Adding a field here
  // without adding its seam (or vice versa) is a contract error.
  const PROJECT_WRITABLE_FIELDS = Object.freeze(['name']);

  async function renameProject({imageId, projectId, name, versionToken, authority = null} = {}) {
    return authorizedRenameProject({
      images,
      imageId,
      projectId,
      name,
      expectedVersionToken: versionToken,
      require: (demand) => authorityService.require(authority, demand),
    });
  }

  /**
   * Describe ONE native Symmetric Smalltalk class through Images' authorized
   * browsing seam (Images ADR 0087 `authorizedDescribeSmalltalkClass`).
   *
   * Returns Images' `smalltalk-class-description/v1` record UNCHANGED and
   * uninterpreted: identity/name, instance-vs-class side, superclass and
   * class-side LOCATORS, the declared native layout (ordered NAMES + whether
   * instances are indexable) and the class's OWN canonical selector names.
   * Images decides every one of those facts; this adapter bridges only the
   * caller's opaque authority context to the injected runtime's check-only
   * `require(context, demand)`, exactly as `readProject` does.
   *
   * What this seam deliberately does NOT do: decode a Behavior slot, a
   * MethodDictionary, a Shape or an object id; walk a superclass chain;
   * recognize a Cuis-imported class as anything other than a native class; or
   * reach the METHOD seam. A Cuis-origin class and a hand-declared one take
   * this one route, because origin is not identity.
   *
   * AUTHORITY. Images requires `object/read` on the Class (or Metaclass) OBJECT
   * before it discloses existence, so a denied caller cannot tell an existing
   * class from a missing one. The `superclass` and `classSide` refs in the
   * result are LOCATORS, never inherited grants: browsing what they name is a
   * fresh call with that object's own authority (ADR 0005, as amended).
   */
  async function describeSmalltalkClass({imageId, classRef, authority = null} = {}) {
    return authorizedDescribeSmalltalkClass({
      images,
      imageId,
      classRef,
      require: (demand) => authorityService.require(authority, demand),
    });
  }

  /**
   * The Environment<->Images ERROR MAPPING for the browse seam above. This
   * interaction owner owns it (ownership row 49): a consumer classifies
   * nothing, and no Images message text is ever propagated.
   *
   * Two outcomes, matching the generic object lane's vocabulary so a denied
   * class browse presents through the SAME unauthorized/unavailable route as
   * any other denied read — there is no native-specific failure presentation:
   *   'unauthorized'  the authority check refused (AuthorityError). Because
   *                   Images authorizes BEFORE any existence check, this is the
   *                   answer for an existing AND a missing class alike.
   *   'unavailable'   anything else — the class is missing, its instance-shape
   *                   edge dangles, the image carries no Smalltalk kernel, or
   *                   the caller supplied a malformed ref.
   *
   * The MESSAGE is dropped on purpose. Images' browse errors legitimately name
   * storage (`not a smalltalk/behavior-shape/v1 behavior: <id>`), and copying
   * one into a presented reason would put an Images storage shape id in the
   * Environment UI — the exact decoding this whole lane exists to avoid. The
   * cost is that four different causes collapse into one reason; that trade is
   * recorded on Bead lagrange-object-environment-azj rather than hidden here.
   */
  function classifySmalltalkClassReadError(error) {
    return error?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable';
  }

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
  async function ensureSchema(imageId, {shapeId, className, interfaceId, bindingId, blockId, mutationInterfaceId, mutationBindingId, mutationBlockId, readInterfaceId, readBindingId, readBlockId, observationInterfaceId, observationBindingId, observationBlockId} = {}) {
    // Validate ids eagerly: a missing id would otherwise flow into the
    // substrate as undefined (or, for putShape, mint a random id and silently
    // break idempotence), surfacing a confusing error far from the cause.
    for (const [key, value] of Object.entries({shapeId, className, interfaceId, bindingId, blockId, mutationInterfaceId, mutationBindingId, mutationBlockId, readInterfaceId, readBindingId, readBlockId, observationInterfaceId, observationBindingId, observationBlockId})) {
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
          {name: 'count', slot: 'probe-count', edge: false},
          {name: 'flag', slot: 'probe-flag', edge: false},
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

    // The authorized observation lane (image-observation-binding/v1, substrate
    // ADR 0070): the environment's single user-facing live-observation seam.
    const observationInterfaceRef = objectRef(imageId, observationInterfaceId);
    if (!(await images.getCodeArtifact(imageId, observationInterfaceId))) {
      await installCallableInterfaceV2({
        images,
        imageId,
        functionName: 'observe',
        parameters: ['string'],
        result: 'obs-result',
        types: OBSERVATION_TYPE_DECLARATIONS,
        interfaceId: observationInterfaceId,
      });
    }
    if (!(await images.getBlock(imageId, observationBlockId))) {
      await installImageObservationBinding({
        images,
        callableInterface: observationInterfaceRef,
        imageId,
        bindingId: observationBindingId,
        blockId: observationBlockId,
      });
    }

    return Object.freeze({
      shape, classRecord, interfaceRef, blockRef: objectRef(imageId, blockId),
      mutationBlockRef: objectRef(imageId, mutationBlockId),
      readBlockRef: objectRef(imageId, readBlockId),
      observationBlockRef: objectRef(imageId, observationBlockId),
    });
  }

  /**
   * Create a probe object through the authorized creation lane. Returns
   * {objectId, versionToken}. Authority (object/create on the class, plus
   * object/edge-write on the subject target) is passed through per call.
   */
  async function createObject({imageId, classId, title, subject, count = 0, flag = false, authority, blockId}) {
    const subjectString = refToEdgeString(subject, imageId);
    const types = normalizeTypeDeclarations(PROBE_TYPE_DECLARATIONS);
    // The creation record is OOM-complete (every declared field present), so the
    // adapter owns the canonical scalar defaults for count/flag when omitted.
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [
      textValue(classId),
      packCompositeValue({title, subject: subjectString, count, flag}, PROBE_TYPE_NAME, types),
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

  // --- Presentation asset refs -> authorized bytes (Bead 0dm) -----------------

  // Decode a durable byte array from an authorized object-read result. The
  // substrate stores bytes as a base64 string (or an array of byte ints) in a
  // named slot. Returns a Uint8Array, or null when the object carries no bytes.
  function decodeBytesField(record, slotName) {
    let v = record?.slots?.[slotName];
    // The authorized read returns slots as Value objects: text ({value}) or the
    // substrate's first-class bytes kind ({kind:'bytes', base64}). Unwrap both.
    if (v && typeof v === 'object' && typeof v.base64 === 'string') v = v.base64;
    else if (v && typeof v === 'object' && typeof v.value === 'string') v = v.value;
    if (typeof v === 'string') {
      // base64
      if (typeof atob === 'function') {
        const bin = atob(v);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new Uint8Array(Buffer.from(v, 'base64'));
    }
    if (Array.isArray(v)) return new Uint8Array(v);
    return null;
  }

  /**
   * Resolve a set of PRESENTATION-LOCAL asset names (each mapped to a durable
   * ref by the Presentation) to opaque bytes under explicit per-call object/read
   * authority. This is the environment-side owner of the "Presentation asset
   * refs -> authorized bytes" interaction (docs/ownership.md): it routes through
   * the SAME authorized whole-record read lane as readObject (no separate grant
   * type, no broad asset grant), so each asset ref needs its OWN authorized
   * resolution — reading a Presentation never transitively authorizes its assets.
   *
   * The BrowserRendererAdapter consumes only the returned Map<presentationLocalName,
   * Uint8Array> (never refs/ids/authority); it stays a byte conduit.
   *
   * @param {object} spec
   * @param {Array<{name: string, ref: {imageId: string, objectId: string, blockId: string, slot?: string}}>} spec.assets
   *        presentation-local name -> durable ref (+ read blockId, + optional byte slot, default 'bytes')
   * @param {object} spec.authority per-call authority (threaded, never stored)
   * @returns {Promise<Map<string, Uint8Array>>} name -> opaque bytes
   */
  async function resolveAssetBytes({assets, authority}) {
    if (!Array.isArray(assets)) throw new TypeError('resolveAssetBytes requires an assets array');
    const out = new Map();
    for (const {name, ref} of assets) {
      if (typeof name !== 'string' || !ref || typeof ref.imageId !== 'string' || typeof ref.objectId !== 'string' || typeof ref.blockId !== 'string') {
        throw new TypeError('each asset needs a presentation-local name and a durable ref {imageId, objectId, blockId, ...}');
      }
      // Authorized per-ref read (object/read). No ref is authority.
      const record = await readObject({imageId: ref.imageId, objectId: ref.objectId, authority, blockId: ref.blockId});
      const bytes = decodeBytesField(record, ref.slot ?? 'bytes');
      if (!bytes) throw new Error(`asset "${name}" (object ${ref.objectId}) carries no byte payload`);
      out.set(name, bytes);
    }
    return out;
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

  /**
   * One authorized pull on the observation lane (image-observation-binding/v1,
   * substrate ADR 0070). Invokes the observation block with the caller's
   * after-cursor and executes under the caller's authority; the lane checks
   * `object/read` per scanned event and emits only visible object.put
   * invalidations. The authority context is threaded through this call only —
   * it is never stored or captured by the adapter.
   *
   * `afterCursor` is the lane's opaque token: '' = live-follow from the
   * current end; any earlier token resumes after its position. Returns
   * {events: [{objectId, kind, cursor}], cursor} — the composite codec's
   * kebab-case `object-id` is renamed to `objectId` here; nothing else is
   * added or interpreted (the cursor is never parsed, only passed back).
   */
  async function observePull({imageId, afterCursor, authority, blockId}) {
    if (typeof afterCursor !== 'string') {
      throw new TypeError('observePull requires an opaque afterCursor string');
    }
    const types = normalizeTypeDeclarations(OBSERVATION_TYPE_DECLARATIONS);
    const activation = await invocations.invokeBlock(objectRef(imageId, blockId), [textValue(afterCursor)]);
    const packed = await executor.execute(activation, {authority});
    const result = unpackCompositeValue(packed, 'obs-result', types);
    return Object.freeze({
      events: Object.freeze((result.events ?? []).map((event) => Object.freeze({
        objectId: event['object-id'],
        kind: event.kind,
        cursor: event.cursor,
      }))),
      cursor: result.cursor,
    });
  }

  /**
   * The environment's single user-facing live-observation seam (substrate ADR
   * 0070; supersedes env ADR 0009's raw-history feed for restricted
   * principals). Returns an async iterable of METADATA-ONLY invalidations
   * {type, kind, objectId, cursor}: an event means "an object you may
   * object/read changed" — identity only, never the record payload, never a
   * global revision. Consumers that need the new state re-read the object
   * through `readObject` under their own per-call authority.
   *
   * Authority is threaded per call (each underlying poll re-executes under
   * the caller-supplied context); it is never stored by the adapter. Options:
   *   authority   the caller's authority context (required in practice: the
   *               lane's per-event check-only require throws without one).
   *   blockId     the observation lane's block (from ensureSchema).
   *   afterCursor resume token; omitted = live-follow from the current end.
   *   signal      AbortSignal; aborting ends iteration.
   *   intervalMs  delay between polls when no new events arrive.
   */
  function observe(imageId, {authority = null, blockId, afterCursor, signal, intervalMs} = {}) {
    if (typeof blockId !== 'string' || blockId.length === 0) {
      throw new TypeError('observe requires the observation lane blockId');
    }
    return observeChanges({
      poll: (cursor) => observePull({imageId, afterCursor: cursor, authority, blockId}),
      afterCursor,
      signal,
      intervalMs,
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
    readProject,
    renameProject,
    projectWritableFields: PROJECT_WRITABLE_FIELDS,
    // The authorized native class browsing seam and its error mapping. There is
    // deliberately NO describeSmalltalkMethod here: E1 presents selector NAMES,
    // and class-read authority must never yield the Block behind a selector.
    // Uncallable beats un-called — E2 adds the method seam with its own
    // independent Block authorization (Bead lagrange-object-environment-eij.2).
    describeSmalltalkClass,
    classifySmalltalkClassReadError,
    readObject,
    authorizedReadObject,
    resolveAssetBytes,
    observe,
    observePull,
    dispatch,
    // The SINGLE owner of the probe's writable-slot set (the slots the mutation
    // lane maps). count/flag are deliberately absent — read-only. The SemanticUi
    // projector derives a field's editability from THIS list (S3), never from a
    // duplicate of the mutation field map.
    writableSlots: Object.freeze(PROBE_MUTATION_FIELDS.map((f) => f.slot)),
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
