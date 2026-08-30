import {Presentation} from './model.js';

/**
 * ObjectNavigator: the single owner of the generic-object experience
 * (docs/ownership.md). It composes the discovery registries and the image
 * adapter to realize one loop, without hard-coded if-then wiring:
 *
 *   object -> inspector -> discover refs -> follow ref -> presentation
 *   failure branch: follow ref -> unavailable -> explicit presentation
 *
 * The navigator NEVER renders. It produces semantic Presentations and
 * discovered Commands; a renderer/Compositor turns those into views.
 *
 * Async read vs sync discovery (the registry's contract): `present` is
 * synchronous, so the image read happens in `navigate` (async) BEFORE
 * discovery, and the outcome is materialized into the subject. `inspect`
 * (sync) is the escape hatch for an already-materialized subject.
 *
 * Invariants preserved:
 *  - A ref is never authority. `navigate` treats the ref as a mere locator and
 *    re-reads the object fresh under EXPLICIT authority (the authorized
 *    whole-record object/read lane, substrate ADR 0068) threaded per call; it
 *    never trusts the ref's existence and never stores authority. The read is
 *    authorized BEFORE any existence check, so a denied read is an
 *    `unauthorized-ref` whether or not the object exists (no existence
 *    oracle); an authorized read of a missing object is an `unavailable-ref`.
 *    A pinned-ref's revision is currently ignored on read: the read seam reads
 *    current state and has no revision parameter (substrate follow-up Bead), so
 *    navigation always shows current state, not the pinned revision.
 *  - discoverable/applicable != authorized (ADR 0004). Commands are
 *    discovered by applicability only; authorization happens at dispatch,
 *    not here.
 */

// The subject kinds the navigator materializes. A normal object subject is a
// ref Value; an unavailable or unauthorized subject is a distinct kind so the
// fallback providers never race the inspector (they are disjoint by subject
// kind). `unauthorized-ref` (denied read) and `unavailable-ref` (missing or
// backend failure) are kept distinct so a renderer can present "you may not
// read this" separately from "this is not there / the read failed".
const UNAVAILABLE_REF_KIND = 'unavailable-ref';
const UNAUTHORIZED_REF_KIND = 'unauthorized-ref';

function isRef(value) {
  return Boolean(
    value && typeof value === 'object' &&
    (value.kind === 'ref' || value.kind === 'pinned-ref') &&
    typeof value.objectId === 'string' && value.objectId.length > 0,
  );
}

