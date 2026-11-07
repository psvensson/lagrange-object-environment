import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createImageReadService} from './server.js';
import {positiveInteger} from '../../src/image-read-connection.js';

// The module is trusted operator configuration, never a client-supplied path.
// It owns runtime/bootstrap and identity policy; this process owns listening
// and shutdown. There is no default root identity or in-memory fallback.
async function main() {
  const {values} = parseArgs({options: {
    deployment: {type: 'string'},
    host: {type: 'string', default: '127.0.0.1'},
    port: {type: 'string', default: '7332'},
    'shutdown-timeout-ms': {type: 'string', default: '5000'},
  }});
  if (!values.deployment) throw new TypeError('A trusted deployment module is required');
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const shutdownMs = positiveInteger(Number(values['shutdown-timeout-ms']), 'shutdown-timeout-ms');
  let deployment;
  let service;
  let stopped = false;
  let deadline;
  function startShutdownDeadline() {
    deadline ??= setTimeout(() => {
      process.stderr.write('Read service shutdown did not complete.\n');
      process.exit(1);
    }, shutdownMs);
  }
  let settleStop;
  const stop = new Promise((resolveStop) => { settleStop = resolveStop; });
  const requestStop = () => { stopped = true; startShutdownDeadline(); settleStop(); };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    const module = await import(pathToFileURL(resolve(values.deployment)).href);
    if (typeof module.createDeployment !== 'function') throw new TypeError('Deployment must export createDeployment');
    if (stopped) return;
    deployment = await module.createDeployment();
    if (!deployment || typeof deployment.close !== 'function') throw new TypeError('Deployment must own close');
    if (stopped) return;
    service = await createImageReadService(deployment.service);
    if (stopped) return;
    const address = await service.listen({host: values.host, port});
    process.stdout.write(JSON.stringify({event: 'listening', ...address}) + '\n');
    await stop;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    // Even a non-cooperative deployment close cannot retain this owned process.
    startShutdownDeadline();
    let failure;
    try {
      try { await service?.close(); } catch (error) { failure = error; }
      try { await deployment?.close(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    } finally {
      // Do not keep a clean process alive, but still enforce the ceiling if a
      // deployment resolves close() while leaking a timer/socket/worker.
      deadline.unref();
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Provider errors may contain credential material; do not print them.
    process.stderr.write('Read service failed.\n');
    process.exit(1);
  });
}

export {main};
