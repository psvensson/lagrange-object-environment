/**
 * SelectionModel: the owner of SEMANTIC SELECTION — which semantic subject(s)
 * the user means. This is strictly NOT focus:
 *
 *   Focus     = which LOGICAL VIEW receives interaction (transient Session
 *               state, about a VIEW; owned by the Compositor).
 *   Selection = which SEMANTIC SUBJECT the user means (semantic identity,
 *               about OBJECTS; owned here).
 *
 * Two presentations of the same object (a source view A1 and a 3D view A2) can
 * have distinct view focus while referring to the SAME semantic selection:
 * focus = A2, selection = Object A.
 *
 * Invariants:
 *  - Selection holds a SEMANTIC SUBJECT (the presentationDescriptor.subject
 *    data), keyed by semantic identity — NEVER a renderer surface handle.
 *    Renderer teardown/recreation (new GPU/surface handles) cannot change the
 *    selection, because selection is not bound to any handle.
 *  - Selection confers ZERO authority. It is identity, not a capability.
 *  - Selection is TRANSIENT by default; it is never written to a Perspective.
 *    Only a later explicit promotion mechanism (a separate slice) may put a
 *    semantic selection into durable state.
 *  - The subject comes from the environment's own view/presentation structure,
 *    never from renderer input. The SelectionModel is handed a subject by the
 *    caller (e.g. the Compositor resolving a view's presentationDescriptor);
 *    it does not read the renderer.
 */

// A semantic-identity key for a subject. Subjects are image-ref-Value-as-data
// ({kind:'ref', imageId, objectId}); identity is the (imageId, objectId) pair,
// NOT the object reference (a reference is never authority, and two references
// to the same object are the same selection).
function selectionKey(subject) {
  if (!subject || typeof subject !== 'object') return null;
  if (subject.kind === 'ref' && typeof subject.objectId === 'string') {
    // Distinguish a missing imageId from an empty one (they are different
    // subjects); JSON-encode each part so no separator collision can merge
    // two distinguishable identities.
    const imageId = typeof subject.imageId === 'string' ? subject.imageId : null;
    return JSON.stringify([imageId, subject.objectId]);
  }
  return null;
}

function createSelectionModel() {
  // The current semantic selection: {subject, key} or null. Single-selection
  // for this slice; multi-selection is a later concern.
  let current = null;

  // Select a semantic subject. The subject is data (an image-ref-Value); the
  // caller (e.g. the Compositor) supplies it from the view's
  // presentationDescriptor — never from the renderer. A subject with no
  // semantic identity (not an image-ref) is NOT selectable: it is a no-op
  // (the current selection is left unchanged, NOT cleared), and select
  // returns null. To clear explicitly, call clear().
  function select(subject) {
    const key = selectionKey(subject);
    if (key === null) return null; // not selectable; leave selection unchanged
    current = Object.freeze({subject: Object.freeze({...subject}), key});
    return key;
  }

  // The current selection: {subject, key} or null. Read-only snapshot.
  function selection() {
    return current;
  }

  // The selected subject (semantic identity data), or null.
  function selectedSubject() {
    return current?.subject ?? null;
  }

  // Is this subject the current selection (by semantic identity, not reference)?
  function isSelected(subject) {
    const key = selectionKey(subject);
    return current !== null && key !== null && current.key === key;
  }

  // Clear the selection. Idempotent.
  function clear() {
    current = null;
  }

  return Object.freeze({select, selection, selectedSubject, isSelected, clear});
}

export {createSelectionModel};
