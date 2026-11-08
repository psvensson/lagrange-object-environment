import {ENVIRONMENT_LAYOUT} from './theme-layout.js';

// ThemeResolver owns the semantic vocabulary, never a fallback palette.
const TOKEN_TYPES = new Map([
  ['accent', 'color'], ['focus', 'color'], ['radius.normal', 'dimension'],
  ['selection.background', 'color'], ['selection.text', 'color'],
  ['spacing.compact', 'dimension'], ['spacing.normal', 'dimension'],
  ['surface.base', 'color'], ['surface.raised', 'color'],
  ['text.muted', 'color'], ['text.primary', 'color'],
  ['typography.code.family', 'fontFamily'], ['typography.code.size', 'fontSize'],
  ['typography.ui.family', 'fontFamily'], ['typography.ui.size', 'fontSize'],
]);

class ThemeResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThemeResolutionError';
  }
}

function requireTheme(condition, message) {
  if (!condition) throw new ThemeResolutionError(message);
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function localRef(value, imageId) {
  requireTheme(hasKeys(value, ['kind', 'imageId', 'objectId'])
    && value.kind === 'ref' && typeof value.imageId === 'string' && value.imageId.length > 0
    && value.imageId === imageId && typeof value.objectId === 'string' && value.objectId.length > 0,
  'Theme graph requires same-image unpinned refs');
  return Object.freeze({kind: 'ref', imageId: value.imageId, objectId: value.objectId});
}

function text(value) {
  requireTheme(hasKeys(value, ['kind', 'value']) && value.kind === 'text' && typeof value.value === 'string',
    'Theme field requires a text Value');
  return value.value;
}

function projection(record) {
  // The adapter discloses no Shape, kind, behavior or stored identity. Its token
  // is opaque and intentionally never interpreted or included in our output.
  requireTheme(hasKeys(record, ['slots', 'indexed', 'versionToken']) && Array.isArray(record.indexed),
    'Invalid authorized Theme read projection');
  return record;
}

function themeRecord(record, imageId) {
  const {slots, indexed} = projection(record);
  const format = text(slots?.format);
  const layout = format === ENVIRONMENT_LAYOUT.root.format ? ENVIRONMENT_LAYOUT.root
    : format === ENVIRONMENT_LAYOUT.derived.format ? ENVIRONMENT_LAYOUT.derived : null;
  requireTheme(layout && hasKeys(slots, layout.names), 'Invalid Theme format or slots');
  text(slots.name);
  const base = layout === ENVIRONMENT_LAYOUT.derived ? localRef(slots.baseTheme, imageId) : null;
  const refs = indexed.map(ref => localRef(ref, imageId));
  requireTheme(new Set(refs.map(ref => ref.objectId)).size === refs.length, 'Duplicate token ref in Theme');
  return {base, refs};
}

function scalarValue(value, type) {
  if (type === 'color') {
    const result = text(value);
    requireTheme(/^#[0-9a-f]{6}$/.test(result), 'Theme color requires lowercase opaque #rrggbb');
    return result;
  }
  if (type === 'fontFamily') {
    const result = text(value);
    requireTheme(result === 'monospace' || result === 'sans-serif', 'Unsupported Theme font family');
    return result;
  }
  requireTheme(hasKeys(value, ['kind', 'value']) && value.kind === 'integer'
    && typeof value.value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.value),
  'Theme dimension or font size requires a nonnegative canonical integer');
  const result = Number(value.value);
  requireTheme(Number.isSafeInteger(result) && (type !== 'fontSize' || result > 0),
    'Theme integer is outside its supported range');
  return result;
}

function tokenRecord(record) {
  const {slots, indexed} = projection(record);
  requireTheme(hasKeys(slots, ENVIRONMENT_LAYOUT.token.names) && indexed.length === 0,
    'Invalid DesignToken layout');
  requireTheme(text(slots.format) === ENVIRONMENT_LAYOUT.token.format, 'Invalid DesignToken format');
  const path = text(slots.path);
  const type = text(slots.type);
  requireTheme(TOKEN_TYPES.has(path) && TOKEN_TYPES.get(path) === type, 'Unknown token path or incompatible token type');
  return Object.freeze({path, type, value: scalarValue(slots.value, type)});
}

function createThemeResolver({readObject} = {}) {
  if (typeof readObject !== 'function') throw new TypeError('ThemeResolver requires an authorized readObject');

  async function resolve({themeRef, authority, blockId} = {}) {
    const selected = localRef(themeRef, themeRef?.imageId);
    const seen = new Set();
    const values = new Map();
    const read = ref => readObject({imageId: ref.imageId, objectId: ref.objectId, authority, blockId});
    let current = selected;
    while (current !== null) {
      requireTheme(!seen.has(current.objectId), 'Theme inheritance cycle');
      seen.add(current.objectId);
      const {base, refs} = themeRecord(await read(current), selected.imageId);
      const paths = new Set();
      for (const ref of refs) {
        // Even shadowed tokens must be authorized and validated. Graph edges
        // never confer authority; lower errors propagate by identity.
        const token = tokenRecord(await read(ref));
        requireTheme(!paths.has(token.path), 'Duplicate token path in Theme');
        paths.add(token.path);
        if (!values.has(token.path)) values.set(token.path, token);
      }
      current = base;
    }
    requireTheme(values.size === TOKEN_TYPES.size, 'Theme is missing required token paths');
    const tokens = Object.freeze([...values.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Object.freeze({themeRef: selected, tokens});
  }

  return Object.freeze({resolve});
}

export {createThemeResolver, ThemeResolutionError};
