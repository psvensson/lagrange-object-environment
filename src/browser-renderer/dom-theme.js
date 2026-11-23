// Browser-only realization of an already-authorized ThemeResolver token set.
// This is transient host styling, never a second durable Theme/DesignToken store.
// The names and types below are the renderer's *input contract* for the current
// 15-token vocabulary; only ThemeResolver may decide semantics or inheritance.
const TYPES = Object.freeze({
  accent: 'color', focus: 'color', 'radius.normal': 'dimension',
  'selection.background': 'color', 'selection.text': 'color',
  'spacing.compact': 'dimension', 'spacing.normal': 'dimension',
  'surface.base': 'color', 'surface.raised': 'color',
  'text.muted': 'color', 'text.primary': 'color',
  'typography.code.family': 'fontFamily', 'typography.code.size': 'fontSize',
  'typography.ui.family': 'fontFamily', 'typography.ui.size': 'fontSize',
});

function cssVarsForResolvedTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length !== Object.keys(TYPES).length) {
    throw new TypeError('DOM Theme requires the complete 15-token resolved set');
  }
  const vars = {};
  const used = new Set();
  for (const token of tokens) {
    const path = token?.path;
    if (typeof path !== 'string' || !Object.hasOwn(TYPES, path) || used.has(path)
        || token.type !== TYPES[path] || Object.keys(token).sort().join(',') !== 'path,type,value') {
      throw new TypeError('DOM Theme has an unknown, duplicate or wrongly typed token');
    }
    used.add(path);
    const {value} = token;
    let cssValue;
    if (token.type === 'color') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) {
        throw new TypeError('DOM Theme color must be an opaque lowercase #rrggbb');
      }
      cssValue = value;
    } else if (token.type === 'fontFamily') {
      if (value !== 'monospace' && value !== 'sans-serif') {
        throw new TypeError('DOM Theme font family is not supported');
      }
      cssValue = value;
    } else {
      if (!Number.isSafeInteger(value) || value < 0 || (token.type === 'fontSize' && value === 0)) {
        throw new TypeError('DOM Theme dimension/font size must be a safe nonnegative integer');
      }
      cssValue = `${value}px`;
    }
    vars[`--lagrange-${path.replaceAll('.', '-')}`] = cssValue;
  }
  return Object.freeze(vars);
}

// Only static renderer-owned CSS is inserted; user-controlled token values
// travel through validated CSS custom properties, never stylesheet text.
// The class scopes every rule to its own pane and leaves unthemed panes alone.
const TOOL_CSS = `
.lagrange-tool-themed {
  background-color: var(--lagrange-surface-base);
  color: var(--lagrange-text-primary);
  font-family: var(--lagrange-typography-ui-family);
  font-size: var(--lagrange-typography-ui-size);
  padding: var(--lagrange-spacing-normal);
  border-radius: var(--lagrange-radius-normal);
}
.lagrange-tool-themed h3 { color: var(--lagrange-accent); }
.lagrange-tool-themed .lagrange-tool-reason,
.lagrange-tool-themed .lagrange-tool-fields dt { color: var(--lagrange-text-muted); }
.lagrange-tool-themed .lagrange-tool-fields dd { margin-left: var(--lagrange-spacing-compact); }
.lagrange-tool-themed :is(button, input, textarea) {
  background-color: var(--lagrange-surface-raised);
  color: var(--lagrange-text-primary);
  font-family: var(--lagrange-typography-ui-family);
  font-size: var(--lagrange-typography-ui-size);
  border-radius: var(--lagrange-radius-normal);
  padding: var(--lagrange-spacing-compact);
}
.lagrange-tool-themed button { color: var(--lagrange-accent); }
.lagrange-tool-themed :is(button, input, textarea):focus-visible {
  outline: 2px solid var(--lagrange-focus);
  outline-offset: var(--lagrange-spacing-compact);
}
.lagrange-tool-themed .lagrange-tool-source {
  font-family: var(--lagrange-typography-code-family);
  font-size: var(--lagrange-typography-code-size);
  background-color: var(--lagrange-surface-raised);
  padding: var(--lagrange-spacing-compact);
  white-space: pre-wrap;
}
.lagrange-tool-themed ::selection {
  background-color: var(--lagrange-selection-background);
  color: var(--lagrange-selection-text);
}`;

// The CSS property set is closed by the resolved-token contract; clearing a
// Theme can remove only what we installed, leaving unrelated host CSS intact.
const THEME_CSS_VARIABLES = Object.freeze(
  Object.keys(TYPES).map(path => '--lagrange-' + path.replaceAll('.', '-')),
);

function applyResolvedTokensToDom(root, vars) {
  let style = root.querySelector(':scope > style[data-lagrange-theme]');
  if (vars === null) {
    root.classList.remove('lagrange-tool-themed');
    for (const name of THEME_CSS_VARIABLES) root.style.removeProperty(name);
    style?.remove();
    return root; // unthemed, NOT a stock-palette fallback
  }
  root.classList.add('lagrange-tool-themed');
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  if (!style) {
    style = document.createElement('style');
    style.dataset.lagrangeTheme = '';
    style.textContent = TOOL_CSS; // static host-owned CSS, never user text
    root.prepend(style);
  }
  return root;
}

export {cssVarsForResolvedTokens, applyResolvedTokensToDom};
