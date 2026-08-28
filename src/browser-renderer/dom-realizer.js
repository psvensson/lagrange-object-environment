/**
 * The DOM realizer — a sibling Presentation realizer for the tool presentation
 * kinds (navigator / inspector / unavailable-reference / unauthorized-reference),
 * behind the BrowserRendererAdapter's kind-dispatch seam (docs/ownership.md). It
 * builds NATIVE SEMANTIC HTML (lists/buttons/focusability) from the
 * presentationDescriptor's `parameters` and mounts it under the adapter's mount
 * point. DOM nodes NEVER cross the Compositor boundary (exactly like the canvas).
 *
 * INTENT (the trust boundary): a DOM interaction emits a SEMANTIC INTENT
 * DESCRIPTOR carrying a DESCRIPTOR-LOCAL ITEM KEY — {kind:'activate-item',
 * key:<index>} — where `key` is the integer index into the CURRENT
 * presentationDescriptor's `parameters.references`. It NEVER carries a semantic
 * ref/subject (the adapter emits 'an interaction happened on this view', never
 * a subject). The ENVIRONMENT resolves key -> ref against its own Presentation
 * data before selection; a key is meaningless without the current descriptor.
 *
 * Minimal by design: <ul>/<li>/<button> for reference rows + simple field text.
 * NO widgets, Scroll, editing, or world policy.
 */

const TOOL_KINDS = Object.freeze(['navigator', 'inspector', 'unavailable-reference', 'unauthorized-reference']);

function isToolKind(kind) {
  return TOOL_KINDS.includes(kind);
}

// Render a leaf Value to short display text (fields are slot Values).
function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.value === 'string') return value.value; // text Value
    if (value.kind === 'ref' || value.kind === 'pinned-ref') return `-> ${value.objectId}`;
    if (typeof value.objectId === 'string') return `-> ${value.objectId}`;
  }
  return String(value);
}

function createDomRealizer({mountPoint, emitIntent}) {
  if (!mountPoint) {
    throw new TypeError('the DOM realizer requires a mountPoint');
  }

  // attach: build + mount the DOM for one tool presentation. Returns the
  // opaque Realization. `emitIntent(surfaceHandle, intent)` is the adapter's
  // intent fan-out (descriptor-local, never a ref).
  async function attach({surfaceHandle, presentationDescriptor}) {
    const kind = presentationDescriptor?.kind;
    const params = presentationDescriptor?.parameters ?? {};
    const subject = presentationDescriptor?.subject ?? {};

    const root = document.createElement('section');
    root.className = `lagrange-tool lagrange-tool-${kind}`;
    root.dataset.surfaceHandle = surfaceHandle;
    root.tabIndex = 0; // focusable (native a11y)

    const listeners = [];
    const listen = (el, type, fn) => {
      el.addEventListener(type, fn);
      listeners.push([el, type, fn]);
    };

    const heading = document.createElement('h3');
    heading.textContent = kind === 'navigator'
      ? `Navigator: ${subject.objectId ?? ''}`
      : kind === 'inspector'
        ? `Inspector: ${subject.objectId ?? ''}`
        : kind; // unavailable-reference | unauthorized-reference
    root.appendChild(heading);

    // unavailable/unauthorized: an explicit reason, nothing else.
    if (kind === 'unavailable-reference' || kind === 'unauthorized-reference') {
      const p = document.createElement('p');
      p.className = 'lagrange-tool-reason';
      p.textContent = `${kind === 'unauthorized-reference' ? 'Not authorized' : 'Unavailable'}: ${subject.objectId ?? ''}${params.reason ? ` (${params.reason})` : ''}`;
      root.appendChild(p);
    } else {
      // Fields (inspector shows them; navigator shows them too as context).
      const fields = params.fields ?? {};
      const keys = Object.keys(fields);
      if (keys.length > 0) {
        const dl = document.createElement('dl');
        dl.className = 'lagrange-tool-fields';
        for (const slot of keys) {
          const dt = document.createElement('dt');
          dt.textContent = slot;
          const dd = document.createElement('dd');
          dd.textContent = valueText(fields[slot]);
          dl.append(dt, dd);
        }
        root.appendChild(dl);
      }
      // References: a native list of focusable buttons. Activating row `index`
      // emits {kind:'activate-item', key:index} — a DESCRIPTOR-LOCAL key, never
      // the ref itself.
      const references = Array.isArray(params.references) ? params.references : [];
      if (references.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'lagrange-tool-references';
        references.forEach((r, index) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.itemKey = String(index); // descriptor-local key
          button.textContent = r?.objectId ?? String(index);
          listen(button, 'click', () => {
            emitIntent(surfaceHandle, Object.freeze({kind: 'activate-item', key: index}));
          });
          li.appendChild(button);
          ul.appendChild(li);
        });
        root.appendChild(ul);
      }
    }

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

export {createDomRealizer, isToolKind, TOOL_KINDS};
export default {createDomRealizer, isToolKind, TOOL_KINDS};
