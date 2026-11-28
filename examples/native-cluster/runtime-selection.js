// Read-only runtime admission. Importing this owner resolves no package and
// starts no runtime; each consumer receives the same explicit public entry.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const execute = promisify(execFile);
const PACKAGE_NAME = 'lagrange-server';
const PUBLIC_ENTRY = 'src/public-api.js';
const SOURCE_INPUTS = ['src', 'package.json', 'package-lock.json', 'wit', 'vendor/raft-rs-wasm'];

export const PUBLISHED_PACKAGE = Object.freeze({
  kind: 'published-package', version: '0.4.0',
  revision: '07206ba1c8bb396f4eb097a753915bb34580d824',
  imagesRevision: 'caf72f26d6a28a6901aea876a49d22311e29cf21',
  package: PACKAGE_NAME,
});

export const SOURCE_DEVELOPMENT = Object.freeze({
  kind: 'source-development', version: '0.4.2',
  revision: 'ab347e9625a64ed24b7700b8f958bd54d8e3db06',
  imagesRevision: 'dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7',
  repository: 'psvensson/lagrange',
});

// Private JSON configuration crosses a process boundary. Validate its identity
// here without repeating admission or resolving another ambient entry point.
export function validateRuntimeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('An admitted runtime selection is required');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  const identity = fields.kind?.value === SOURCE_DEVELOPMENT.kind ? SOURCE_DEVELOPMENT
    : fields.kind?.value === PUBLISHED_PACKAGE.kind ? PUBLISHED_PACKAGE : null;
  if (!identity || Reflect.ownKeys(value).length !== Object.keys(identity).length + 1 ||
    Object.entries(identity).some(([key, expected]) =>
      fields[key]?.value !== expected || fields[key]?.enumerable !== true) ||
    !Object.hasOwn(fields.specifier ?? {}, 'value') || fields.specifier.enumerable !== true) {
    throw new TypeError('Runtime selection does not match an admitted identity');
  }
  const specifier = fields.specifier.value;
  if (typeof specifier !== 'string' || specifier.length > 8192) {
    throw new TypeError('Runtime selection requires its public file specifier');
  }
  let entry;
  try {
    const url = new URL(specifier);
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) throw new Error();
    entry = fileURLToPath(url);
    if (pathToFileURL(entry).href !== specifier) throw new Error();
  } catch {
    throw new TypeError('Runtime selection requires its public file specifier');
  }
  if (join(dirname(dirname(entry)), PUBLIC_ENTRY) !== entry) {
    throw new TypeError('Runtime selection must name the public Lagrange entry');
  }
  return Object.freeze({...identity, specifier});
}

async function requireFile(path, label) {
  if (!(await lstat(path)).isFile() || await realpath(path) !== path) {
    throw new TypeError(`${label} must be a regular file inside the admitted checkout`);
  }
}

function requirePublicManifest(manifest, expectedVersion) {
  if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion ||
    manifest.type !== 'module' || manifest.main !== PUBLIC_ENTRY ||
    manifest.exports?.['.'] !== './' + PUBLIC_ENTRY) {
    throw new Error('The admitted Lagrange manifest must expose src/public-api.js');
  }
}

async function admitSource(directory, executeGit) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('--lagrange-checkout must name the source repository root');
  }
  const root = await realpath(directory);
  const options = {cwd: root, timeout: 5000, maxBuffer: 64 * 1024,
    env: {PATH: process.env.PATH, LC_ALL: 'C'}};
  const git = (args) => executeGit('git', args, options);
  const top = await git(['rev-parse', '--show-toplevel']);
  if (await realpath(top.stdout.trim()) !== root) {
    throw new Error('Lagrange checkout must name the repository root');
  }
  const head = await git(['rev-parse', 'HEAD']);
  if (head.stdout.trim() !== SOURCE_DEVELOPMENT.revision) {
    throw new Error(`Lagrange checkout must be ${SOURCE_DEVELOPMENT.revision}`);
  }
  // Compare both boundaries. A staged change followed by restoring the file
  // to HEAD is still a dirty index even though `git diff HEAD` is empty.
  await git(['diff', '--quiet', '--cached', '--ignore-submodules=none', 'HEAD', '--']);
  await git(['diff', '--quiet', '--ignore-submodules=none', '--']);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--',
    '.', ':(top,exclude)node_modules']);
  // Ignored files under runtime source paths still change admitted source.
  // Root node_modules is dependency material installed from the tracked lock.
  const sourceAdditions = await git(['ls-files', '--others', '-z', '--', ...SOURCE_INPUTS]);
  if (untracked.stdout.length || sourceAdditions.stdout.length) {
    throw new Error('Lagrange checkout contains untracked source files');
  }
  await git(['ls-files', '--error-unmatch', '--', 'package.json', 'package-lock.json', PUBLIC_ENTRY]);
  const manifestPath = join(root, 'package.json');
  const entry = join(root, PUBLIC_ENTRY);
  await requireFile(manifestPath, 'Lagrange manifest');
  await requireFile(join(root, 'package-lock.json'), 'Lagrange lock');
  await requireFile(entry, 'Public Lagrange entry');
  requirePublicManifest(JSON.parse(await readFile(manifestPath, 'utf8')), SOURCE_DEVELOPMENT.version);
  return validateRuntimeSelection({...SOURCE_DEVELOPMENT, specifier: pathToFileURL(entry).href});
}

export async function admitRuntimeSelection(options = {}, {
  packageFile,
  resolvePackage = (specifier) => import.meta.resolve(specifier),
  executeGit = execute,
} = {}) {
  if (options.lagrangeCheckout !== undefined) {
    return admitSource(options.lagrangeCheckout, executeGit);
  }
  // Package resolution is deliberately inside this branch. A missing or bad
  // published package is a failure, never a request to search for source.
  const manifestPath = await realpath(packageFile ??
    new URL(resolvePackage(PACKAGE_NAME + '/package.json')));
  await requireFile(manifestPath, 'Published Lagrange manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PUBLISHED_PACKAGE.version ||
    manifest.gitHead !== PUBLISHED_PACKAGE.revision) {
    throw new Error('Install the locked native-cluster Lagrange package before launching');
  }
  requirePublicManifest(manifest, PUBLISHED_PACKAGE.version);
  const entry = join(dirname(manifestPath), PUBLIC_ENTRY);
  await requireFile(entry, 'Public Lagrange entry');
  return validateRuntimeSelection({...PUBLISHED_PACKAGE, specifier: pathToFileURL(entry).href});
}
