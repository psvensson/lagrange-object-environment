/**
 * The DOM realizer — the BROWSER realization of the host-neutral SemanticUi/v1
 * contract (src/semantic-ui.js), for the tool presentation kinds (navigator /
 * inspector / project / unavailable-reference / unauthorized-reference), behind the
 * BrowserRendererAdapter's kind-dispatch seam (docs/ownership.md).
 *
 * This realizer does NOT interpret a presentationDescriptor's parameters and
 * does NOT own Value->display-text: it projects the descriptor to a SemanticUi
 * document via `semanticUiForPresentation` (inside this attach path — the
 * adapter/Compositor boundary is unchanged and SemanticUi stays transient,
 * never entering durableIntent) and renders THAT description as NATIVE SEMANTIC
 * HTML. The same SemanticUi document drives the Linux GTK realizer — one
 * description, two consumers (ADR 0013). DOM nodes NEVER cross the Compositor
 * boundary (exactly like the canvas).
 *
 * INTENT (the trust boundary): an `action(key)` node renders a native
 * <button>; activating it emits a SEMANTIC INTENT DESCRIPTOR carrying the
 * DESCRIPTOR-LOCAL ITEM KEY — {kind:'activate-item', key} — NEVER a semantic
 * ref/subject. The ENVIRONMENT resolves key -> ref (EnvironmentShell).
 *
 * EDITING (minimal): an editable `field` (key + editable:'text') renders a
 * native <input>; committing (Enter/activate ONLY — no blur commit in this
 * slice) emits a RAW-STRING intent {kind:'edit-field', key, text} carrying the
 * descriptor-local field key and the unparsed text. The ENVIRONMENT resolves
 * key -> slot and owns all validation/authority (EnvironmentShell +
 * CommandRouter). This realizer never parses, never dispatches, never holds a
 * ref/subject.
 *
 * Minimal by design: NO widgets, Scroll, or world policy.
 */

import {semanticUiForPresentation} from '../semantic-ui.js';

// The presentation kinds this realizer claims as SEMANTIC TOOL UI (as opposed to
// a Component/graphics surface). The native Smalltalk kinds join here in E2,
// when a real Compositor attach actually presents them; E1 deliberately kept
// them out while nothing produced a live view.
//
// This list is mirrored by hosts/linux/src/linux_adapter.rs and the two are
// pinned equal by a parity test: a kind admitted here but not there would be
// realized as a tool in the browser and sent down the Component route natively —
// the same bytes producing two different realizations.
const TOOL_KINDS = Object.freeze([
  'navigator', 'inspector', 'project', 'native-class', 'native-method',
  'unavailable-reference', 'unauthorized-reference',
]);

function isToolKind(kind) {
  return TOOL_KINDS.includes(kind);
}

// Render a SemanticUi NODE to a DOM element/fragment. Pure description ->
// element; no presentation-parameter interpretation here.
function renderNode(node, listen, onAction, onEdit) {
  switch (node.kind) {
    case 'text': {
      const el = document.createElement(node.role === 'heading' ? 'h3' : 'p');
      if (node.role === 'reason') el.className = 'lagrange-tool-reason';
      el.textContent = node.text;
      return el;
    }
    case 'field': {
      const fragment = document.createDocumentFragment();
      const dt = document.createElement('dt');
      dt.textContent = node.label;
      const dd = document.createElement('dd');
      if (node.editable === 'text') {
        // Editable: a native <input> committing on Enter/activate ONLY (no blur
        // commit in this slice), emitting a RAW-STRING intent with the
        // descriptor-local field key. Never a parsed value.
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'lagrange-tool-field-input';
        input.value = node.text;
        input.dataset.fieldKey = String(node.key); // descriptor-local key
        listen(input, 'keydown', (event) => {
          if (event.key === 'Enter') onEdit(node.key, input.value);
        });
        dd.appendChild(input);
      } else {
        dd.textContent = node.text;
      }
      fragment.append(dt, dd);
      return fragment;
    }
    case 'collection': {
      const ul = document.createElement('ul');
      ul.className = 'lagrange-tool-references';
      for (const item of node.items) {
        // Dispatch on the ITEM's own kind. A collection of `action` items is a
        // list of activatable rows; a collection of `text` items is a list of
        // DISPLAY rows and must render as text, NOT as a button that emits an
        // intent nothing routes (the dead affordance of Bead pnf). The
        // vocabulary allows any node kind in `items`, so the realizer dispatches
        // rather than assuming.
        //
        // `action` stays handled HERE rather than as a top-level renderNode
        // case, so a BARE action outside a collection keeps throwing exactly as
        // it did before — the GTK realizer deliberately renders nothing for one
        // (semantic_gtk.rs `Node::Action` arm), and giving the DOM a top-level
        // action case would create a new cross-host divergence for an input no
        // projector emits.
        const li = document.createElement('li');
        if (item.kind === 'action') {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.itemKey = String(item.key); // descriptor-local key
          button.textContent = item.label;
          listen(button, 'click', () => onAction(item.key));
          li.appendChild(button);
        } else {
          li.appendChild(renderNode(item, listen, onAction, onEdit));
        }
        ul.appendChild(li);
      }
      return ul;
    }
    default:
      throw new TypeError(`the DOM realizer cannot render SemanticUi node kind ${JSON.stringify(node.kind)}`);
  }
}

