import {writeDemoDiagnostic} from './demo-diagnostics.js';
// Private owned entry; imports only public Lagrange and Images composition.
import {readFile} from 'node:fs/promises';
import {createEmbeddedLagrange} from 'lagrange-server';
import {createDevelopmentDeployment} from './deployment.js';
import {createImageReadService} from '../../hosts/image-read-service/server.js';
import {createDemoNodeLifecycle} from './demo-node-lifecycle.js';
import {serveDemoWorker} from './demo-worker-protocol.js';

serveDemoWorker({writeDiagnostic: writeDemoDiagnostic, async initialize() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  return createDemoNodeLifecycle({configuration: config.node.configuration,
    role: config.node.role, createRuntime: createEmbeddedLagrange,
    createDeployment: (runtime, cleanupFailure) => createDevelopmentDeployment(
      config.deployment, {lagrangeRuntime: runtime, cleanupFailure}),
    createService: createImageReadService});
}});
