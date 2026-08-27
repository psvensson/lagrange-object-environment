/**
 * Composition persistence — the tree <-> Perspective boundary owner
 * (docs/ownership.md). This module owns THREE things, and only these:
 *
 *  1. The tree<->presentations BIJECTION: set(composition leaf viewIds) ===
 *     set(Perspective presentation ids), every id unique on both sides. The
 *     Perspective's indexed part owns durable child MEMBERSHIP + canonical
 *     record ENUMERATION order; the composition tree owns ARRANGEMENT
 *     structure/order. They must not drift: an orphan presentation, a dangling
 *     leaf, or a duplicate id on either side is a loud error. ENFORCED at the
 *     save/restore seam (not an optional caller helper).
 *
 *  2. The versioned composition-layout codec: layout = {kind:'composition',
 *     version:1, root:<CompositionNode>}. The Perspective GRAPH formatVersion
 *     stays 3 (the physical representation is unchanged); the composition
 *     LAYOUT version is a separate axis (what the layout JSON means). Unknown
 *     composition versions reject loudly. A LEGACY layout (no
 *     kind:'composition') is preserved OPAQUELY and yields NO tree — it is NOT
 *     silently coerced and NOT rejected (existing durable Perspectives may
 *     carry it; rejection would be a breaking read).
 *
 *  3. The empty() zero-case mapping: an empty composition <-> zero
 *     presentations, distinguished from a legacy layout by the
 *     kind:'composition' tag.
 *
 * It CONSUMES the composition kernel (`validate`/`leafViewIds`) — the kernel
 * stays the single owner of what a well-formed node is — and is CONSUMED BY
 * the Perspective projection at the layout-slot boundary. The projection stays
 * opaque (slot mechanics + ref-free); this module owns the composition meaning
 * of the layout payload. It never persists a viewDescriptor (that is
 * renderer/surface realization, supplied on restore by world/surface policy).
 */

import {validate, leafViewIds} from './composition-tree.js';

const COMPOSITION_LAYOUT_KIND = 'composition';
const COMPOSITION_LAYOUT_VERSION = 1;

function fail(message) {
  throw new TypeError(`composition-persistence: ${message}`);
}

// --- the bijection ----------------------------------------------------------

/**
 * Enforce the tree<->presentations bijection. `presentations` is an array of
 * {id, ...} (Perspective Presentations; presentation.id === durable viewId).
 * Throws loudly on: a dangling composition leaf (in the tree, no matching
 * presentation), an orphan presentation (a presentation not in the tree), or a
 * duplicate presentation id. Duplicate tree leaves are already rejected by the
 * kernel at construction/validate. Returns the validated tree.
 */
function assertCompositionBijection(tree, presentations) {
  const valid = validate(tree); // rejects malformed nodes + duplicate leaves
  if (!Array.isArray(presentations)) fail('presentations must be an array of {id, ...}');
  const leafIds = new Set(leafViewIds(valid));
  const presentationIds = new Set();
  for (const [index, p] of presentations.entries()) {
    const id = p?.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`presentations[${index}] must carry a non-empty string id (presentation.id === durable viewId)`);
    }
    if (presentationIds.has(id)) {
      fail(`duplicate presentation id "${id}" (each durable view has one presentation; a duplicate identity is malformed)`);
    }
    presentationIds.add(id);
  }
  // Dangling leaf: in the tree, not in the presentations.
  for (const id of leafIds) {
    if (!presentationIds.has(id)) {
      fail(`composition leaf "${id}" has no matching presentation (dangling leaf — tree and presentations must be a bijection)`);
    }
  }
  // Orphan presentation: in the presentations, not in the tree.
  for (const id of presentationIds) {
    if (!leafIds.has(id)) {
      fail(`presentation "${id}" is not in the composition tree (orphan presentation — tree and presentations must be a bijection)`);
    }
  }
  return valid;
}

// --- the versioned layout codec ----------------------------------------------

/**
 * Encode a composition tree (+ its presentations, for the bijection check) to
 * the durable layout payload: {kind:'composition', version:1, root:<tree>}.
 * Enforces the bijection at SAVE time. The result is plain ref-free JSON (the
 * projection's layout text slot asserts ref-free separately).
 */
function encodeCompositionLayout(tree, presentations) {
  const valid = assertCompositionBijection(tree, presentations);
  return {
    kind: COMPOSITION_LAYOUT_KIND,
    version: COMPOSITION_LAYOUT_VERSION,
    root: JSON.parse(JSON.stringify(valid)), // plain data, no frozen/live refs
  };
}

