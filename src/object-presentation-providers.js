import {Presentation} from './model.js';
import {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND} from './object-navigator.js';

/**
 * The generic-object presentation providers: the first real consumers of
 * PresentationRegistry (docs/ownership.md). They plug the generic-object
 * experience into discovery rather than hard-coding if-object-then-inspector.
 *
 * Each provider is {id, present(subject, context) -> Presentation | null}:
 * synchronous, renderer-independent, returning null when it cannot present the
 * subject. The providers are disjoint by subject kind, so registration order
 * between them never races:
 *  - object-inspector presents a normal object subject (a ref with its record
 *    in context) as an inspector;
 *  - unavailable-ref presents a {kind: 'unavailable-ref'} subject explicitly;
 *  - unauthorized-ref presents a {kind: 'unauthorized-ref'} subject explicitly,
 *    distinctly from unavailable (a denied read is not "missing").
 *
 * Register them with a PresentationRegistry (fallbacks last, per the
 * registry's ordering contract). The Presentation remains the semantic result;
 * nothing here renders.
 */

function isObjectRefSubject(subject) {
  return Boolean(
    subject && typeof subject === 'object' &&
    (subject.kind === 'ref' || subject.kind === 'pinned-ref') &&
    typeof subject.objectId === 'string',
  );
}

/**
 * The generic object inspector. Presents a normal object subject. The record's
 * leaf slots and references travel in the presentation's context (supplied by
 * the navigator) so a renderer can show them without touching the image.
 */
function createObjectInspectorProvider() {
  return Object.freeze({
    id: 'object-inspector',
    present(subject, context = {}) {
      if (!isObjectRefSubject(subject)) return null;
      return new Presentation({
        id: `inspector:${subject.objectId}`,
        subject,
        kind: 'inspector',
        context: {
          fields: context.fields ?? {},
          references: context.references ?? [],
        },
        state: {},
      });
    },
  });
}

/**
 * The explicit unavailable-reference presentation. Presents a
 * {kind: 'unavailable-ref'} subject so a reference that cannot be read still
 * gets an explicit presentation rather than vanishing. With the authorized
 * object/read lane (substrate ADR 0068) 'unavailable' now means exactly that —
 * the object is missing or the read failed at the backend — and is distinct
 * from 'unauthorized' (see the unauthorized-ref provider).
 */
function createUnavailableRefProvider() {
  return Object.freeze({
    id: 'unavailable-ref',
    present(subject) {
      if (!subject || subject.kind !== UNAVAILABLE_REF_KIND) return null;
      return new Presentation({
        id: `unavailable:${subject.objectId}`,
        subject,
        kind: 'unavailable-reference',
        context: {reason: subject.reason ?? 'unavailable'},
        state: {},
      });
    },
  });
}

/**
 * The explicit unauthorized-reference presentation. Presents a
 * {kind: 'unauthorized-ref'} subject so a reference whose read was DENIED is
 * presented as "you may not read this", distinctly from "unavailable". The
 * substrate enforces object/read before any existence check, so a denied read
 * is unauthorized whether or not the object exists — this presentation never
 * claims the object is missing.
 */
function createUnauthorizedRefProvider() {
  return Object.freeze({
    id: 'unauthorized-ref',
    present(subject) {
      if (!subject || subject.kind !== UNAUTHORIZED_REF_KIND) return null;
      return new Presentation({
        id: `unauthorized:${subject.objectId}`,
        subject,
        kind: 'unauthorized-reference',
        context: {reason: subject.reason ?? 'unauthorized'},
        state: {},
      });
    },
  });
}

export {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider};
