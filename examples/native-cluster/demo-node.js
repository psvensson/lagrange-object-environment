import {writeDemoDiagnostic} from './demo-diagnostics.js';
// Private owned entry; imports only public Lagrange and Images composition.
import {readFile} from 'node:fs/promises';
import {createDevelopmentDeployment} from './deployment.js';
import {validateRuntimeSelection} from './runtime-selection.js';
import {createImageReadService} from '../../hosts/image-read-service/server.js';
import {createDemoNodeLifecycle} from './demo-node-lifecycle.js';
import {serveDemoWorker} from './demo-worker-protocol.js';

serveDemoWorker({writeDiagnostic: writeDemoDiagnostic, async initialize() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const selection = validateRuntimeSelection(config.selection);
  const deploymentSelection = validateRuntimeSelection(config.deployment?.selection);
  if (JSON.stringify(selection) !== JSON.stringify(deploymentSelection)) {
    throw new Error('Worker and deployment runtime selections disagree');
  }
  const {createEmbeddedLagrange} = await import(selection.specifier);
  if (typeof createEmbeddedLagrange !== 'function') throw new Error('Public Lagrange runtime factory is unavailable');
  return createDemoNodeLifecycle({configuration: config.node.configuration,
    role: config.node.role, createRuntime: createEmbeddedLagrange, evidenceDirectory: config.evidenceDirectory,
    createDeployment: (runtime, cleanupFailure) => createDevelopmentDeployment(
      {...config.deployment, selection}, {lagrangeRuntime: runtime, cleanupFailure}),
    createService: createImageReadService});
}});
