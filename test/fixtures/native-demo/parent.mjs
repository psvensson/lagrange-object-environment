import {startDemoProcess} from '../../../examples/native-cluster/demo-process.js';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
const root = process.argv[2];
const owner = startDemoProcess({file: process.execPath,
  args: [fileURLToPath(new URL('./native.mjs', import.meta.url)), 'descendant-resistant-stay', join(root, 'heartbeat')],
  options: {}, label: 'parent-loss', logFile: join(root, 'parent-loss.log'),
  onFailure() {}, graceMs: 150});
await owner.ready(performance.now() + 2000);
process.send({guardian: owner.child.pid});
await owner.closed;
process.disconnect();