/**
 * Decode a durable layout payload to a composition tree. `presentations` is
 * REQUIRED (the bijection is re-enforced at the restore seam, not opt-out).
 * Returns:
 *  - {composition: <tree>}  for a kind:'composition' payload (version-checked,
 *    validated, bijection re-checked against `presentations`);
 *  - {composition: null, legacy: true}  for a LEGACY layout (no
 *    kind:'composition') — preserved opaquely, NOT coerced, NOT rejected.
 * Unknown composition versions reject loudly. Malformed trees reject via the
 * kernel's validate.
 */
function decodeCompositionLayout(layout, presentations) {
  if (!layout || typeof layout !== 'object' || layout.kind !== COMPOSITION_LAYOUT_KIND) {
    // Legacy / not-a-composition: preserve opaquely, yield no tree.
    return Object.freeze({composition: null, legacy: true, layout});
  }
  if (layout.version !== COMPOSITION_LAYOUT_VERSION) {
    fail(`unsupported composition layout version: ${JSON.stringify(layout.version)} (supported: ${COMPOSITION_LAYOUT_VERSION})`);
  }
  if (!Array.isArray(presentations)) {
    fail('decodeCompositionLayout requires the Perspective presentations array (the tree<->presentation bijection is enforced at the restore seam, not opt-out)');
  }
  const tree = validate(layout.root);
  assertCompositionBijection(tree, presentations);
  return Object.freeze({composition: tree, legacy: false});
}

// --- the restore orchestration seam ------------------------------------------

/**
 * Project a Perspective Presentation to the presentationDescriptor the
 * Compositor consumes: {kind, subject, parameters}. `parameters` comes from the
 * Presentation's `context`; `state` does NOT reach openView (it is retained
 * view state — restored separately if/when the roadmap's retained-state item
 * lands, never via presentationDescriptor).
 */
function presentationToDescriptor(p) {
  return {kind: p.kind, subject: p.subject, parameters: p.context ?? {}};
}

/**
 * Restore a composition-backed Perspective into a Compositor Session: decode
 * the tree from the Perspective's layout, re-check the bijection, then
 * `openView` each leaf with its SAME durable viewId, a presentationDescriptor
 * projected from the Perspective's Presentation, and a CONCRETE viewDescriptor
 * supplied by the injected world/surface realization POLICY.
 *
 * The Perspective does NOT persist a viewDescriptor (renderer/surface
 * realization is not durable arrangement intent); the policy supplies it here.
 * `viewDescriptorFor(viewId, presentation)` -> a viewDescriptor. When omitted,
 * a trivial default canvas policy is used (sufficient for tests/headless).
 *
 * Returns {composition, restoredViewIds}. Legacy layout (no composition) -> a
 * loud error (this orchestrator restores COMPOSITIONS only).
 */
async function restoreComposition(perspective, compositor, {viewDescriptorFor = null} = {}) {
  const decoded = decodeCompositionLayout(perspective.layout, perspective.presentations);
  if (decoded.legacy || !decoded.composition) {
    fail('restoreComposition requires a composition-backed Perspective (the layout is not a composition payload)');
  }
  const composition = decoded.composition;
  const byViewId = new Map(perspective.presentations.map((p) => [p.id, p]));
  const descriptorFor = typeof viewDescriptorFor === 'function'
    ? viewDescriptorFor
    : () => ({kind: 'canvas', width: 64, height: 64});
  const restoredViewIds = [];
  for (const viewId of leafViewIds(composition)) {
    const p = byViewId.get(viewId); // bijection guarantees presence
    await compositor.openView({
      viewId,
      viewDescriptor: descriptorFor(viewId, p),
      presentationDescriptor: presentationToDescriptor(p),
    });
    restoredViewIds.push(viewId);
  }
  return Object.freeze({composition, restoredViewIds: Object.freeze(restoredViewIds)});
}

export {
  COMPOSITION_LAYOUT_KIND,
  COMPOSITION_LAYOUT_VERSION,
  assertCompositionBijection,
  encodeCompositionLayout,
  decodeCompositionLayout,
  presentationToDescriptor,
  restoreComposition,
};
export default {
  COMPOSITION_LAYOUT_KIND,
  COMPOSITION_LAYOUT_VERSION,
  assertCompositionBijection,
  encodeCompositionLayout,
  decodeCompositionLayout,
  presentationToDescriptor,
  restoreComposition,
};
