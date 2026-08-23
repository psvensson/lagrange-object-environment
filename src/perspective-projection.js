import {Perspective} from './model.js';

/**
 * Projection between the in-memory `Perspective` and its durable image
 * representation, per ADR 0008.
 *
 * This module is the semantic core of the `ImageClientAdapter`'s
 * Perspective -> durable-image interaction. It is deliberately pure and
 * renderer-independent: it knows the Lagrange Images *Value contract* (tagged
 * `ref`/`pinned-ref` records) but has no dependency on a running image, a
 * backend or a session. The adapter wraps this with the actual
 * putObject/getObject calls.
 *
 * Invariants enforced here (not merely documented):
 *  - edges are refs in slots, never metadata (the image layer rejects refs in
 *    metadata, so any edge must surface here as a slot Value);
 *  - a Perspective's durable subject is always a ref (the current in-memory
 *    `Perspective` requires a subject, so the durable form does too);
 *  - presentations are encoded as plain data — no callbacks, renderer objects
 *    or Session state;
 *  - pinned refs keep their revision and unpinned refs stay unpinned across a
 *    round trip;
 *  - decoding yields a Perspective and nothing else: no authority is created.
 */

const VALUE_KIND = Object.freeze({
  REF: 'ref',
  PINNED_REF: 'pinned-ref',
});

const PERSPECTIVE_FORMAT_VERSION = 1;

function isObjectRef(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.kind === VALUE_KIND.REF &&
    typeof value.imageId === 'string' &&
    value.imageId.length > 0 &&
    typeof value.objectId === 'string' &&
    value.objectId.length > 0,
  );
}

function isPinnedRef(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.kind === VALUE_KIND.PINNED_REF &&
    typeof value.imageId === 'string' &&
    value.imageId.length > 0 &&
    typeof value.objectId === 'string' &&
    value.objectId.length > 0 &&
    typeof value.revision === 'string' &&
    value.revision.length > 0,
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

function requireJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return value;
}

function encodePresentationSubject(subject, index) {
  // A presentation always names a durable subject; a presentation of "nothing"
  // is not persisted.
  return requireRefSubject(subject, `presentations[${index}].subject`);
}

function encodePresentation(presentation, index) {
  if (!presentation || typeof presentation !== 'object') {
    throw new TypeError(`presentations[${index}] must be an object`);
  }
  const {id, kind, subject, context = {}, state = {}} = presentation;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`presentations[${index}].id must be a non-empty string`);
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError(`presentations[${index}].kind must be a non-empty string`);
  }
  requireJsonObject(context, `presentations[${index}].context`);
  requireJsonObject(state, `presentations[${index}].state`);
  return {
    id,
    kind,
    subject: encodePresentationSubject(subject, index),
    context,
    state,
  };
}

/**
 * Encode an in-memory Perspective into the slot/metadata split of ADR 0008.
 *
 * Returns a plain, JSON-compatible record:
 *   { slots: { subject, presentations }, metadata: { title, layout, formatVersion } }
 * The adapter is responsible for turning this into an image object write.
 */
function encodePerspective(perspective) {
  if (!(perspective instanceof Perspective)) {
    throw new TypeError('encodePerspective expects a Perspective');
  }

  const subject = requireRefSubject(perspective.subject, 'subject');

  const presentations = perspective.presentations.map((p, index) => encodePresentation(p, index));

  if (perspective.layout !== null && perspective.layout !== undefined) {
    requireJsonObject(perspective.layout, 'layout');
  }

  return {
    slots: {
      subject,
      presentations,
    },
    metadata: {
      title: perspective.title ?? null,
      layout: perspective.layout ?? null,
      formatVersion: PERSPECTIVE_FORMAT_VERSION,
    },
  };
}

/**
 * Reconstruct a Perspective from its durable slot/metadata form.
 *
 * Decoding is data-only: it builds a Perspective and attaches no authority,
 * no live refs and no session state.
 */
function decodePerspective({id, slots, metadata} = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('durable perspective id must be a non-empty string');
  }
  requireJsonObject(slots, 'durable perspective slots');
  requireJsonObject(metadata, 'durable perspective metadata');

  const version = metadata.formatVersion;
  if (version !== PERSPECTIVE_FORMAT_VERSION) {
    throw new TypeError(`unsupported perspective formatVersion: ${version}`);
  }

  const subject = requireRefSubject(slots.subject, 'slots.subject');

  if (!Array.isArray(slots.presentations)) {
    throw new TypeError('slots.presentations must be an array');
  }
  const presentations = slots.presentations.map((p, index) => {
    const encoded = encodePresentation(p, index);
    // Preserve the ref exactly (pinned stays pinned, unpinned stays unpinned).
    return Object.freeze({
      id: encoded.id,
      kind: encoded.kind,
      subject: encoded.subject,
      context: Object.freeze({...encoded.context}),
      state: Object.freeze({...encoded.state}),
    });
  });

  return new Perspective({
    id,
    subject,
    title: metadata.title ?? null,
    presentations,
    layout: metadata.layout ?? null,
  });
}

export {
  PERSPECTIVE_FORMAT_VERSION,
  decodePerspective,
  encodePerspective,
  isRef,
};
