import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseDemoArguments, demoNodeProcessOptions, createDemoTopology,
  verifyDemoPrerequisites} from '../examples/native-cluster/demo-config.js';
import {IMAGES_REVISION, LAGRANGE_REVISION} from '../examples/native-cluster/deployment.js';

const PORTS = [18000, 18001, 18002, 18003, 18004, 18005, 18006, 18007, 18008];
const IDS = [
  'a0000000-0000-4000-8000-000000000000',
  'b0000000-0000-4000-8000-000000000000',
  'c0000000-0000-4000-8000-000000000000',
];
const PACKAGE = {name: 'lagrange-server', version: '0.4.0', gitHead: LAGRANGE_REVISION};

test('help needs no paths and strict arguments refuse unknown or missing inputs', () => {
  assert.deepEqual(parseDemoArguments(['--help']), {help: true});
  for (const args of [[], ['--images-checkout', '/image'], ['--unknown'], ['positional']]) {
    assert.throws(() => parseDemoArguments(args));
  }
  assert.deepEqual(parseDemoArguments(['--images-checkout', '/image', '--native-binary', '/client']),
    {help: false, imagesCheckout: '/image', nativeBinary: '/client', dataParent: null});
});

test('exactly one seed and two joiners have nine distinct listeners and three separate stores', () => {
  const nodes = createDemoTopology({runDirectory: '/fresh/demo', ports: PORTS, nodeIds: IDS});
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map(({role}) => role), ['seed', 'joiner', 'joiner']);
  assert.deepEqual(nodes.map(({configuration: c}) => c.node.id), IDS);
  assert.deepEqual(nodes.map(({configuration: c}) => c.node.seedNodeAddress),
    ['', '127.0.0.1:18000', '127.0.0.1:18000']);
  assert.deepEqual(nodes.map(({configuration: c}) => c.node.address),
    ['127.0.0.1:18000', '127.0.0.1:18003', '127.0.0.1:18006']);
  assert.deepEqual(nodes.flatMap(({configuration: c}) =>
    [c.node.restApiPort, c.admin.websocketPort, c.node.wsPort]), PORTS);
  assert.deepEqual(nodes.map(({configuration: c}) => c.storage.dataDir),
    ['/fresh/demo/node-0', '/fresh/demo/node-1', '/fresh/demo/node-2']);
  for (const {configuration: c} of nodes) {
    assert.equal(c.transport.wsHost, '127.0.0.1');
    assert.equal(c.messageGroup.replicaCount, 3);
    assert.equal(c.partition.defaultReplicaCount, 3);
    assert.deepEqual(c.worker, {maxThreads: 2, minThreads: 2});
  }
});

test('duplicate, missing, malformed or out-of-range topology identities refuse', () => {
  const valid = {runDirectory: '/fresh/demo', ports: PORTS, nodeIds: IDS};
  const sparsePorts = [...PORTS]; delete sparsePorts[4];
  const sparseIds = [...IDS]; delete sparseIds[1];
  for (const ports of [sparsePorts, PORTS.slice(1), [...PORTS, 1], [PORTS[1], ...PORTS.slice(1)],
    [0, ...PORTS.slice(1)], [65536, ...PORTS.slice(1)], ['18000', ...PORTS.slice(1)]]) {
    assert.throws(() => createDemoTopology({...valid, ports}), /Nine distinct/);
  }
  for (const nodeIds of [sparseIds, [IDS[0], IDS[0], IDS[2]], IDS.slice(1), ['bad', ...IDS.slice(1)]]) {
    assert.throws(() => createDemoTopology({...valid, nodeIds}), /Three distinct/);
  }
  assert.throws(() => createDemoTopology({...valid, runDirectory: 'relative'}), /absolute/);
});

