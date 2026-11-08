// Pure configuration and read-only admission for the local native demo.
// Process acquisition belongs to the launcher; importing this module starts nothing.
import {parseArgs, promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {access, readFile, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {IMAGES_REVISION, LAGRANGE_REVISION} from './deployment.js';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHILD_ENVIRONMENT = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LD_LIBRARY_PATH'];

export function parseDemoArguments(args) {
  const {values} = parseArgs({args, options: {
    help: {type: 'boolean', short: 'h'},
    'images-checkout': {type: 'string'},
    'native-binary': {type: 'string'},
    'data-parent': {type: 'string'},
  }});
  if (values.help) return Object.freeze({help: true});
  if (!values['images-checkout'] || !values['native-binary']) {
    throw new TypeError('--images-checkout and --native-binary are required');
  }
  return Object.freeze({help: false,
    imagesCheckout: resolve(values['images-checkout']),
    nativeBinary: resolve(values['native-binary']),
    dataParent: values['data-parent'] ? resolve(values['data-parent']) : null});
}

export function demoNodeProcessOptions(environment, {configuration}) {
  const cwd = configuration.storage.dataDir;
  if (!isAbsolute(cwd)) throw new TypeError('A fresh absolute node directory is required');
  const env = {};
  for (const key of CHILD_ENVIRONMENT) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  // LC_ALL takes precedence over LC_NUMERIC; deliberately do not inherit it.
  env.LC_NUMERIC = 'C';
  // The pinned embedded runtime selects join mode from the environment, not
  // configuration.node.seedNodeAddress. These are launcher-owned values.
  env.NODE_ID = configuration.node.id;
  env.NODE_ADDRESS = configuration.node.address;
  env.REST_API_PORT = String(configuration.node.restApiPort);
  env.ADMIN_WS_PORT = String(configuration.admin.websocketPort);
  env.TRANSPORT_WS_PORT = String(configuration.node.wsPort);
  env.DATA_DIR = cwd;
  if (configuration.node.seedNodeAddress) env.SEED_NODE_ADDRESS = configuration.node.seedNodeAddress;
  return {cwd, env, execArgv: []};
}

export function createDemoTopology({runDirectory, ports, nodeIds}) {
  if (!isAbsolute(runDirectory)) throw new TypeError('An absolute fresh run directory is required');
  if (!Array.isArray(ports) || ports.length !== 9 || new Set(ports).size !== 9 ||
    !Array.from(ports).every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new TypeError('Nine distinct nonzero listener ports are required');
  }
  if (!Array.isArray(nodeIds) || nodeIds.length !== 3 || new Set(nodeIds).size !== 3 ||
    !Array.from(nodeIds).every((id) => typeof id === 'string' && UUID.test(id))) {
    throw new TypeError('Three distinct node UUIDs are required');
  }
  const seedAddress = `127.0.0.1:${ports[0]}`;
  return nodeIds.map((id, index) => ({
    index, role: index === 0 ? 'seed' : 'joiner',
    configuration: {
      logging: {level: 'error', prettyPrint: false},
      node: {id, address: `127.0.0.1:${ports[index * 3]}`,
        restApiPort: ports[index * 3], wsPort: ports[index * 3 + 2],
        seedNodeAddress: index === 0 ? '' : seedAddress},
      admin: {websocketPort: ports[index * 3 + 1]},
      transport: {wsHost: '127.0.0.1'},
      messageGroup: {replicaCount: 3}, partition: {defaultReplicaCount: 3},
      storage: {dataDir: join(runDirectory, `node-${index}`)},
      worker: {maxThreads: 2, minThreads: 2},
    },
  }));
}

async function inspectImagesCheckout(directory) {
  const options = {cwd: directory, timeout: 5000, maxBuffer: 64 * 1024,
    env: {PATH: process.env.PATH, LC_ALL: 'C'}};
  const top = await execute('git', ['rev-parse', '--show-toplevel'], options);
  if (await realpath(top.stdout.trim()) !== directory) {
    throw new Error('Images checkout must name the repository root');
  }
  const {stdout} = await execute('git', ['rev-parse', 'HEAD'], options);
  // Untracked user files are not altered or included in the admitted source.
  await execute('git', ['diff', '--quiet', 'HEAD', '--'], options);
  return stdout.trim();
}

export async function verifyDemoPrerequisites(options, {
  packageFile,
  inspectCheckout = inspectImagesCheckout,
} = {}) {
  const imagesCheckout = await realpath(options.imagesCheckout);
  const nativeBinary = await realpath(options.nativeBinary);
  const imageRevision = await inspectCheckout(imagesCheckout);
  if (imageRevision !== IMAGES_REVISION) throw new Error(`Images checkout must be ${IMAGES_REVISION}`);
  const imagesRuntimePath = join(imagesCheckout, 'src/runtime.js');
  if (!(await stat(imagesRuntimePath)).isFile()) throw new Error('Public Images runtime is unavailable');
  if (!(await stat(nativeBinary)).isFile()) throw new Error('Native binary must be a regular file');
  await access(nativeBinary, constants.X_OK);
  const pkg = JSON.parse(await readFile(packageFile ??
    new URL(import.meta.resolve('lagrange-server/package.json')), 'utf8'));
  if (pkg.name !== 'lagrange-server' || pkg.version !== '0.4.0' || pkg.gitHead !== LAGRANGE_REVISION) {
    throw new Error('Install the locked native-cluster Lagrange package before launching');
  }
  if (options.dataParent && !(await stat(options.dataParent)).isDirectory()) {
    throw new Error('Data parent must be an existing directory');
  }
  return Object.freeze({imagesCheckout, imagesRuntime: pathToFileURL(imagesRuntimePath).href,
    nativeBinary, dataParent: options.dataParent, imagesRevision: imageRevision,
    lagrangeVersion: pkg.version, lagrangeRevision: pkg.gitHead});
}
