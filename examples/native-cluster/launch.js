#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, unlink, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {performance} from 'node:perf_hooks';
import {parseDemoArguments, verifyDemoPrerequisites, createDemoTopology,
  demoNodeProcessOptions} from './demo-config.js';
import {startDemoProcess} from './demo-process.js';
import {runDemoCohort} from './demo-cohort.js';
import {probeDemoReadiness} from './demo-readiness.js';
import {verifyDemoGuardian} from './demo-guardian.js';
import {IMAGE, PROJECT} from './deployment.js';

const HELP = `Usage: npm run demo:native -- --images-checkout PATH --native-binary PATH [--data-parent PATH]
       [--lagrange-checkout PATH --host-id NAME]

Starts three isolated local Lagrange processes, installs a demonstration image,
and opens the native Project/inspector. Requires the admitted clean Images
checkout, a compiled native executable, a display, and /usr/bin/python3 with
Linux subreaper support. Explicit --lagrange-checkout selects the pinned source
revision on one actual host; otherwise the locked published package is used.
Each run gets a new private directory; existing data is never replaced.
Closing the window or pressing Ctrl-C stops the owned process groups.
The current published 0.4.0 startup defect still blocks package acceptance.
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

function defaultNativeClient({endpoint, onFailure, nativeBinary, credentialFile, runDirectory}) {
  return startDemoProcess({file: nativeBinary,
    args: ['view', '--endpoint', endpoint, '--image', IMAGE, '--project', PROJECT,
      '--credential-file', credentialFile, '--member', 'root'],
    label: 'native-client', logFile: join(runDirectory, 'native-client.log'), onFailure,
    options: {cwd: runDirectory, env: {...process.env, LC_ALL: 'C', LC_NUMERIC: 'C'}}});
}

// The interactive demo and source acceptance share this one allocation/cohort
// owner. An injected client receives only the existing process-owner contract
// and the two private seed controls; no worker or raw runtime escapes.
export async function runNativeDemoSession(options, {signal = new AbortController().signal,
  createNativeClient = defaultNativeClient, onStage = (stage) => process.stdout.write(stage + '\n'),
  acceptanceDeadline} = {}) {
  if (process.platform !== 'linux') throw new Error('This demo requires the native Linux host');
  const started = performance.now();
  let credentialFile, shutdownCeiling, primary, runDirectory, provenance, selection;
  const guard = () => {
    if (signal.aborted) throw signal.reason ?? new Error('Demo interrupted');
    if (acceptanceDeadline !== undefined && performance.now() >= acceptanceDeadline - 15_000) {
      throw new Error('Native acceptance semantic deadline');
    }
  };
  try {
    guard();
    const prerequisites = await verifyDemoPrerequisites(options); guard();
    selection = prerequisites.selection;
    onStage('Runtime prerequisites admitted', {selection}); guard();
    await verifyDemoGuardian(); guard();
    runDirectory = await mkdtemp(join(prerequisites.dataParent ?? tmpdir(), 'oe-native-demo-'));
    await chmod(runDirectory, 0o700); guard();
    onStage('Allocated private demo session', {runDirectory, selection}); guard();
    process.stdout.write(`Demo data and private logs: ${runDirectory}\n`);
    const evidenceDirectory = join(runDirectory, 'evidence');
    await mkdir(evidenceDirectory, {mode: 0o700}); guard();
    const ports = await reservePorts(); guard();
    const nodes = createDemoTopology({runDirectory, ports, selection, hostId: prerequisites.hostId,
      nodeIds: Array.from({length: 3}, () => randomUUID())});
    credentialFile = join(runDirectory, 'credential');
    await writeFile(credentialFile, randomBytes(32).toString('hex') + '\n', {flag: 'wx', mode: 0o600});
    const configs = new Map();
    for (const node of nodes) {
      guard();
      const config = {node, selection, evidenceDirectory,
        deployment: {selection, credentialFile, imagesRuntime: prerequisites.imagesRuntime,
          restPort: ports[0], adminPort: ports[1], transportPort: ports[2],
          dataDir: nodes[0].configuration.storage.dataDir, nonce: randomUUID()}};
      const path = join(runDirectory, `node-${node.index}.json`);
      await mkdir(node.configuration.storage.dataDir, {mode: 0o700}); guard();
      await writeFile(path, JSON.stringify(config), {flag: 'wx', mode: 0o600}); guard();
      configs.set(node.index, path);
    }
    provenance = {runtimeSelection: selection, imagesRevision: prerequisites.imagesRevision,
      lagrangeVersion: prerequisites.lagrangeVersion, lagrangeRevision: prerequisites.lagrangeRevision,
      nodeIds: nodes.map((node) => node.configuration.node.id), ports,
      topology: {processCount: 3, configuredReplicationFactor: 3,
        ...(selection.kind === 'source-development' ? {hostCount: 1, hostId: prerequisites.hostId} : {})},
      phases: []};
    await writeFile(join(runDirectory, 'provenance.json'), JSON.stringify(provenance, null, 2),
      {flag: 'wx', mode: 0o600}); guard();
    onStage('Prepared native demo cohort', {runDirectory, selection, provenance}); guard();
    let seedOwner;
    const seedControl = Object.freeze({
      snapshot(deadline) {
        if (!seedOwner) throw new Error('The seed owner has not been acquired');
        return seedOwner.request('snapshot', deadline);
      },
      revoke(deadline) {
        if (!seedOwner) throw new Error('The seed owner has not been acquired');
        return seedOwner.request('revoke', deadline);
      },
    });
    await runDemoCohort({nodes, signal,
      ...(selection.kind === 'source-development' ? {probeReadiness: probeDemoReadiness} : {}),
      onStage(stage, details) {
        provenance.phases.push({stage, elapsedMs: Math.round(performance.now() - started)});
        if (stage === 'Stopping the demo processes') {
          provenance.startupObservation = details.startupObservation;
          const allowance = acceptanceDeadline === undefined ? 15_000
            : Math.min(15_000, Math.max(0, acceptanceDeadline - performance.now()));
          shutdownCeiling = setTimeout(() => {
            process.stderr.write('Demo shutdown exceeded its process ceiling.\n'); process.exit(1);
          }, allowance);
        }
        onStage(stage, {runDirectory, selection, provenance});
      },
      onCleanupFailure(results) {
        process.stderr.write(`Demo cleanup reported ${results.length} incomplete process(es).\n`);
      },
      startWorker(node, onFailure) {
        const owner = startDemoProcess({file: new URL('./demo-node.js', import.meta.url),
          args: [configs.get(node.index)], worker: true, label: `node-${node.index}`,
          logFile: join(runDirectory, `node-${node.index}.log`), onFailure,
          options: demoNodeProcessOptions(process.env, node)});
        if (node.role === 'seed') seedOwner = owner;
        return owner;
      },
      startNative(endpoint, onFailure) {
        return createNativeClient({endpoint, onFailure, nativeBinary: prerequisites.nativeBinary,
          credentialFile, runDirectory, selection, seedControl});
      },
    });
    guard();
    if (selection.kind === 'source-development') {
      // A successful exact-source receipt must still describe the admitted
      // checkouts after the complete journey, including concurrent changes.
      onStage('Rechecking admitted source identities', {runDirectory, selection, provenance}); guard();
      const after = await verifyDemoPrerequisites(options); guard();
      assert.deepEqual(after.selection, selection, 'Runtime selection changed during the native session');
      assert.equal(after.imagesRevision, prerequisites.imagesRevision, 'Images identity changed during the native session');
    }
  } catch (error) { primary = error; }
  finally {
    if (credentialFile) {
      try { await unlink(credentialFile); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          primary = primary ? new AggregateError([primary, error],
            'Native demo failed and private credential cleanup was incomplete', {cause: primary}) : error;
        }
      }
    }
    if (provenance) {
      provenance.durationMs = Math.round(performance.now() - started);
      provenance.outcome = primary ? 'failed' : 'closed';
      if (primary) provenance.failure = {name: String(primary.name ?? 'Error').slice(0, 96),
        code: String(primary.code ?? '').slice(0, 96)};
      try {
        await writeFile(join(runDirectory, 'provenance.json'), JSON.stringify(provenance, null, 2), {mode: 0o600});
      } catch (error) { primary ??= error; }
    }
    clearTimeout(shutdownCeiling);
  }
  if (primary) throw primary;
  return {runDirectory, provenance, selection};
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDemoArguments(args);
  if (options.help) { process.stdout.write(HELP); return; }
  const controller = new AbortController();
  let signalCode = 0;
  const interrupt = () => { signalCode = 130; controller.abort(new Error('Demo interrupted')); };
  const terminate = () => { signalCode = 143; controller.abort(new Error('Demo terminated')); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try { await runNativeDemoSession(options, {signal: controller.signal}); }
  catch (error) {
    if (controller.signal.aborted) process.exitCode = signalCode;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error.message ?? error).slice(0, 1024) + '\n');
    process.exitCode ||= 1;
  });
}