test('child launch options exclude ambient cluster, loader, test and locale overrides', () => {
  const env = {PATH: '/bin', HOME: '/home/demo', TMPDIR: '/tmp', LANG: 'sv_SE.UTF-8',
    LC_ALL: 'sv_SE.UTF-8', LC_NUMERIC: 'sv_SE.UTF-8', NODE_OPTIONS: '--import hostile.mjs',
    NODE_PATH: '/other/packages', NODE_TEST_CONTEXT: 'child-v8', NODE_ID: 'foreign',
    SEED_NODE_ADDRESS: 'foreign:123', DATA_DIR: '/existing', LAGRANGE_BACKEND: 'mock',
    REST_API_PORT: '123', ADMIN_WS_PORT: '124', TRANSPORT_WS_PORT: '125'};
  const nodes = createDemoTopology({runDirectory: '/fresh', ports: PORTS, nodeIds: IDS});
  const options = demoNodeProcessOptions(env, nodes[0]);
  assert.deepEqual(options, {cwd: '/fresh/node-0', execArgv: [], env: {
    PATH: '/bin', HOME: '/home/demo', TMPDIR: '/tmp', LANG: 'sv_SE.UTF-8', LC_NUMERIC: 'C',
    NODE_ID: IDS[0], NODE_ADDRESS: '127.0.0.1:18000', REST_API_PORT: '18000',
    ADMIN_WS_PORT: '18001', TRANSPORT_WS_PORT: '18002', DATA_DIR: '/fresh/node-0',
  }});
  assert.equal(Object.hasOwn(options.env, 'SEED_NODE_ADDRESS'), false);
  for (const node of nodes.slice(1)) {
    const child = demoNodeProcessOptions(env, node);
    assert.equal(child.env.SEED_NODE_ADDRESS, '127.0.0.1:18000');
    assert.equal(child.env.NODE_ID, node.configuration.node.id);
    assert.equal(child.env.NODE_ADDRESS, node.configuration.node.address);
  }
  assert.equal(env.NODE_ID, 'foreign');
  assert.throws(() => demoNodeProcessOptions(env, {configuration: {storage: {dataDir: 'relative'}}}), /absolute/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oe-demo-preflight-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const imagesCheckout = join(root, 'images');
  const nativeBinary = join(root, 'native');
  const packageFile = join(root, 'package.json');
  const dataParent = join(root, 'existing');
  await mkdir(join(imagesCheckout, 'src'), {recursive: true});
  await mkdir(dataParent);
  await writeFile(join(dataParent, 'keep'), 'existing data');
  await writeFile(join(imagesCheckout, 'src/runtime.js'), '// inert fixture; never imported\n');
  await writeFile(nativeBinary, '#!/bin/sh\ntouch "$0.started"\nexit 88\n', {mode: 0o700});
  await writeFile(packageFile, JSON.stringify(PACKAGE));
  return {root, packageFile, options: {imagesCheckout, nativeBinary, dataParent},
    dependencies: {packageFile, inspectCheckout: async () => IMAGES_REVISION}};
}

test('successful preflight reads inputs without running the executable or touching existing data', async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.root);
  const result = await verifyDemoPrerequisites(f.options, f.dependencies);
  assert.equal(result.imagesRevision, IMAGES_REVISION);
  assert.equal(result.lagrangeRevision, LAGRANGE_REVISION);
  assert.equal(result.nativeBinary, f.options.nativeBinary);
  assert.equal(result.imagesRuntime, new URL('file://' + f.options.imagesCheckout + '/src/runtime.js').href);
  assert.deepEqual(await readdir(f.root), before);
  assert.deepEqual(await readdir(f.options.dataParent), ['keep']);
  assert.equal(await readFile(join(f.options.dataParent, 'keep'), 'utf8'), 'existing data');
});

test('wrong Images revision and dirty-source refusal cannot pass admission', async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyDemoPrerequisites(f.options,
    {...f.dependencies, inspectCheckout: async () => 'wrong'}), /Images checkout must/);
  const dirty = new Error('dirty checkout');
  await assert.rejects(verifyDemoPrerequisites(f.options,
    {...f.dependencies, inspectCheckout: async () => { throw dirty; }}), (error) => error === dirty);
  const git = (...args) => execFileSync('git', args, {cwd: f.options.imagesCheckout,
    env: {PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: '1'}, stdio: 'pipe'});
  git('init'); git('add', 'src/runtime.js');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  await assert.rejects(verifyDemoPrerequisites(f.options, {packageFile: f.packageFile}), /Images checkout must/);
  const nested = join(f.options.imagesCheckout, 'untracked');
  await mkdir(join(nested, 'src'), {recursive: true});
  await writeFile(join(nested, 'src/runtime.js'), '// unrelated runtime\n');
  await assert.rejects(verifyDemoPrerequisites({...f.options, imagesCheckout: nested},
    {packageFile: f.packageFile}), /must name the repository root/);
  await writeFile(join(f.options.imagesCheckout, 'src/runtime.js'), '// dirty\n');
  await assert.rejects(verifyDemoPrerequisites(f.options, {packageFile: f.packageFile}),
    (error) => error.code === 1 && error.cmd.includes('diff --quiet HEAD --'));
});

test('missing or incompatible package, missing or nonexecutable binary and bad data parent refuse', async (t) => {
  const f = await fixture(t);
  for (const pkg of [{...PACKAGE, version: '0.5.0'}, {...PACKAGE, gitHead: 'wrong'},
    {...PACKAGE, name: 'another-package'}]) {
    await writeFile(f.packageFile, JSON.stringify(pkg));
    await assert.rejects(verifyDemoPrerequisites(f.options, f.dependencies), /locked.*Lagrange package/);
  }
  await rm(f.packageFile);
  await assert.rejects(verifyDemoPrerequisites(f.options, f.dependencies), {code: 'ENOENT'});
  await writeFile(f.packageFile, JSON.stringify(PACKAGE));
  await assert.rejects(verifyDemoPrerequisites({...f.options, nativeBinary: join(f.root, 'absent')},
    f.dependencies), {code: 'ENOENT'});
  await chmod(f.options.nativeBinary, 0o600);
  await assert.rejects(verifyDemoPrerequisites(f.options, f.dependencies), {code: 'EACCES'});
  await chmod(f.options.nativeBinary, 0o700);
  await assert.rejects(verifyDemoPrerequisites({...f.options, dataParent: f.options.nativeBinary},
    f.dependencies), /existing directory/);
  assert.equal(await readFile(join(f.options.dataParent, 'keep'), 'utf8'), 'existing data');
});
