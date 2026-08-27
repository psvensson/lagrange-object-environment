/**
 * Composition tree — the renderer-independent ARRANGEMENT-STRUCTURE intent
 * (docs/ownership.md). This is what a Perspective's layout eventually persists:
 * an immutable, data-representable tree describing how logical views are
 * arranged, WITHOUT any renderer, focus, selection, geometry, or window policy.
 *
 *   CompositionNode :=
 *       presentation(viewId)                          a leaf: one logical view
 *     | split(axis, ratio, first, second)             relative layout of two children
 *     | stack(children, active)                       one slot; one child exposed
 *
 * HARD CONSTRAINTS (the whole point of the kernel):
 *  - Leaves carry ONLY a durable logical `viewId` (data) — never a live
 *    Presentation instance, a renderer surface handle, or a DOM/GPU object.
 *  - Internal split/stack nodes carry NO identity (they are anonymous structure,
 *    addressed by path); only leaves reference durable viewIds.
 *  - NO focus, NO semantic selection, NO authority anywhere in the tree.
 *    `stack.active` is the durable viewId of the exposed child — composition
 *    state, strictly distinct from the Compositor's transient focus.
 *  - `split` is RELATIVE layout (an axis + a ratio), never pixel rectangles.
 *  - `stack` means only "several children occupy one slot, one is active" — NOT
 *    a browser tab widget, notebook, or any particular world realization.
 *  - The tree is immutable and JSON-representable; malformed nodes fail loudly.
 *
 * The Compositor CONSUMES this tree to open/arrange logical views; the tree
 * itself never touches the renderer. Tiling vs overlapping windows vs notebook
 * is a later world/surface-policy decision layered ABOVE this neutral intent.
 */

const AXES = Object.freeze(['row', 'column']);

function fail(message) {
  throw new TypeError(`composition-tree: ${message}`);
}

// A viewId is durable data (a non-empty string), never a live object.
function requireViewId(viewId, where) {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    fail(`${where}: a presentation leaf's viewId must be a non-empty string (durable data, not a live object)`);
  }
  return viewId;
}

// presentation(viewId) — a leaf naming one logical view by its durable viewId.
function presentation(viewId) {
  return Object.freeze({kind: 'presentation', viewId: requireViewId(viewId, 'presentation')});
}

// split(axis, ratio, first, second) — relative layout of two children.
// axis: 'row' | 'column'. ratio: the fraction of the axis given to `first`
// (0 < ratio < 1); `second` gets the remainder. NOT pixels.
function split(axis, ratio, first, second) {
  if (!AXES.includes(axis)) fail(`split axis must be one of ${AXES.join('|')}, got ${JSON.stringify(axis)}`);
  if (typeof ratio !== 'number' || !(ratio > 0 && ratio < 1)) {
    fail(`split ratio must be a number in (0, 1) (relative layout, not pixels), got ${JSON.stringify(ratio)}`);
  }
  return Object.freeze({
    kind: 'split',
    axis,
    ratio,
    first: requireNode(first, 'split.first'),
    second: requireNode(second, 'split.second'),
  });
}

// stack(children, active) — several children occupy one logical slot; exactly
// one is exposed. `active` is the durable viewId of the exposed child (NOT an
// index — an index is reorder-fragile), and must name one of the children's
// leaf viewIds. This is durable composition state, NOT transient focus.
function stack(children, active) {
  if (!Array.isArray(children) || children.length === 0) {
    fail('stack children must be a non-empty array of composition nodes');
  }
  const nodes = children.map((c, i) => requireNode(c, `stack.children[${i}]`));
  const activeId = requireViewId(active, 'stack.active');
  const leafIds = new Set();
  for (const n of nodes) collectLeafViewIds(n, leafIds);
  if (!leafIds.has(activeId)) {
    fail(`stack.active "${activeId}" must name a viewId present in the stack's children (it is the exposed child, not an index)`);
  }
  return Object.freeze({kind: 'stack', children: Object.freeze(nodes), active: activeId});
}

// Validate + freeze an arbitrary node (used for children).
function requireNode(node, where) {
  if (!node || typeof node !== 'object') fail(`${where}: a composition node must be an object, got ${JSON.stringify(node)}`);
  switch (node.kind) {
    case 'presentation':
      return presentation(node.viewId);
    case 'split':
      return split(node.axis, node.ratio, node.first, node.second);
    case 'stack':
      return stack(node.children, node.active);
    default:
      fail(`${where}: unknown composition node kind ${JSON.stringify(node.kind)} (expected presentation|split|stack)`);
  }
}

// Collect every leaf viewId in a subtree (for validation + realization walks).
function collectLeafViewIds(node, into = new Set()) {
  if (node.kind === 'presentation') {
    into.add(node.viewId);
  } else if (node.kind === 'split') {
    collectLeafViewIds(node.first, into);
    collectLeafViewIds(node.second, into);
  } else if (node.kind === 'stack') {
    for (const c of node.children) collectLeafViewIds(c, into);
  }
  return into;
}

// Validate a whole tree (returns the frozen, validated tree). Use this at any
// boundary that accepts a tree (e.g. restore from a Perspective) so malformed
// intent fails loudly at the seam, not deep in realization.
function validate(tree) {
  return requireNode(tree, 'composition');
}

// The set of durable viewIds a tree references (the views the Compositor must
// realize). Data only; no renderer concern.
function leafViewIds(tree) {
  return Object.freeze([...collectLeafViewIds(validate(tree))]);
}

export {presentation, split, stack, validate, leafViewIds};
export default {presentation, split, stack, validate, leafViewIds};
