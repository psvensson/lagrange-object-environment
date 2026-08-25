import {Perspective} from './model.js';

/**
 * Projection between the in-memory `Perspective` and its durable image
 * representation, per ADR 0012 (indexed form, formatVersion 3).
 *
 * A durable Perspective is a small OBJECT GRAPH: one Perspective object plus
 * one child object per presentation. All scalar data lives in leaf slots
 * (text/integer); every graph edge is a ref slot Value or an indexed ref
 * element; nothing is stored in metadata. Membership and ordering have exactly
 * one owner: the Perspective's ordered indexed part.
 *
 * This module is pure and renderer-independent: it knows the Lagrange Images
 * *Value contract* (tagged ref/pinned-ref/integer/text records) but has no
 * dependency on a running image, backend or session.
 *
 * The encode is TWO-PHASE because the Perspective's indexed ref-list needs the
 * child ids, which exist only after the children are created (substrate ADR
 * 0064 §6: presentations first, the Perspective last — the Perspective is the
 * commit point):
 *   1. encodePresentations(perspective) -> presentationRecords[]
 *   2. (adapter creates each child, collecting refs)
 *   3. encodePerspectiveRecord(perspective, childRefs) -> perspectiveRecord
 *
 * Decode is indexed-driven: decodePerspective({id, perspectiveRecord,
 * resolveChild}) reads the Perspective's indexed part to enumerate its
 * children (forward enumeration restored) and assembles them in order.
 *
 * Invariants enforced here:
 *  - every edge is a ref slot Value or indexed element; a ref never hides in a
 *    text slot (the serializer asserts context/state/layout are ref-free);
 *  - a Perspective's durable subject is always a ref;
 *  - pinned refs keep their revision and unpinned refs stay unpinned;
 *  - decoding yields a Perspective and nothing else: no authority is created.
 */

const VALUE_KIND = Object.freeze({
  REF: 'ref',
  PINNED_REF: 'pinned-ref',
});

// Versions 1 and 2 were designed but never durably persisted; readers accept
// only 3.
const PERSPECTIVE_FORMAT_VERSION = 3;

function isObjectRef(value) {
  return Boolean(
    value && typeof value === 'object' && value.kind === VALUE_KIND.REF &&
    typeof value.imageId === 'string' && value.imageId.length > 0 &&
    typeof value.objectId === 'string' && value.objectId.length > 0,
  );
}

function isPinnedRef(value) {
  return Boolean(
    value && typeof value === 'object' && value.kind === VALUE_KIND.PINNED_REF &&
    typeof value.imageId === 'string' && value.imageId.length > 0 &&
    typeof value.objectId === 'string' && value.objectId.length > 0 &&
    typeof value.revision === 'string' && value.revision.length > 0,
  );
}

function isRef(value) {
  return isObjectRef(value) || isPinnedRef(value);
}

function requireRefSubject(subject, label) {
  if (!isRef(subject)) {
    throw new TypeError(
      `${label} must be an image ref (kind "ref" or "pinned-ref"); a durable Perspective cannot point at a non-durable subject`,
    );
  }
  return subject;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return value;
}