function createObjectNavigator({adapter, presentationRegistry, commandRegistry, referencesOfValue}) {
  if (!adapter || typeof adapter.readObject !== 'function') {
    throw new TypeError('createObjectNavigator requires an adapter with readObject');
  }
  if (!presentationRegistry || typeof presentationRegistry.discover !== 'function') {
    throw new TypeError('createObjectNavigator requires a presentationRegistry');
  }
  if (!commandRegistry || typeof commandRegistry.discover !== 'function') {
    throw new TypeError('createObjectNavigator requires a commandRegistry');
  }
  // The Value walker is INJECTED (not imported from the substrate) to preserve
  // renderer/environment independence (ADR 0002) — the same rule the adapter
  // follows. In production it is lagrange-images' referencesOfValue (a single
  // canonical Value -> its followable ref/pinned-ref, or none).
  if (typeof referencesOfValue !== 'function') {
    throw new TypeError('createObjectNavigator requires an injected referencesOfValue function');
  }

  // Reference discovery over the authorized read lane's result. The lane
  // (image-object-read-binding/v1, substrate ADR 0068) deliberately carries
  // ONLY slots + indexed across the ref-free codec — it returns no
  // kind/shape/behavior — so a record walker (referencesOfRecord) cannot run
  // on it. The navigator walks references ONLY from what the lane actually
  // discloses: the slot Values and the indexed Values (each a canonical ADR
  // 0008 Value; a ref/pinned-ref is followable identity, anything else is
  // not). shape/behavior are NOT followed here because the lane does not
  // return them.
  function referencesOfLaneRecord(record) {
    const refs = [];
    for (const value of Object.values(record?.slots ?? {})) refs.push(...referencesOfValue(value));
    for (const value of record?.indexed ?? []) refs.push(...referencesOfValue(value));
    return refs;
  }

  /**
   * inspect(subject, context, extras) -> {presentations, commands, failures, ...extras}
   *
   * Synchronous discovery over an ALREADY-MATERIALIZED subject (a ref whose
   * record is in hand, or an unavailable-ref). Providers plug in through the
   * presentationRegistry; applicable Commands come from the commandRegistry
   * (applicability only, never authority). `extras` carries OPTIONAL sibling
   * metadata that is deliberately NOT Presentation context (e.g. the transient
   * versionToken) — see navigate.
   */
  function inspect(subject, context = {}, extras = {}) {
    const {presentations, failures} = presentationRegistry.discover(subject, context);
    const {commands, failures: commandFailures} = commandRegistry.discover(subject, context);
    return Object.freeze({
      presentations,
      commands,
      failures: Object.freeze([...failures, ...commandFailures]),
      ...extras,
    });
  }

  // Classify a read failure into a materialized subject kind. The substrate
  // read lane enforces object/read BEFORE any existence check, so a denied
  // read is AuthorityError whether or not the object exists; an authorized
  // read of a missing object is a distinct not-found TypeError; any other
  // error is a backend/operational failure. The navigator does NOT catch-all
  // into "unavailable": that would collapse PR #127's unauthorized-vs-missing
  // distinction back into one bucket.
  function readFailureSubject(subject, error) {
    if (error?.name === 'AuthorityError') {
      // Denied: unauthorized-existing and unauthorized-nonexistent are
      // INDISTINGUISHABLE (the lane is no existence oracle), both map here.
      return Object.freeze({
        kind: UNAUTHORIZED_REF_KIND,
        imageId: subject.imageId,
        objectId: subject.objectId,
        reason: error?.message ?? 'unauthorized',
      });
    }
    // Authorized but missing. The PRIMARY discriminator is the lane-owned stable error code
    // (`error.code === 'OBJECT_NOT_FOUND'`, image-object-read-binding.js ObjectReadNotFoundError) —
    // machine-readable, not message-text. The exact single-owned message prefix
    // (`object not found: <imageId>/<objectId>`) is kept as a fallback for a substrate that predates
    // the code. Never a bare /not found/i: an operational TypeError whose message merely CONTAINS
    // "not found" (e.g. `activation block not found: ...` from a wrong readBlockId, `... interface
    // not found: ...`) is NOT a missing object and must fall through to the operational branch below
    // with its original message.
    const isNotFound = error?.code === 'OBJECT_NOT_FOUND'
      || (error instanceof TypeError && /^object not found: /.test(error?.message ?? ''));
    if (isNotFound) {
      return Object.freeze({
        kind: UNAVAILABLE_REF_KIND,
        imageId: subject.imageId,
        objectId: subject.objectId,
        reason: error?.message ?? 'unavailable',
      });
    }
    // Backend/operational failure: surface as unavailable, never as
    // "unauthorized" and never a crash.
    return Object.freeze({
      kind: UNAVAILABLE_REF_KIND,
      imageId: subject.imageId,
      objectId: subject.objectId,
      reason: error?.message ?? 'read failed',
    });
  }

  /**
   * navigate(subject, {authority, readBlockId})
   *   -> Promise<{presentations, commands, failures, versionToken?}>
   *
   * The async entry point. Reads the referenced object fresh under explicit
   * authority (a ref is never authority), then returns the discovered result
   * directly. `authority` is threaded to the read seam per call and is NEVER
   * stored on the navigator; `readBlockId` names the authorized read block.
   *  - read succeeds: the subject is the ref; context carries the record's
   *    leaf slots (Values keyed by slot id) and its references (raw ref Values
   *    walked from slots + indexed — the only structures the read lane
   *    discloses — revision preserved, never string-split; shape/behavior are
   *    not followed because the lane does not return them). The read lane's
   *    versionToken is surfaced as a SIBLING field (transient optimistic-
   *    concurrency state), NEVER inside Presentation/context — it must not
   *    leak into the SemanticUi description, the renderer presentationDescriptor,
   *    the Compositor durableIntent, or Perspective persistence.
   *  - read denied / fails: the subject is materialized as an
   *    unauthorized-ref / unavailable-ref so the fallback provider presents it
   *    explicitly; such results carry NO versionToken.
   */
  async function navigate(subject, {authority = null, readBlockId} = {}) {
    if (!isRef(subject)) {
      throw new TypeError('navigate requires a ref subject {kind: "ref"|"pinned-ref", objectId}');
    }
    let record = null;
    let readError = null;
    try {
      record = await adapter.readObject({
        imageId: subject.imageId, objectId: subject.objectId, authority, blockId: readBlockId,
      });
    } catch (error) {
      readError = error;
    }

    if (record === null || record === undefined) {
      const failureSubject = readError
        ? readFailureSubject(subject, readError)
        : Object.freeze({
          kind: UNAVAILABLE_REF_KIND,
          imageId: subject.imageId,
          objectId: subject.objectId,
          reason: 'unavailable',
        });
      return inspect(failureSubject, {});
    }

    const context = Object.freeze({
      fields: Object.freeze({...(record.slots ?? {})}),
      references: Object.freeze(referencesOfLaneRecord(record)),
    });
    // versionToken is transient concurrency state: a sibling field on the result,
    // NEVER part of the Presentation/context (see the navigate doc comment).
    return inspect(subject, context, {versionToken: record.versionToken});
  }

  return Object.freeze({inspect, navigate});
}

export {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND, createObjectNavigator};
