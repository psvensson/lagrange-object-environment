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
 * it carries display strings and DESCRIPTOR-LOCAL keys ONLY — no refs,
 * subjects, authority, callbacks, DOM/GTK objects, pixel geometry, or
 * executable Commands. The `action.key` (and the editable `field.key`)
 * preserves the PR #33 security property: a host can say "the user activated
 * item N" / "the user edited field N" but can never invent a semantic identity;
 * the ENVIRONMENT resolves key -> current ref/slot (EnvironmentShell).
 *
 * EDITING (minimal): a `field` may carry OPTIONAL {key, editable:'text'} — but
 * ONLY together, and ONLY when the slot is in the host-neutral `writable` set
 * (the single owner of which is the ImageClientAdapter's mutation field map,
 * surfaced as adapter.writableSlots). A host edits such a field and commits
 * (Enter/activate) a RAW-STRING intent {kind:'edit-field', key, text} — never a
 * parsed value, because text is the only writable scalar in this slice and raw
 * text has ONE host-neutral interpretation (the canonical text value). The
 * integer/boolean textual grammar is a follow-up when a numeric/bool field is
 * actually made editable. count/flag stay READ-ONLY (no key/editable).
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
      // Editing affordance: key and editable appear ONLY together (an editable
      // field needs its descriptor-local key; a key is meaningless without the
      // editable kind). Both absent => a read-only display field.
      const hasKey = node.key !== undefined;
      const hasEditable = node.editable !== undefined;
      if (hasKey !== hasEditable) {
        fail(`${path}.field: key and editable must appear together (an editable field carries its descriptor-local key)`);
      }
      if (hasEditable) {
        if (node.editable !== 'text') {
          fail(`${path}.field.editable must be 'text' (the only editable scalar in this slice), got ${JSON.stringify(node.editable)}`);
        }
        // Safe-integer cap (not just integral): a descriptor-local key must
        // survive the cross-host round-trip IDENTICALLY. Rust i64 saturate /
        // reject above 2^63, and f64 loses integer precision above 2^53, so the
        // key domain is non-negative SAFE integers on BOTH validators.
        if (!Number.isSafeInteger(node.key) || node.key < 0) {
          fail(`${path}.field.key must be a non-negative safe integer (a descriptor-local field key)`);
        }
      }
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
      // Safe-integer cap (same cross-host identity rule as field.key).
      if (!Number.isSafeInteger(node.key) || node.key < 0) {
        fail(`${path}.action.key must be a non-negative safe integer (a descriptor-local item key)`);
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
 * the reference rows -> action(key) mapping, and the durable Project summary +
 * member rows (display strings plus descriptor-local keys only).
 */
function semanticUiForPresentation(presentationDescriptor) {
  const kind = presentationDescriptor?.kind;
  const params = presentationDescriptor?.parameters ?? {};
  const subject = presentationDescriptor?.subject ?? {};
  const objectId = subject.objectId ?? '';
  const project = params.project ?? {};
  const smalltalkClass = params.smalltalkClass ?? {};
  const smalltalkMethod = params.smalltalkMethod ?? {};

  const children = [];

  // Heading (explicit role, not positional).
  const heading = kind === 'navigator'
    ? `Navigator: ${objectId}`
    : kind === 'inspector'
      ? `Inspector: ${objectId}`
      : kind === 'project'
        ? `Project: ${typeof project.name === 'string' ? project.name : ''}`
      : kind === 'native-class'
        ? `Class: ${typeof smalltalkClass.name === 'string' ? smalltalkClass.name : ''}`
      : kind === 'native-method'
        ? `Method: ${typeof smalltalkMethod.selector === 'string' ? smalltalkMethod.selector : ''}`
      : kind; // unavailable-reference | unauthorized-reference
  children.push({kind: 'text', role: 'heading', text: heading});

  if (kind === 'project') {
    // The Project's editable fields come from the threaded `writable` set — here
    // PROJECT FIELD NAMES (the adapter's Images-contract fact), not slot ids —
    // and each editable field's descriptor-local key is its index in that array
    // (the same array ProjectBrowser's resolver indexes). Name is the only field
    // that can be editable; Project ID and Namespace stay read-only; members
    // stay activation actions.
    const projectWritable = Array.isArray(params.writable) ? params.writable : [];
    const nameKey = projectWritable.indexOf('name');
    children.push(nameKey >= 0
      ? {kind: 'field', label: 'Name', text: valueText(project.name), key: nameKey, editable: 'text'}
      : {kind: 'field', label: 'Name', text: valueText(project.name)});
    children.push({kind: 'field', label: 'Project ID', text: valueText(project.projectId)});
    children.push({kind: 'field', label: 'Namespace', text: valueText(project.namespace)});
    const members = Array.isArray(project.members) ? project.members : [];
    if (members.length > 0) {
      children.push({
        kind: 'collection',
        label: 'Members',
        items: members.map((member, index) => {
          const key = typeof member?.key === 'string' ? member.key : String(index);
          const role = typeof member?.role === 'string' ? member.role : '';
          const imageId = typeof member?.target?.imageId === 'string' ? member.target.imageId : '';
          const targetObjectId = typeof member?.target?.objectId === 'string' ? member.target.objectId : '';
          return {
            kind: 'action',
            key: index, // transient descriptor-local index; durable identity stays member.key
            label: `${key} [${role}] -> ${imageId}/${targetObjectId}`,
          };
        }),
      });
    }
  } else if (kind === 'native-class') {
    // The authorized native Smalltalk class description (Images ADR 0087),
    // rendered as display text only. The class's own identity and its
    // superclass/class-side LOCATORS appear as text, never as refs and never as
    // action(key) rows: E1 ships no activation route for them, and an
    // affordance that routes nowhere is the defect Bead pnf records. Wiring
    // activation is Bead gzz, with E2.
    children.push({kind: 'field', label: 'Name', text: valueText(smalltalkClass.name)});
    // instance vs class side is the kernel's metaclass decision, reported as it
    // came; never inferred here from a name or an id spelling.
    children.push({kind: 'field', label: 'Side', text: valueText(smalltalkClass.side)});
    children.push({kind: 'field', label: 'Class', text: valueText(smalltalkClass.class)});
    // LAYOUT. `null` and `{instanceVariables: []}` are DIFFERENT answers and
    // must stay different documents: a Metaclass and the kernel's abstract
    // classes declare no instance layout at all, while a class declaring zero
    // instance variables has an empty one and its instances exist. An ABSENT
    // `layout` key is treated exactly like `null` (both ports state this rule
    // identically, per the CONFORMANCE NOTE above).
    const layout = smalltalkClass.layout ?? null;
    if (layout === null) {
      children.push({kind: 'field', label: 'Layout', text: '(no declared instance layout)'});
    } else {
      const instanceVariables = Array.isArray(layout.instanceVariables) ? layout.instanceVariables : [];
      children.push({kind: 'field', label: 'Instance variables', text: instanceVariables.join(', ')});
      children.push({kind: 'field', label: 'Indexed', text: valueText(layout.indexed)});
    }
    // The class's OWN canonical selector names, in Images' order. Deliberately
    // TEXT, not actions: class-read authority may show that `foo` exists, and
    // must not imply a method ref is available behind it (E2 invokes the
    // separate method seam, which authorizes the Block independently).
    const selectors = Array.isArray(smalltalkClass.selectors) ? smalltalkClass.selectors : [];
    if (selectors.length > 0) {
      children.push({
        kind: 'collection',
        label: 'Selectors',
        items: selectors.map((selector) => ({kind: 'text', text: valueText(selector)})),
      });
    }
    // Locators, in the browser-owned order. Display only: following one is a
    // fresh authorized read the consumer performs, not something this document
    // can trigger.
    const locators = Array.isArray(params.locators) ? params.locators : [];
    if (locators.length > 0) {
      children.push({
        kind: 'collection',
        label: 'Locators',
        items: locators.map((locator) => ({
          kind: 'text',
          text: `${valueText(locator?.relation)} -> ${valueText(locator?.ref?.imageId)}/${valueText(locator?.ref?.objectId)}`,
        })),
      });
    }
    // `provenance` is deliberately NOT rendered. Images owns no durable
    // native-class provenance today and truthfully answers null; an empty
    // Provenance row would imply a field that does not exist (Images jtz.1).
  } else if (kind === 'native-method') {
    // The authorized native Smalltalk METHOD description (Images ADR 0087).
    // Only what Images truthfully owns: the selector, the side, the DECLARING
    // class, and the method identity — the Block ref, which is disclosed only
    // after the Block's own authorization and is never derived here.
    children.push({kind: 'field', label: 'Selector', text: valueText(smalltalkMethod.selector)});
    children.push({kind: 'field', label: 'Side', text: valueText(smalltalkMethod.side)});
    // The class that DECLARES this method, not a receiver a send started from.
    children.push({kind: 'field', label: 'Declaring class', text: valueText(smalltalkMethod.class)});
    children.push({kind: 'field', label: 'Method', text: valueText(smalltalkMethod.method)});
    // `source` and `provenance` are truthful ABSENCES, not empty strings: Images
    // keeps no text a method was compiled from and owns no durable Cuis
    // association. An empty row would suggest a durable field exists, so the
    // rows are OMITTED entirely until Images owns something to put in them
    // (Images jtz.1). Rendering them when non-null is E3's business, not E2's.
  } else if (kind === 'unavailable-reference' || kind === 'unauthorized-reference') {
    // An explicit reason, nothing else.
    const reason = `${kind === 'unauthorized-reference' ? 'Not authorized' : 'Unavailable'}: ${objectId}${params.reason ? ` (${params.reason})` : ''}`;
    children.push({kind: 'text', role: 'reason', text: reason});
  } else {
    // Fields (slot -> display text). A slot in the host-neutral `writable` set
    // (single owner: the ImageClientAdapter's mutation field map, threaded here
    // as parameters.writable by the EnvironmentShell) is editable: it carries a
    // descriptor-local key + editable:'text'. All other slots are read-only
    // display fields (refs, the read-only count/flag scalars).
    const fields = params.fields ?? {};
    const writable = Array.isArray(params.writable) ? params.writable : [];
    let fieldKey = 0;
    for (const slot of Object.keys(fields)) {
      if (writable.includes(slot)) {
        children.push({kind: 'field', label: slot, text: valueText(fields[slot]), key: fieldKey++, editable: 'text'});
      } else {
        children.push({kind: 'field', label: slot, text: valueText(fields[slot])});
      }
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
