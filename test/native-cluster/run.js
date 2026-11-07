// Serial owned-process acceptance. Compile native artifacts BEFORE invoking.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {clusterPorts, ownedProcess} from './process-owner.js';
import {IMAGES_REVISION, LAGRANGE_REVISION} from '../../examples/native-cluster/deployment.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const [testPath, imagesCheckout] = process.argv.slice(2);
assert(testPath && imagesCheckout, 'usage: run.js <compiled-native-cluster-test> <pinned-images-checkout>');
const images = resolve(imagesCheckout);
assert.equal(execFileSync('git', ['-C', images, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), IMAGES_REVISION);
assert.equal(execFileSync('git', ['-C', images, 'status', '--porcelain', '--untracked-files=no'], {encoding: 'utf8'}).trim(), '');
const directory = await mkdtemp(join(tmpdir(), 'oe-native-cluster-'));
console.log(JSON.stringify({event: 'evidence-directory', directory}));
const credentialFile = join(directory, 'credential');
await writeFile(credentialFile, randomBytes(32).toString('hex') + '\n', {mode: 0o600});
const [restPort, adminPort, transportPort] = await clusterPorts();
const config = {credentialFile, dataDir: join(directory, 'data'), restPort, adminPort, transportPort,
  imagesRuntime: pathToFileURL(join(images, 'src/runtime.js')).href, nonce: randomBytes(8).toString('hex')};
const configFile = join(directory, 'config.json');
await writeFile(configFile, JSON.stringify(config), {mode: 0o600});
const children = [];
const start = (command, args, options) => { const child = ownedProcess(command, args, options); children.push(child); return child; };
const timeout = setTimeout(() => {
  console.error('Native cluster parent reached its 500s deadline.');
  for (const owner of children) owner.child.kill('SIGKILL');
  process.exitCode = 1;
}, 500_000);
try {
  const service = start(process.execPath, [join(repo, 'test/native-cluster/service-process.js'), configFile]);
  service.child.on('message', (message) => {
    if (message.event === 'stage' || message.event === 'failure' || message.event === 'shutdown-failure') console.log(JSON.stringify(message));
  });
  const ready = await service.until(({messages}) => messages.find((m) => m.event === 'ready' || m.event === 'failure'), 175_000, 'service bootstrap');
  await writeFile(join(directory, 'bootstrap.json'), JSON.stringify(ready, null, 2));
  assert.equal(ready.event, 'ready', `real cluster bootstrap failed at ${ready.stage}: ${ready.error}; ${ready.cause}`);
  assert.deepEqual(ready.provenance, {backend: 'lagrange', durable: true, lagrangeVersion: '0.4.0',
    lagrangeRevision: LAGRANGE_REVISION, expectedImagesRevision: IMAGES_REVISION});
  const endpoint = `http://127.0.0.1:${ready.address.port}`;
  const missing = await fetch(endpoint + '/v1/read', {method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: {'content-type': 'application/json'}, body: JSON.stringify({protocol: 'environment-image-read/v1',
      operation: 'project', imageId: 'native-cluster-demo', projectId: 'integration'})});
  assert.equal(missing.status, 401); await missing.arrayBuffer();
  const binary = join(repo, 'hosts/linux/target/debug/lagrange-host-linux');
  const cli = start(binary, ['view', '--endpoint', endpoint, '--image', 'native-cluster-demo',
    '--project', 'integration', '--credential-file', credentialFile]);
  await cli.until(({stdout}) => stdout.includes('"event":"native-viewer-ready"'), 20_000, 'actual native executable');
  assert.deepEqual(await cli.terminate(), {code: 0, signal: null});
  const oracle = join(directory, 'oracle.json');
  await writeFile(oracle, JSON.stringify(ready.baseline));
  const revoked = join(directory, 'revoked');
  const action = start(resolve(testPath), ['--ignored', '--exact', 'real_cluster_native_navigation', '--nocapture', '--test-threads=1'],
    {env: {...process.env, OE_CLUSTER_ORACLE: oracle, OE_CLUSTER_ENDPOINT: endpoint,
      OE_CLUSTER_CREDENTIAL: credentialFile, OE_CLUSTER_REVOKED: revoked}});
  await action.until(({stdout}) => stdout.includes('NATIVE_CLUSTER_REVOKE'), 80_000, 'native navigation');
  service.child.send({command: 'revoke', id: 1});
  await service.until(({messages}) => messages.find((m) => m.event === 'revoked' && m.id === 1), 5_000, 'authority revocation');
  await writeFile(revoked, 'revoked\n');
  await action.until(({exited, status}) => exited && status, 40_000, 'native revocation and teardown');
  assert.deepEqual(await action.exit, {code: 0, signal: null});
  service.child.send({command: 'snapshot', id: 2});
  const after = await service.until(({messages}) => messages.find((m) => m.event === 'snapshot' && m.id === 2), 30_000, 'independent cluster reread');
  assert.deepEqual(after.value, ready.baseline, 'native reads, refusals and revocation do not advance records/history');
  await writeFile(join(directory, 'after.json'), JSON.stringify(after.value));
  service.child.send({command: 'stop'});
  await service.until(({exited, status}) => exited && status, 12_000, 'service teardown');
  assert.deepEqual(await service.exit, {code: 0, signal: null});
  console.log(JSON.stringify({event: 'native-cluster-accepted', provenance: ready.provenance,
    verifiedImagesRevision: IMAGES_REVISION, directory}));
} finally {
  clearTimeout(timeout);
  for (const child of children.reverse()) await child.terminate();
  // The evidence directory is intentionally retained, with a private credential.
  // Do not publish the credential or config as CI artifacts.
}