// Render a SemanticUi/v1 DOCUMENT to a DOM <section>. Separated from the
// descriptor-projection so a host/test can drive the SAME rendering path from
// a checked-in fixture — the cross-host identity mechanism: the browser
// consumes exactly the bytes the GTK realizer consumes.
function renderSemanticUiToDom({doc, kind, surfaceHandle, listen, onAction, onEdit}) {
  const root = document.createElement('section');
  root.className = `lagrange-tool lagrange-tool-${kind}`;
  root.dataset.surfaceHandle = surfaceHandle;
  root.tabIndex = 0; // focusable (native a11y)

  // Fields are grouped in a <dl>; other nodes append directly, preserving the
  // document order (heading first, fields, then the references collection).
  let fieldsList = null;
  const flushFields = () => {
    if (fieldsList && fieldsList.childNodes.length > 0) {
      const dl = document.createElement('dl');
      dl.className = 'lagrange-tool-fields';
      dl.append(...fieldsList.childNodes);
      root.appendChild(dl);
    }
    fieldsList = null;
  };
  for (const child of doc.root.children) {
    if (child.kind === 'field') {
      if (!fieldsList) fieldsList = document.createDocumentFragment();
      fieldsList.appendChild(renderNode(child, listen, onAction, onEdit));
    } else {
      flushFields();
      root.appendChild(renderNode(child, listen, onAction, onEdit));
    }
  }
  flushFields();
  return root;
}

function createDomRealizer({mountPoint, emitIntent}) {
  if (!mountPoint) {
    throw new TypeError('the DOM realizer requires a mountPoint');
  }

  // attach: project -> render -> mount. Returns the opaque Realization.
  async function attach({surfaceHandle, presentationDescriptor}) {
    const kind = presentationDescriptor?.kind;
    // Project the descriptor to the host-neutral SemanticUi/v1 document (the
    // contract owner validates it). This realizer only renders the result.
    const doc = semanticUiForPresentation(presentationDescriptor);

    const listeners = [];
    const listen = (el, type, fn) => {
      el.addEventListener(type, fn);
      listeners.push([el, type, fn]);
    };
    const onAction = (key) => {
      emitIntent(surfaceHandle, Object.freeze({kind: 'activate-item', key}));
    };
    // RAW-STRING edit intent: {kind:'edit-field', key, text}. The text is the
    // unparsed input value (text is the only editable scalar; parsing/validation
    // is owned by the ENVIRONMENT, never here).
    const onEdit = (key, text) => {
      emitIntent(surfaceHandle, Object.freeze({kind: 'edit-field', key, text}));
    };

    const root = renderSemanticUiToDom({doc, kind, surfaceHandle, listen, onAction, onEdit});

    let mounted = false;
    return {
      kind: 'dom',
      start() {
        if (!mounted) {
          mountPoint.appendChild(root);
          mounted = true;
        }
      },
      stop() {
        // DOM panes have no frame loop; stop is a no-op (dispose removes the node).
      },
      resize() {
        // CSS-driven; a no-op here (native layout).
      },
      async readPixels() {
        return null; // DOM panes are not GPU-readable.
      },
      dispose() {
        for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
        if (root.parentNode) root.parentNode.removeChild(root);
        mounted = false;
      },
      isRunning: () => mounted,
      // Host-inspection handle for tests (never crosses the Compositor boundary).
      _root: root,
    };
  }

  return {attach};
}

export {createDomRealizer, renderSemanticUiToDom, isToolKind, TOOL_KINDS};
export default {createDomRealizer, renderSemanticUiToDom, isToolKind, TOOL_KINDS};
