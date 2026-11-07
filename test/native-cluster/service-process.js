// Owned test process. Controls travel only over the parent's private IPC pipe.
import {readFile} from 'node:fs/promises';
import {createDevelopmentDeployment} from '../../examples/native-cluster/deployment.js';
import {createImageReadService} from '../../hosts/image-read-service/server.js';
import {createServiceLifecycle} from './service-lifecycle.js';

const send = (message) => process.send?.(message);
let stage = 'configuration';
let stopping = false;
const total = setTimeout(() => fail(new Error('500s total process deadline')), 500_000);
const setup = setTimeout(() => fail(new Error('160s setup deadline')), 160_000);
function fail(error) {
  send({event: 'failure', stage, error: String(error.stack ?? error),
    cause: error.cause ? String(error.cause.stack ?? error.cause) : null});
  process.exitCode = 1;
  void stop();
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(setup);
  clearTimeout(total);
  const ceiling = setTimeout(() => process.exit(1), 10_000);
  try {
    await lifecycle.stop();
    send({event: 'stopped'});
  } catch (error) {
    process.exitCode = 1;
    send({event: 'shutdown-failure', error: String(error)});
  } finally {
    process.disconnect?.();
    // Preserve the ceiling if runtime closure leaks active handles.
    ceiling.unref();
  }
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
let commands = Promise.resolve();
process.on('message', (message) => {
  commands = commands.then(async () => {
    if (message.command === 'stop') return stop();
    if (message.command === 'snapshot') send({event: 'snapshot', id: message.id, value: await lifecycle.snapshot()});
    else if (message.command === 'revoke') { lifecycle.revoke(); send({event: 'revoked', id: message.id}); }
    else throw new Error('Unknown private control');
  }).catch(fail);
});
const lifecycle = createServiceLifecycle({
  async createDeployment() {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    return createDevelopmentDeployment(config, {stage(value) {
      stage = value; send({event: 'stage', stage});
    }});
  },
  createService(config) { stage = 'service-listen'; return createImageReadService(config); },
  ready(value) { clearTimeout(setup); send({event: 'ready', ...value}); },
});
// Do not await stop inside startup's own promise: stop must await acquisition.
void lifecycle.start().catch(fail);
