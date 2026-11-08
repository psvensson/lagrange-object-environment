// ADR 0015: trusted installation policy, never Session startup or user mutation.
// Images owns exact/seed admission. This owner supplies only Environment schema,
// stock identity/order and the catalog's domain check through the trusted port.
const CATALOG_ID = 'environment/catalog';
const CATALOG_SHAPE = 'environment/shapes/catalog/v1';
const ROOT_SHAPE = 'environment/shapes/root-theme/v1';
const TOKEN_SHAPE = 'environment/shapes/design-token/v1';
const THEME_ID = 'environment/themes/smalltalk-workbench/v1';
const CATALOG_FORMAT = 'environment-catalog/v1';

// Release v1 data, not a runtime fallback palette. Colors are opaque 8-bit sRGB;
// dimensions/font sizes are integer logical layout units before device scaling.
// General user token validation belongs to the future ThemeResolver, not here.
const STOCK_TOKENS = [
  ['accent', 'color', '#245a81'],
  ['focus', 'color', '#b45a16'],
  ['radius.normal', 'dimension', 0],
  ['selection.background', 'color', '#245a81'],
  ['selection.text', 'color', '#ffffff'],
  ['spacing.compact', 'dimension', 2],
  ['spacing.normal', 'dimension', 6],
  ['surface.base', 'color', '#e6e6e2'],
  ['surface.raised', 'color', '#f5f5f0'],
  ['text.muted', 'color', '#56616a'],
  ['text.primary', 'color', '#1c2428'],
  ['typography.code.family', 'fontFamily', 'monospace'],
  ['typography.code.size', 'fontSize', 13],
  ['typography.ui.family', 'fontFamily', 'sans-serif'],
  ['typography.ui.size', 'fontSize', 13],
];

function shape(id, names, indexed) {
  return {id, slots: names.map(name => ({id: name, name})), indexed};
}

function hasKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function isLocalRef(value, imageId) {
  return hasKeys(value, ['kind', 'imageId', 'objectId'])
    && value.kind === 'ref' && value.imageId === imageId
    && typeof value.objectId === 'string' && value.objectId.length > 0;
}

function validateCatalog(record, imageId) {
  const format = record?.slots?.format;
  if (record?.kind !== 'object' || record.id !== CATALOG_ID || record.imageId !== imageId
    || !isLocalRef(record.shape, imageId) || record.shape.objectId !== CATALOG_SHAPE
    || !hasKeys(record.slots, ['format', 'defaultTheme'])
    || !hasKeys(format, ['kind', 'value']) || format.kind !== 'text' || format.value !== CATALOG_FORMAT
    || !isLocalRef(record.slots.defaultTheme, imageId)
    || !Array.isArray(record.indexed) || !record.indexed.every(ref => isLocalRef(ref, imageId))) {
    throw new TypeError(`invalid EnvironmentCatalog: ${imageId}/${CATALOG_ID}`);
  }
}

function createEnvironmentProvisioner(port) {
  for (const name of ['provisionShape', 'provisionObject', 'objectRef', 'textValue', 'integerValue']) {
    if (typeof port?.[name] !== 'function') throw new TypeError(`EnvironmentProvisioner requires ${name}`);
  }
  const {provisionShape, provisionObject, objectRef, textValue, integerValue} = port;

  async function provision({imageId} = {}) {
    // Canonical constructors validate identity before any installation write.
    const catalogRef = objectRef(imageId, CATALOG_ID);
    for (const schema of [
      shape(CATALOG_SHAPE, ['format', 'defaultTheme'], 'values'),
      shape(ROOT_SHAPE, ['format', 'name'], 'values'),
      shape(TOKEN_SHAPE, ['format', 'path', 'type', 'value'], 'none'),
    ]) {
      await provisionShape({imageId, shape: schema});
    }
    const tokens = [];
    for (const [path, type, value] of [...STOCK_TOKENS].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const id = `${THEME_ID}/tokens/${path}`;
      await provisionObject({imageId, object: {
        id, shape: objectRef(imageId, TOKEN_SHAPE),
        slots: {
          format: textValue('environment-design-token/v1'), path: textValue(path), type: textValue(type),
          value: typeof value === 'number' ? integerValue(value) : textValue(value),
        },
      }});
      tokens.push(objectRef(imageId, id));
    }
    await provisionObject({imageId, object: {
      id: THEME_ID, shape: objectRef(imageId, ROOT_SHAPE),
      slots: {format: textValue('environment-theme/root/v1'), name: textValue('Smalltalk Workbench')},
      indexed: tokens,
    }});
    const catalog = await provisionObject({imageId, seed: true, object: {
      id: CATALOG_ID, shape: objectRef(imageId, CATALOG_SHAPE),
      slots: {format: textValue(CATALOG_FORMAT), defaultTheme: objectRef(imageId, THEME_ID)},
      indexed: [objectRef(imageId, THEME_ID)],
    }});
    validateCatalog(catalog, imageId);
    return Object.freeze({imageId: catalogRef.imageId, objectId: catalogRef.objectId});
  }

  return Object.freeze({provision});
}

export {createEnvironmentProvisioner};
