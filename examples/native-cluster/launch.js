#!/usr/bin/env node
import {mkdtemp, mkdir, writeFile, unlink, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {parseDemoArguments, verifyDemoPrerequisites, createDemoTopology,
  demoNodeProcessOptions} from './demo-config.js';
import {startDemoProcess} from './demo-process.js';
import {runDemoCohort} from './demo-cohort.js';
import {verifyDemoGuardian} from './demo-guardian.js';
import {IMAGE, PROJECT} from './deployment.js';

const HELP = `Usage: npm run demo:native -- --images-checkout PATH --native-binary PATH [--data-parent PATH]

Starts three isolated local Lagrange nodes, installs a demonstration image, and
opens the native Project/inspector. Requires the locked published package,
the admitted clean Images checkout, a compiled native executable, a display,
and /usr/bin/python3 with Linux subreaper support.
Each run gets a new private directory; existing data is never replaced.
Closing the window or pressing Ctrl-C stops the owned process groups.
The current published 0.4.0 startup defect still blocks real demo acceptance.
`;

async function reservePorts() {
  const probes = [];
  try {
    for (let index = 0; index < 9; index++) {
      const probe = createServer((socket) => socket.destroy()); probes.push(probe);
      await new Promise((resolveListen, reject) => {
        probe.once('error', reject); probe.listen(0, '127.0.0.1', resolveListen);
      });
    }
    return probes.map((probe) => probe.address().port);
  } finally {
    await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))));
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDemoArguments(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (process.platform !== 'linux') throw new Error('This demo requires the native Linux host');
  const controller = new AbortController();
  let signalCode = 0, credentialFile, shutdownCeiling, primary;
  const interrupt = () => { signalCode = 130; controller.abort(new Error('Demo interrupted')); };
  const terminate = () => { signalCode = 143; controller.abort(new Error('Demo terminated')); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  const guard = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  try {
    const prerequisites = await verifyDemoPrerequisites(options); guard();
    await verifyDemoGuardian(); guard();
    const runDirectory = await mkdtemp(join(prerequisites.dataParent ?? tmpdir(), 'oe-native-demo-'));
    await chmod(runDirectory, 0o700); guard();
    process.stdout.write(`Demo data and private logs: ${runDirectory}\n`);
    const ports = await reservePorts(); guard();
    const nodes = createDemoTopology({runDirectory, ports, nodeIds: Array.from({length: 3}, () => randomUUID())});
    credentialFile = join(runDirectory, 'credential');
    await writeFile(credentialFile, randomBytes(32).toString('hex') + '\n', {flag: 'wx', mode: 0o600});
    const configs = new Map();
    for (const node of nodes) {
      const config = {node, deployment: {credentialFile, imagesRuntime: prerequisites.imagesRuntime,
        restPort: ports[0], adminPort: ports[1], transportPort: ports[2],
        dataDir: nodes[0].configuration.storage.dataDir, nonce: randomUUID()}};
      const path = join(runDirectory, `node-${node.index}.json`);
      await mkdir(node.configuration.storage.dataDir, {mode: 0o700});
      await writeFile(path, JSON.stringify(config), {flag: 'wx', mode: 0o600});
      configs.set(node.index, path);
    }
    guard();
    const provenance = {imagesRevision: prerequisites.imagesRevision,
      lagrangeVersion: prerequisites.lagrangeVersion, lagrangeRevision: prerequisites.lagrangeRevision,
      nodeIds: nodes.map((node) => node.configuration.node.id), ports};
    await writeFile(join(runDirectory, 'provenance.json'), JSON.stringify(provenance, null, 2),
      {flag: 'wx', mode: 0o600}); guard();
    await runDemoCohort({nodes, signal: controller.signal,
      onStage(stage) {
        process.stdout.write(stage + '\n');
        if (stage === 'Stopping the demo processes') {
          shutdownCeiling = setTimeout(() => {
            process.stderr.write('Demo shutdown exceeded its process ceiling.\n'); process.exit(1);
          }, 15_000);
        }
      },
      onCleanupFailure(results) {
        process.stderr.write(`Demo cleanup reported ${results.length} incomplete process(es).\n`);
      },
      startWorker(node, onFailure) {
        return startDemoProcess({file: new URL('./demo-node.js', import.meta.url),
          args: [configs.get(node.index)], worker: true, label: `node-${node.index}`,
          logFile: join(runDirectory, `node-${node.index}.log`), onFailure,
          options: demoNodeProcessOptions(process.env, node)});
      },
      startNative(endpoint, onFailure) {
        return startDemoProcess({file: prerequisites.nativeBinary,
          args: ['view', '--endpoint', endpoint, '--image', IMAGE, '--project', PROJECT,
            '--credential-file', credentialFile, '--member', 'root'],
          label: 'native-client', logFile: join(runDirectory, 'native-client.log'), onFailure,
          options: {cwd: runDirectory, env: {...process.env, LC_ALL: 'C', LC_NUMERIC: 'C'}}});
      },
    });
  } catch (error) {
    primary = error;
    if (error === controller.signal.reason) process.exitCode = signalCode;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    clearTimeout(shutdownCeiling);
    if (credentialFile) {
      try { await unlink(credentialFile); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          if (!primary) throw error;
          process.stderr.write('Private credential cleanup failed.\n');
        }
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error.message ?? error).slice(0, 1024) + '\n');
    process.exitCode ||= 1;
  });
}