// A ref must never hide inside a value about to be serialized into a text slot
// (the substrate's flat-walker rule: an edge in a leaf is invisible). Reject
// anything ref-SHAPED (kind 'ref'/'pinned-ref'), not only well-formed refs.
function assertRefFree(value, label) {
  if (value && typeof value === 'object' && (value.kind === VALUE_KIND.REF || value.kind === VALUE_KIND.PINNED_REF)) {
    throw new TypeError(`${label} must not contain a ref; graph edges belong in slots, not text`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRefFree(entry, `${label}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertRefFree(entry, `${label}.${key}`);
    }
  }
  return value;
}

function toTextSlot(value, label) {
  if (value === null || value === undefined) return '';
  requirePlainObject(value, label);
  assertRefFree(value, label);
  return JSON.stringify(value);
}

function fromTextSlot(text, label) {
  if (text === '' || text === null || text === undefined) return {};
  if (typeof text !== 'string') {
    throw new TypeError(`${label} must be a text slot string`);
  }
  const parsed = JSON.parse(text);
  return requirePlainObject(parsed, label);
}

function textValueOf(slot) {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && slot.kind === 'text' && typeof slot.value === 'string') {
    return slot.value;
  }
  throw new TypeError('expected a text slot Value');
}

function integerOf(slot, label) {
  // An integer Value is {kind:'integer', value:'<decimal>'}; match the
  // substrate's canonical form (/^-?\d+$/) rather than BigInt's leniency.
  if (slot && typeof slot === 'object' && slot.kind === 'integer' && typeof slot.value === 'string') {
    if (!/^-?\d+$/.test(slot.value)) {
      throw new TypeError(`${label} must be a decimal-string integer Value`);
    }
    return BigInt(slot.value);
  }
  if (typeof slot === 'number' && Number.isSafeInteger(slot)) return BigInt(slot);
  throw new TypeError(`${label} must be an integer slot Value`);
}

function integerSlot(n) {
  return {kind: 'integer', value: BigInt(n).toString(10)};
}

function textSlot(s) {
  return {kind: 'text', value: s};
}

/**
 * Phase 1: encode each presentation into its child record (slots only; the
 * record carries no membership or order — those live on the Perspective).
 *
 * Returns presentationRecords[] in the Perspective's presentation order.
 */
function encodePresentations(perspective) {
  if (!(perspective instanceof Perspective)) {
    throw new TypeError('encodePresentations expects a Perspective');
  }
  return Object.freeze(perspective.presentations.map((presentation, index) => {
    requirePlainObject(presentation, `presentations[${index}]`);
    const {id, kind, subject, context = {}, state = {}} = presentation;
    requireNonEmptyString(id, `presentations[${index}].id`);
    requireNonEmptyString(kind, `presentations[${index}].kind`);
    requireRefSubject(subject, `presentations[${index}].subject`);
    requirePlainObject(context, `presentations[${index}].context`);
    requirePlainObject(state, `presentations[${index}].state`);
    return Object.freeze({
      slots: Object.freeze({
        subject,
        id: textSlot(id),
        kind: textSlot(kind),
        context: textSlot(toTextSlot(context, `presentations[${index}].context`)),
        state: textSlot(toTextSlot(state, `presentations[${index}].state`)),
      }),
    });
  }));
}

/**
 * Phase 3: encode the Perspective record, given the refs of its (already
 * created) children in presentation order.
 *
 * childRefs: an array of ref/pinned-ref Values, one per presentation, in the
 * same order encodePresentations produced them. Returns
 * { slots: {subject, title, layout, formatVersion}, indexed: childRefs }.
 */
function encodePerspectiveRecord(perspective, childRefs) {
  if (!(perspective instanceof Perspective)) {
    throw new TypeError('encodePerspectiveRecord expects a Perspective');
  }
  if (!Array.isArray(childRefs)) {
    throw new TypeError('childRefs must be an array of ref Values');
  }
  if (childRefs.length !== perspective.presentations.length) {
    throw new TypeError(
      `childRefs length ${childRefs.length} does not match ${perspective.presentations.length} presentations`,
    );
  }
  childRefs.forEach((childRef, index) => requireRefSubject(childRef, `childRefs[${index}]`));

  const subject = requireRefSubject(perspective.subject, 'subject');

  return Object.freeze({
    slots: Object.freeze({
      subject,
      title: textSlot(perspective.title ?? ''),
      layout: textSlot(toTextSlot(perspective.layout ?? {}, 'layout')),
      formatVersion: integerSlot(PERSPECTIVE_FORMAT_VERSION),
    }),
    indexed: Object.freeze([...childRefs]),
  });
}

function decodePresentation(record, label) {
  const slots = requirePlainObject(record?.slots, `${label}.slots`);
  const subject = requireRefSubject(slots.subject, `${label}.slots.subject`);
  return Object.freeze({
    id: textValueOf(slots.id),
    kind: textValueOf(slots.kind),
    subject,
    context: Object.freeze(fromTextSlot(textValueOf(slots.context), `${label}.context`)),
    state: Object.freeze(fromTextSlot(textValueOf(slots.state), `${label}.state`)),
  });
}

/**
 * Reassemble a Perspective from its durable object graph, driven by the
 * Perspective's indexed part.
 *
 * { id, perspectiveRecord, resolveChild } -> Promise<Perspective>
 *   perspectiveRecord: the Perspective's stored record (slots + indexed).
 *   resolveChild: async (childRef) => childRecord. The adapter supplies it
 *     (e.g. images.getObject); it is how the children are read.
 *
 * Children are enumerated from perspectiveRecord.indexed in order (forward
 * enumeration), each resolved and decoded. Decoding is data-only: no
 * authority, no live refs, no session state.
 */
async function decodePerspective({id, perspectiveRecord, resolveChild} = {}) {
  requireNonEmptyString(id, 'durable perspective id');
  if (typeof resolveChild !== 'function') {
    throw new TypeError('decodePerspective requires a resolveChild function');
  }
  const slots = requirePlainObject(perspectiveRecord?.slots, 'perspectiveRecord.slots');

  const version = integerOf(slots.formatVersion, 'slots.formatVersion');
  if (version !== BigInt(PERSPECTIVE_FORMAT_VERSION)) {
    throw new TypeError(`unsupported perspective formatVersion: ${version}`);
  }

  const subject = requireRefSubject(slots.subject, 'slots.subject');

  const childRefs = perspectiveRecord.indexed ?? [];
  if (!Array.isArray(childRefs)) {
    throw new TypeError('perspectiveRecord.indexed must be an array of ref Values');
  }
  const presentations = [];
  for (const [index, childRef] of childRefs.entries()) {
    requireRefSubject(childRef, `perspectiveRecord.indexed[${index}]`);
    const childRecord = await resolveChild(childRef);
    presentations.push(decodePresentation(childRecord, `indexed[${index}]`));
  }

  return new Perspective({
    id,
    subject,
    title: textValueOf(slots.title) || null,
    presentations,
    layout: fromTextSlot(textValueOf(slots.layout), 'layout'),
  });
}

export {
  PERSPECTIVE_FORMAT_VERSION,
  decodePerspective,
  encodePerspectiveRecord,
  encodePresentations,
  isRef,
};
