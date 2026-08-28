/**
 * The SemanticUi contract (SemanticUi/v1) — ADR 0013's host-neutral tool-UI
 * description. A Presentation is projected to a SemanticUi document of PLAIN
 * DATA, which a host-specific realizer (browser DOM, Linux GTK) turns into
 * native controls. This module is the SINGLE owner of the contract: the
 * vocabulary, the projector, the Value->display-text normalization, and the
 * validation. It is host-independent — no DOM, no GTK, no Node-only APIs.
 *
 * VOCABULARY (semantic, NOT a widget toolkit — "what the user can do", never
 * pixel layout): group / text / field / collection / action. `choice` is in the
 * architectural vocabulary but is NOT yet produced (no existing tool needs it).
 *
 * A SemanticUi document is TRANSIENT realization data, never a durable model:
 * it carries display strings and DESCRIPTOR-LOCAL action keys ONLY — no refs,
 * subjects, authority, callbacks, DOM/GTK objects, pixel geometry, or
 * executable Commands. The `action.key` preserves the PR #33 security property:
 * a host can say "the user activated item N" but can never invent a semantic
 * identity; the ENVIRONMENT resolves key -> current ref (EnvironmentShell).
 *
 * VALIDATION is owned HERE (one authoritative contract), not re-decided per
 * realizer. It LOUDLY rejects: unknown versions/node kinds, host-specific
 * fields (tagName/cssClass/GtkWidget/coordinates...) at BOTH the document and
 * every node level, and any ref/subject smuggled in. The checked-in fixture
 * corpus (green + red) is the conformance suite both the JS and the Rust
 * validators run against.
 *
 * CONFORMANCE NOTE (for the Rust validator — replicate exactly, or the two
 * validators drift): ref/host detection inspects each node's DIRECT own
 * properties (and the document's). Unknown extra properties are TOLERATED
 * (forward-compat) and not recursed, EXCEPT the structural `children`/`items`
 * arrays which are recursed as nodes. A ref nested inside an arbitrary unknown
 * array property is not detected (no realizer reads unknown keys). Keep the
 * Rust validator's tolerance identical to this.
 */

const VERSION = 1;

const NODE_KINDS = Object.freeze(['group', 'text', 'field', 'collection', 'action']);

// Fields that would make a node host-specific (DOM, GTK, or geometry). Their
// presence anywhere in a node is a contract violation.
const FORBIDDEN_KEYS = Object.freeze([
  'tagName', 'cssClass', 'className', 'style', 'css',
  'GtkWidget', 'gtkWidget', 'widget',
  'x', 'y', 'width', 'height', 'left', 'top', 'coordinates', 'bounds', 'geometry',
]);

// A node value must be a display string or a finite integer key — never a
// structured ref/subject. Detect ref/subject-shaped objects.
function isRefLike(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    (typeof value.objectId === 'string' ||
      value.kind === 'ref' ||
      value.kind === 'pinned-ref' ||
      typeof value.imageId === 'string')
  );
}

function fail(message) {
  throw new TypeError(`SemanticUi/v1 contract violation: ${message}`);
}

// Validate one node recursively. `path` is for error messages.
function validateNode(node, path) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) {
    fail(`${path}: a node must be a plain object`);
  }
  const kind = node.kind;
  if (!NODE_KINDS.includes(kind)) {
    fail(`${path}: unknown node kind ${JSON.stringify(kind)} (want one of ${NODE_KINDS.join('/')})`);
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      fail(`${path}.${kind}: host-specific field ${JSON.stringify(key)} is not allowed (semantic, not DOM/GTK/geometry)`);
    }
    if (isRefLike(node[key])) {
      fail(`${path}.${kind}.${key}: a ref/subject may not appear in a SemanticUi node (display data + descriptor-local keys only)`);
    }
  }
  switch (kind) {
    case 'group': {
      if (node.title != null && typeof node.title !== 'string') fail(`${path}.group.title must be a string`);
      if (!Array.isArray(node.children)) fail(`${path}.group.children must be an array`);
      node.children.forEach((child, i) => validateNode(child, `${path}.children[${i}]`));
      break;
    }
    case 'text': {
      if (typeof node.text !== 'string') fail(`${path}.text.text must be a string`);
      if (node.role != null && typeof node.role !== 'string') fail(`${path}.text.role must be a string`);
      break;
    }
    case 'field': {
      if (typeof node.label !== 'string') fail(`${path}.field.label must be a string`);
      if (typeof node.text !== 'string') fail(`${path}.field.text must be a string`);
      break;
    }
    case 'collection': {
      if (node.label != null && typeof node.label !== 'string') fail(`${path}.collection.label must be a string`);
      if (!Array.isArray(node.items)) fail(`${path}.collection.items must be an array`);
      node.items.forEach((item, i) => validateNode(item, `${path}.items[${i}]`));
      break;
    }
    case 'action': {
      if (typeof node.label !== 'string') fail(`${path}.action.label must be a string`);
      if (!Number.isInteger(node.key) || node.key < 0) {
        fail(`${path}.action.key must be a non-negative integer (a descriptor-local item key)`);
      }
      break;
    }
    default:
      fail(`${path}: unhandled kind ${kind}`);
  }
  return node;
}

