// Versioned data layout, delegated by EnvironmentProvisioner. No read, write,
// authorization or token-resolution policy lives in this module.
function layout(id, format, names, indexed) {
  return Object.freeze({id, format, names: Object.freeze(names), indexed});
}

const ENVIRONMENT_LAYOUT = Object.freeze({
  catalog: layout('environment/shapes/catalog/v1', 'environment-catalog/v1', ['format', 'defaultTheme'], 'values'),
  root: layout('environment/shapes/root-theme/v1', 'environment-theme/root/v1', ['format', 'name'], 'values'),
  token: layout('environment/shapes/design-token/v1', 'environment-design-token/v1', ['format', 'path', 'type', 'value'], 'none'),
  derived: layout('environment/shapes/derived-theme/v1', 'environment-theme/derived/v1', ['format', 'name', 'baseTheme'], 'values'),
});

export {ENVIRONMENT_LAYOUT};
