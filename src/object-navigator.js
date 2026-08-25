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
 *    re-reads the object fresh; it never trusts the ref's existence. (Reads
 *    are the unguarded host path per substrate ADR 0064 §4, so a missing
 *    object reads as `null` — there is no authorized read lane to signal
 *    "unauthorized" today; see the substrate follow-up Bead.) A pinned-ref's
 *    revision is currently ignored on read: the read seam reads current state
 *    and has no revision parameter (substrate follow-up Bead), so navigation
 *    always shows current state, not the pinned revision.
 *  - discoverable/applicable != authorized (ADR 0004). Commands are
 *    discovered by applicability only; authorization happens at dispatch,
 *    not here.
 */

// The subject kinds the navigator materializes. A normal object subject is a
// ref Value; an unavailable subject is a distinct kind so the unavailable-ref
// provider never races the inspector (they are disjoint by subject kind).
const UNAVAILABLE_REF_KIND = 'unavailable-ref';

function isRef(value) {
  return Boolean(
    value && typeof value === 'object' &&
    (value.kind === 'ref' || value.kind === 'pinned-ref') &&
    typeof value.objectId === 'string' && value.objectId.length > 0,
  );
}

function createObjectNavigator({adapter, presentationRegistry, commandRegistry, referencesOfRecord}) {
  if (!adapter || typeof adapter.readObject !== 'function') {
    throw new TypeError('createObjectNavigator requires an adapter with readObject');
  }
  if (!presentationRegistry || typeof presentationRegistry.discover !== 'function') {
    throw new TypeError('createObjectNavigator requires a presentationRegistry');
  }
  if (!commandRegistry || typeof commandRegistry.discover !== 'function') {
    throw new TypeError('createObjectNavigator requires a commandRegistry');
  }
  // The graph walker is INJECTED (not imported from the substrate) to preserve
  // renderer/environment independence (ADR 0002) — the same rule the adapter
  // follows. In production it is lagrange-images' referencesOfRecord.
  if (typeof referencesOfRecord !== 'function') {
    throw new TypeError('createObjectNavigator requires an injected referencesOfRecord function');
  }

  /**
   * inspect(subject, context) -> {presentations, commands, failures}
   *
   * Synchronous discovery over an ALREADY-MATERIALIZED subject (a ref whose
   * record is in hand, or an unavailable-ref). Providers plug in through the
   * presentationRegistry; applicable Commands come from the commandRegistry
   * (applicability only, never authority).
   */
  function inspect(subject, context = {}) {
    const {presentations, failures} = presentationRegistry.discover(subject, context);
    const {commands, failures: commandFailures} = commandRegistry.discover(subject, context);
    return Object.freeze({
      presentations,
      commands,
      failures: Object.freeze([...failures, ...commandFailures]),
    });
  }

  /**
   * navigate(subject) -> Promise<{presentations, commands, failures}>
   *
   * The async entry point. Reads the referenced object fresh (a ref is never
   * authority), then returns the discovered result directly:
   *  - read succeeds: the subject is the ref; context carries the record's
   *    leaf slots (Values keyed by slot id) and its references (raw ref Values
   *    walked from slots, indexed, shape and behavior — followable graph
   *    edges, revision preserved, never string-split).
   *  - read fails (unavailable): the subject is materialized as
   *    {kind: 'unavailable-ref', ...} so the unavailable-ref provider presents
   *    it explicitly rather than the reference vanishing.
   */
  async function navigate(subject) {
    if (!isRef(subject)) {
      throw new TypeError('navigate requires a ref subject {kind: "ref"|"pinned-ref", objectId}');
    }
    let record = null;
    let unavailableReason = null;
    try {
      record = await adapter.readObject(subject.imageId, subject.objectId);
    } catch (error) {
      // A non-authority read failure (backend unavailable etc.). Reads are
      // unguarded, so this is never an authorization denial — see module note.
      unavailableReason = error?.message ?? 'read failed';
    }

    if (record === null || record === undefined) {
      const unavailableSubject = Object.freeze({
        kind: UNAVAILABLE_REF_KIND,
        imageId: subject.imageId,
        objectId: subject.objectId,
        reason: unavailableReason ?? 'unavailable',
      });
      return inspect(unavailableSubject, {});
    }

    const context = Object.freeze({
      fields: Object.freeze({...(record.slots ?? {})}),
      references: Object.freeze([...referencesOfRecord(record)]),
    });
    return inspect(subject, context);
  }

  return Object.freeze({inspect, navigate});
}

export {UNAVAILABLE_REF_KIND, createObjectNavigator};
