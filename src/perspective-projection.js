import {Perspective} from './model.js';

/**
 * Projection between the in-memory `Perspective` and its durable image
 * representation, per ADR 0012 (which supersedes the representation half of
 * ADR 0008).
 *
 * A durable Perspective is a small OBJECT GRAPH: one Perspective object plus
 * one child object per presentation. All scalar data lives in leaf slots
 * (text/integer); all graph edges are ref slot Values; nothing is stored in
 * metadata.
 *
 * This module is the semantic core of the `ImageClientAdapter`'s
 * Perspective -> durable-image interaction. It is pure and renderer-independent:
 * it knows the Lagrange Images *Value contract* (tagged ref/pinned-ref/integer/
 * text records) but has no dependency on a running image, backend or session.
 * The adapter sequences the actual creates (Perspective first, then children)
 * and gathers children for decode.
 *
 * Invariants enforced here:
 *  - every edge is a ref slot Value; a ref never hides in a text slot (the
 *    serializer asserts context/state/layout are ref-free);
 *  - a Perspective's durable subject is always a ref;
 *  - pinned refs keep their revision and unpinned refs stay unpinned;
 *  - decoding yields a Perspective and nothing else: no authority is created.
 */

const VALUE_KIND = Object.freeze({
  REF: 'ref',
  PINNED_REF: 'pinned-ref',
});

// formatVersion 1 (ADR 0008 nested-array) was never durably written; it is
// abandoned, not migrated. Readers reject anything but 2.
const PERSPECTIVE_FORMAT_VERSION = 2;

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
// anything ref-SHAPED (kind 'ref'/'pinned-ref'), not only well-formed refs, so
// an imposter cannot smuggle a would-be edge past the guard.
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

// Serialize a ref-free JSON value to text for a leaf slot, and parse it back.
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
  // A text slot Value is {kind:'text', value}; tolerate a bare string too.
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && slot.kind === 'text' && typeof slot.value === 'string') {
    return slot.value;
  }
  throw new TypeError('expected a text slot Value');
}

function integerOf(slot, label) {
  // An integer Value is {kind:'integer', value:'<decimal>'}; parse, don't
  // expect a JS number. Match the substrate's canonical form exactly
  // (/^-?\d+$/, value/scalars.js): BigInt alone would accept hex, whitespace,
  // signs and the empty string.
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

function encodePresentation(presentation, index) {
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
      id: {kind: 'text', value: id},
      kind: {kind: 'text', value: kind},
      context: {kind: 'text', value: toTextSlot(context, `presentations[${index}].context`)},
      state: {kind: 'text', value: toTextSlot(state, `presentations[${index}].state`)},
      ordinal: integerSlot(index),
    }),
  });
}

/**
 * Encode an in-memory Perspective into the small object graph of ADR 0012.
 *
 * Returns { perspectiveRecord, presentationRecords } where perspectiveRecord is
 * { slots: { subject, title, layout, formatVersion } } and each
 * presentationRecord is { slots: { subject, id, kind, context, state, ordinal } }.
 * The child's `perspective` membership edge is filled by the adapter once the
 * Perspective object exists (the Perspective is created first, empty-but-valid).
 */
function encodePerspective(perspective) {
  if (!(perspective instanceof Perspective)) {
    throw new TypeError('encodePerspective expects a Perspective');
  }
  const subject = requireRefSubject(perspective.subject, 'subject');

  const perspectiveRecord = Object.freeze({
    slots: Object.freeze({
      subject,
      title: {kind: 'text', value: perspective.title ?? ''},
      layout: {kind: 'text', value: toTextSlot(perspective.layout ?? {}, 'layout')},
      formatVersion: integerSlot(PERSPECTIVE_FORMAT_VERSION),
    }),
  });

  const presentationRecords = perspective.presentations.map((p, index) => encodePresentation(p, index));

  return Object.freeze({
    perspectiveRecord,
    presentationRecords: Object.freeze(presentationRecords),
  });
}

function decodePresentation(record, index) {
  requirePlainObject(record, `presentationRecords[${index}]`);
  const slots = requirePlainObject(record.slots, `presentationRecords[${index}].slots`);
  const subject = requireRefSubject(slots.subject, `presentationRecords[${index}].slots.subject`);
  return Object.freeze({
    id: textValueOf(slots.id),
    kind: textValueOf(slots.kind),
    subject,
    context: Object.freeze(fromTextSlot(textValueOf(slots.context), `presentationRecords[${index}].context`)),
    state: Object.freeze(fromTextSlot(textValueOf(slots.state), `presentationRecords[${index}].state`)),
    ordinal: integerOf(slots.ordinal, `presentationRecords[${index}].ordinal`),
  });
}

/**
 * Reassemble a Perspective from its durable object graph.
 *
 * { id, perspectiveRecord, presentationRecords } -> Perspective. The adapter
 * gathers the child records (there is no authorized forward enumeration until
 * lagrange-images#119) and supplies them here; they are sorted by ordinal.
 * Decoding is data-only: no authority, no live refs, no session state.
 *
 * The child's `perspective` membership edge is written by the adapter (it is
 * what makes the child belong to this Perspective) but is intentionally NOT
 * read here: decode receives the children already gathered, so it does not
 * need to re-derive membership. decodePresentation therefore ignores any
 * `perspective` slot on a stored child record.
 */
function decodePerspective({id, perspectiveRecord, presentationRecords = []} = {}) {
  requireNonEmptyString(id, 'durable perspective id');
  const slots = requirePlainObject(perspectiveRecord?.slots, 'perspectiveRecord.slots');

  const version = integerOf(slots.formatVersion, 'slots.formatVersion');
  if (version !== BigInt(PERSPECTIVE_FORMAT_VERSION)) {
    throw new TypeError(`unsupported perspective formatVersion: ${version}`);
  }

  const subject = requireRefSubject(slots.subject, 'slots.subject');

  if (!Array.isArray(presentationRecords)) {
    throw new TypeError('presentationRecords must be an array');
  }
  const presentations = presentationRecords
    .map((record, index) => decodePresentation(record, index))
    // Compare ordinals as BigInt: a position field must not round-trip through
    // Number, which would collapse ordinals beyond MAX_SAFE_INTEGER.
    .sort((a, b) => (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0))
    .map(({ordinal, ...presentation}) => Object.freeze(presentation));

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
  encodePerspective,
  isRef,
};
