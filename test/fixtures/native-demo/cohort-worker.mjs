import {writeDemoDiagnostic} from '../../../examples/native-cluster/demo-diagnostics.js';
import {appendFileSync, readFileSync} from 'node:fs';
import {createDemoNodeLifecycle} from '../../../examples/native-cluster/demo-node-lifecycle.js';
import {serveDemoWorker} from '../../../examples/native-cluster/demo-worker-protocol.js';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const record = (event) => appendFileSync(config.events, JSON.stringify({node: config.index, event}) + '\n');
let reads = 0;
serveDemoWorker({writeDiagnostic: writeDemoDiagnostic, async initialize() {
  return createDemoNodeLifecycle({configuration: {}, role: config.index === 0 ? 'seed' : 'joiner',
    createRuntime: () => ({
      async start() { record('start');
        if (config.mode === 'saturated-failure') {
          await new Promise((resolve) => process.stdout.write('x'.repeat(5 * 1024 * 1024), resolve));
          await new Promise((resolve) => process.stderr.write('unterminated' + 'y'.repeat(100000), resolve));
          throw new Error('saturated-operation');
        } if (config.mode === 'start-fail') throw new Error('first-start-failure'); },
      async stop() { record('stop'); if (config.mode === 'saturated-failure') throw new Error('saturated-cleanup'); },
      openApplicationDatabase() { return {async query() {
        record('members'); reads++;
        if (config.mode === 'members-fail') throw new Error('membership-refused');
        return {rows: config.ids.map((id, index) => ({node_id: id,
          status: config.mode === 'missing-member' && index === 2 ? 'joining' :
            reads === 1 ? 'joining' : 'active'}))};
      }}; },
    }),
    async createDeployment() {
      record('install'); if (config.mode === 'install-fail') throw new Error('first-install-failure');
      return {service: {}, async close() { record('image-close'); }};
    },
    async createService() { return {
      async listen() { record('listen'); return {host: '127.0.0.1', port: 1234, secure: false}; },
      async close() { record('service-close'); },
    }; },
  });
}});