/**
 * Validate a whole SemanticUi document. Returns it (frozen) on success; throws
 * a TypeError on any violation. Unknown `version` fails loudly.
 */
function validateSemanticUi(doc) {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) fail('the document must be a plain object');
  if (doc.kind !== 'semantic-ui') fail(`document.kind must be 'semantic-ui', got ${JSON.stringify(doc.kind)}`);
  if (doc.version !== VERSION) fail(`unsupported version ${JSON.stringify(doc.version)} (this host understands ${VERSION})`);
  if (doc.root == null) fail('document.root is required');
  // The document object itself is data too: no host-specific fields or
  // smuggled refs at the top level (only kind/version/root are expected).
  for (const key of Object.keys(doc)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      fail(`document: host-specific field ${JSON.stringify(key)} is not allowed (semantic, not DOM/GTK/geometry)`);
    }
    if (isRefLike(doc[key])) {
      fail(`document.${key}: a ref/subject may not appear in a SemanticUi document`);
    }
  }
  validateNode(doc.root, 'root');
  return Object.freeze(doc);
}

// --- Value -> display-text normalization (moved OUT of the DOM realizer; the
// single owner of how a leaf Value reads as text, shared by every realizer). ---
function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value); // scalar leaf Values
  }
  if (typeof value === 'object') {
    if (typeof value.value === 'string') return value.value; // text Value
    if (typeof value.value === 'number' || typeof value.value === 'boolean') return String(value.value); // int/bool Value
    if (value.kind === 'ref' || value.kind === 'pinned-ref') return `-> ${value.objectId}`;
    if (typeof value.objectId === 'string') return `-> ${value.objectId}`;
  }
  return String(value);
}

/**
 * Project a presentationDescriptor to a SemanticUi/v1 document. Called INSIDE a
 * realizer's attach path (the adapter/Compositor boundary is unchanged and
 * SemanticUi never enters durableIntent). The result is validated before it is
 * returned, so a realizer always receives a conforming document.
 *
 * Owns ALL semantic shaping that used to live in the DOM realizer: the heading
 * text, the unavailable-vs-unauthorized reason line, the field normalization,
 * and the reference rows -> action(key) mapping.
 */
function semanticUiForPresentation(presentationDescriptor) {
  const kind = presentationDescriptor?.kind;
  const params = presentationDescriptor?.parameters ?? {};
  const subject = presentationDescriptor?.subject ?? {};
  const objectId = subject.objectId ?? '';

  const children = [];

  // Heading (explicit role, not positional).
  const heading = kind === 'navigator'
    ? `Navigator: ${objectId}`
    : kind === 'inspector'
      ? `Inspector: ${objectId}`
      : kind; // unavailable-reference | unauthorized-reference
  children.push({kind: 'text', role: 'heading', text: heading});

  if (kind === 'unavailable-reference' || kind === 'unauthorized-reference') {
    // An explicit reason, nothing else.
    const reason = `${kind === 'unauthorized-reference' ? 'Not authorized' : 'Unavailable'}: ${objectId}${params.reason ? ` (${params.reason})` : ''}`;
    children.push({kind: 'text', role: 'reason', text: reason});
  } else {
    // Fields (slot -> display text).
    const fields = params.fields ?? {};
    for (const slot of Object.keys(fields)) {
      children.push({kind: 'field', label: slot, text: valueText(fields[slot])});
    }
    // References -> a collection of descriptor-local actions.
    const references = Array.isArray(params.references) ? params.references : [];
    if (references.length > 0) {
      children.push({
        kind: 'collection',
        label: 'References',
        items: references.map((r, index) => ({
          kind: 'action',
          key: index, // DESCRIPTOR-LOCAL key, never the ref itself
          label: r?.objectId ?? String(index),
        })),
      });
    }
  }

  return validateSemanticUi({
    kind: 'semantic-ui',
    version: VERSION,
    root: {kind: 'group', title: heading, children},
  });
}

export {
  VERSION as SEMANTIC_UI_VERSION,
  NODE_KINDS as SEMANTIC_UI_NODE_KINDS,
  validateSemanticUi,
  semanticUiForPresentation,
  valueText,
};
export default {
  SEMANTIC_UI_VERSION: VERSION,
  SEMANTIC_UI_NODE_KINDS: NODE_KINDS,
  validateSemanticUi,
  semanticUiForPresentation,
  valueText,
};
