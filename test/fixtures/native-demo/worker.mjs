import {appendFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {createDemoNodeLifecycle} from '../../../examples/native-cluster/demo-node-lifecycle.js';
import {serveDemoWorker} from '../../../examples/native-cluster/demo-worker-protocol.js';

const [mode, log] = process.argv.slice(2);
const record = (text) => appendFileSync(log, text + '\n');
const originalSend = process.send.bind(process);
if (mode.startsWith('send-')) process.send = (message, callback) => {
  if (message.id !== 2) return originalSend(message, callback);
  if (mode === 'send-throw') throw new Error('sync-send-failure');
  queueMicrotask(() => callback(new Error('async-send-failure')));
  return false;
};
const runtime = {
  async start() { record('start-enter'); if (mode === 'slow-start') await sleep(80); record('started'); },
  async stop() { record('runtime-close'); if (mode === 'cleanup-errors') throw new Error('raw-cleanup'); },
  openApplicationDatabase() { return {async query() { return {rows: []}; }}; },
};
serveDemoWorker({async initialize() {
  record('initialize');
  if (mode === 'slow-init') await sleep(80);
  record('initialized');
  return createDemoNodeLifecycle({configuration: {}, role: 'seed', createRuntime: () => runtime,
    async createDeployment() {
      record('installed');
      return {service: {}, async close() {
        record('deployment-close');
        if (mode === 'cleanup-errors') {
          const error = new Error('image-cleanup'); error.cause = error;
          throw new AggregateError(Array(30).fill(error), 'many-image-cleanups');
        }
      }};
    },
    async createService() { return {
      async listen() { record('listen-enter'); if (mode === 'slow-listen') await sleep(80);
        record('listening'); return {host: '127.0.0.1', port: 1234, secure: false}; },
      async close() { record('service-close');
        if (mode === 'diagnostic-bounds') {
          throw new AggregateError(Array.from({length: 30}, () => {
            const error = new Error('\u0000'.repeat(30000));
            error.name = error.message; error.code = error.message; return error;
          }), 'bounded');
        }
        if (mode === 'cleanup-errors') throw new Error('service-cleanup'); },
    }; },
  });
}});
