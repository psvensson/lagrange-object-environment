// Source-development acceptance uses the same launcher and cohort as the demo.
// Compile both native artifacts before invoking this file.
import assert from 'node:assert/strict';
import {access, realpath, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseDemoArguments} from '../../examples/native-cluster/demo-config.js';
import {runNativeDemoSession} from '../../examples/native-cluster/launch.js';
import {createNativeAcceptance} from './native-acceptance.js';
import {exportSourceEvidence, finalizeSourceEvidence, sourceFailureRecords} from './source-evidence.js';

export async function main(args = process.argv.slice(2)) {
  const [testPath, ...demoArgs] = args;
  assert(testPath && !testPath.startsWith('--'),
    'usage: run-source.js <compiled-native-cluster-test> --lagrange-checkout PATH --host-id NAME --images-checkout PATH --native-binary PATH');
  const options = parseDemoArguments(demoArgs);
  assert(options.lagrangeCheckout && !options.help, 'Source acceptance requires --lagrange-checkout');
  const started = performance.now();
  const deadline = started + 500_000;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Source acceptance interrupted'));
  const terminate = () => controller.abort(new Error('Source acceptance terminated'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  const abort = setTimeout(() => controller.abort(new Error('Source acceptance semantic deadline')), 485_000);
  const ceiling = setTimeout(() => {
    process.stderr.write('Native source acceptance reached its 500s failure ceiling.\n');
    process.exit(1);
  }, 500_000);
  const phases = [];
  const context = {};
  let receipt, primary, exported, failureStage = 'runtime admission';
  try {
    try {
      // The action executable is admitted before the shared session can allocate
      // any credential, run directory, listener reservation, or process.
      const testBinary = await realpath(resolve(testPath));
      assert((await stat(testBinary)).isFile(), 'Native action executable must be a regular file');
      await access(testBinary, constants.X_OK);
      if (controller.signal.aborted) throw controller.signal.reason;
      const session = await runNativeDemoSession(options, {signal: controller.signal, acceptanceDeadline: deadline,
        onStage(stage, details) {
          Object.assign(context, details);
          if (stage !== 'Stopping the demo processes') failureStage = stage;
          const record = {stage, elapsedMs: Math.round(performance.now() - started)};
          phases.push(record);
          process.stdout.write(JSON.stringify({event: 'native-source-stage', ...record}) + '\n');
        },
        createNativeClient(context) {
          return createNativeAcceptance({...context, testBinary, deadline,
            onStage(stage, receipt) {
              failureStage = stage;
              const record = {stage, elapsedMs: Math.round(performance.now() - started),
                ...(receipt ? {receipt} : {})};
              phases.push(record);
              process.stdout.write(JSON.stringify({event: 'native-source-acceptance-stage', ...record}) + '\n');
            }});
        },
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      receipt = {event: 'native-source-accepted', runtimeSelection: session.selection,
        topology: session.provenance.topology, phases, directory: session.runDirectory,
        durationMs: Math.round(performance.now() - started)};
      await writeFile(join(session.runDirectory, 'session-evidence.json'),
        JSON.stringify({...receipt, event: 'native-source-session-closed'}, null, 2),
        {flag: 'wx', mode: 0o600});
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) { primary = error; }
    if (process.env.OE_SOURCE_EVIDENCE_DIR) {
      try {
        exported = await exportSourceEvidence({directory: process.env.OE_SOURCE_EVIDENCE_DIR, ...context,
          phases, failure: primary, failureStage, durationMs: Math.round(performance.now() - started)});
      } catch (error) {
        primary = primary ? new AggregateError([primary, error],
          'Native source acceptance failed and evidence export was incomplete', {cause: primary}) : error;
      }
    }
    if (primary) throw primary;
    receipt.durationMs = Math.round(performance.now() - started);
    if (exported) finalizeSourceEvidence({directory: process.env.OE_SOURCE_EVIDENCE_DIR,
      manifest: exported, signal: controller.signal});
    if (controller.signal.aborted) throw controller.signal.reason;
    // Session success includes source re-admission, every owned closure and
    // credential deletion. Only now can this process publish acceptance.
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } finally {
    clearTimeout(abort); clearTimeout(ceiling);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({event: 'native-source-failed',
      errors: sourceFailureRecords(error)}) + '\n');
    process.exitCode = 1;
  });
}
