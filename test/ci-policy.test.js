import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLISHED_PACKAGE, SOURCE_DEVELOPMENT} from '../examples/native-cluster/runtime-selection.js';

// CI configuration as EXECUTABLE POLICY for the browser proof lane (Bead vbe),
// in the shape hosts/linux/tests/portable_images_artifact.rs already uses for
// the Images pin: anchor exactly once, scan to the next sibling key, require
// exactly one match. Line-based on purpose (no YAML dependency); indentation
// is load-bearing: job keys sit at 4 spaces, step keys at 8, `run: |` bodies
// at 10, so a shell line or a job key can never satisfy a step assertion.
//
// The contract this fences:
//   normal browser proof -> completes;  proof failure -> fails;
//   proof leak/hang -> BOUNDED CI failure -- never GitHub's 360-minute default.
// and the two things the lane must never do: run its heavyweight proofs with
// overlapping file concurrency, or force the runner to exit past a leak.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').split('\n');
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const BROWSER_DIR = join(REPO_ROOT, 'test', 'browser');
const MANUAL_PROOF = 'browser-proof.canvas.manual.test.js'; // real display, not CI
const BROWSER_STEP = '      - name: Browser WebGPU proof';

test('ci policy: source native acceptance always runs on PR/main with exact source identities and bounded real proof', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/native-source.yml'), 'utf8').split('\n');
  assert(workflow.includes('name: Native source development'));
  assert(workflow.includes('  pull_request:'));
  const push = windowOf(workflow, line => line === '  push:', /^  \S/, 'source push trigger');
  assert(push.includes('    branches: [main]'));
  assert(!workflow.some(line => isCode(line) && /continue-on-error|^\s+paths(?:-ignore)?:/.test(line)),
    'the development proof cannot be skipped or tolerate a failed live run');
  const artifact = windowOf(workflow, line => line.includes('- name: Retain bounded source evidence'),
    /^      - /, 'source evidence retention');
  assert.deepEqual(workflow.filter(line => isCode(line) && /^\s+if:/.test(line)), ['        if: always()']);
  assert(artifact.includes('        if: always()'), 'only ancillary evidence retention may have a condition');
  assert(artifact.some(line => line.trim() === 'uses: actions/upload-artifact@v7.0.2'));
  const evidencePaths = artifact.filter(line => line.trim().startsWith('${{ runner.temp }}/'))
    .map(line => line.trim().replace('${{ runner.temp }}/native-source-evidence/', ''));
  assert.deepEqual(evidencePaths, ['manifest.json', 'diagnostics.json', 'receipts.json',
    'snapshot-1.json', 'snapshot-2.json'], 'upload only explicit sanitized exports, never private run files');
  assert(artifact.includes('          if-no-files-found: error'));
  const job = windowOf(workflow, line => line === '  native-source-development:', /^  \S/, 'source native job');
  exactlyOneTimeout(job, 4, 'source native job', 30);
  for (const [repository, revision] of [['psvensson/lagrange', SOURCE_DEVELOPMENT.revision],
    ['psvensson/lagrange-images', SOURCE_DEVELOPMENT.imagesRevision]]) {
    const checkout = windowOf(workflow, line => line.trim() === `repository: ${repository}`,
      /^      - /, `${repository} source checkout`);
    assert.deepEqual(checkout.filter(line => line.trim().startsWith('ref:')).map(line => line.trim()),
      [`ref: ${revision}`]);
  }
  const install = windowOf(workflow, line => line.includes('- name: Install locked source dependencies'),
    /^      - /, 'locked source dependencies');
  assert(install.includes('        working-directory: lagrange-source'));
  assert(install.some(line => line.trim() === 'run: npm ci --no-audit --no-fund'));
  assert(workflow.some(line => line.includes('- name: Prove the published package is absent')));
  assert(!workflow.some(line => line.trim() === 'working-directory: lagrange-object-environment/examples/native-cluster'));
  const compileIndex = workflow.findIndex(line => line.includes('- name: Compile native artifacts before starting source processes'));
  const proofIndex = workflow.findIndex(line => line.includes('- name: Native source executable and GTK acceptance'));
  assert(compileIndex >= 0 && compileIndex < proofIndex, 'compile both native artifacts before cohort acquisition');
  assert(workflow.some(line => line.includes('--test native_cluster --no-run')));
  assert(workflow.some(line => line.includes('--locked --bin lagrange-host-linux')));
  const proof = windowOf(workflow, line => line.includes('- name: Native source executable and GTK acceptance'),
    /^      - /, 'source native proof');
  exactlyOneTimeout(proof, 8, 'source native proof', 10);
  assert(proof.some(line => line.includes('node test/native-cluster/run-source.js')));
  assert(proof.includes('          OE_SOURCE_EVIDENCE_DIR: ${{ runner.temp }}/native-source-evidence'));
  for (const argument of ['--lagrange-checkout', '--images-checkout', '--native-binary']) {
    assert(proof.some(line => line.includes(argument)), `the proof explicitly supplies ${argument}`);
  }
  assert(proof.some(line => line.includes('--host-id "$(hostname)"')),
    'all local processes use the actual runner host identity');
});

test('ci policy: the published release trial runs on PR/manual with the installed identity and real failure behavior', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/native-cluster.yml'), 'utf8').split('\n');
  assert(workflow.includes('name: Published package release trial'));
  const triggers = windowOf(workflow, line => line === 'on:', /^\S/, 'published trial triggers');
  assert.deepEqual(triggers.filter(line => line.trim()).map(line => line.trim()).sort(),
    ['pull_request:', 'workflow_dispatch:'], 'the diagnostic trial runs on PR and manual dispatch only');
  const job = windowOf(workflow, (line) => line === '  published-native-cluster:', /^  \S/, 'published native job');
  exactlyOneTimeout(job, 4, 'published native job', 30);
  const proof = windowOf(workflow, (line) => line.includes('- name: Native executable and GTK actions'), /^      - /, 'real native proof');
  exactlyOneTimeout(proof, 8, 'real native proof', 10);
  const runIndex = proof.findIndex(line => line.includes('node test/native-cluster/run.js'));
  const hostIndex = proof.findIndex(line => line.trim() === 'export NODE_HOST_ID="$(hostname)"');
  assert(runIndex >= 0, 'the package trial retains its existing acceptance runner');
  assert(hostIndex >= 0 && hostIndex < runIndex, 'the installed runtime receives the actual runner host identity');
  assert(!workflow.some((line) => isCode(line) && /continue-on-error|^\s+if:|^\s+paths(?:-ignore)?:/.test(line)),
    'live gate cannot silently skip or tolerate failure');
  const install = windowOf(workflow, line => line.includes('- name: Install locked published Lagrange deployment'),
    /^      - /, 'locked published deployment');
  assert(install.includes('        working-directory: lagrange-object-environment/examples/native-cluster'));
  assert(install.some(line => line.trim() === 'run: npm ci --no-audit --no-fund'));
  const admission = windowOf(workflow, line => line.includes('- name: Record admitted installed package identity'),
    /^      - /, 'installed package identity');
  assert(admission.includes('        working-directory: lagrange-object-environment/examples/native-cluster'));
  assert(admission.some(line => line.includes('node --input-type=module -e')));
  assert.match(admission.join('\n'), /import\s*\{\s*admitRuntimeSelection\s*\}\s*from\s*['"]\.\/runtime-selection\.js['"]/);
  assert.match(admission.join('\n'), /console\.log\(JSON\.stringify\(\{\s*event:\s*['"]published-runtime-admitted['"],\s*selection:\s*await admitRuntimeSelection\(\)\s*\}\)\)/);
  const installIndex = workflow.findIndex(line => line.includes('- name: Install locked published Lagrange deployment'));
  const admissionIndex = workflow.findIndex(line => line.includes('- name: Record admitted installed package identity'));
  const proofIndex = workflow.findIndex(line => line.includes('- name: Native executable and GTK actions'));
  assert(installIndex < admissionIndex && admissionIndex < proofIndex,
    'identity admission reads the installed package before the live trial');
  assert(workflow.some((line) => line.includes('--test native_cluster --no-run')));
  assert(!workflow.some(line => isCode(line) && /run-source\.js|--lagrange-checkout/.test(line)),
    'the published proof must not silently execute a source checkout');
  const checkout = windowOf(workflow, line => line.trim() === 'repository: psvensson/lagrange-images',
    /^      - /, 'published Images checkout');
  assert.deepEqual(checkout.filter(line => line.trim().startsWith('ref:')).map(line => line.trim()),
    [`ref: ${PUBLISHED_PACKAGE.imagesRevision}`]);
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/native-cluster/package-lock.json')));
  const dependency = lock.packages['node_modules/lagrange-server'];
  assert.equal(dependency.version, PUBLISHED_PACKAGE.version);
  assert.equal(dependency.version, lock.packages[''].dependencies['lagrange-server']);
  assert.equal(dependency.resolved,
    `https://registry.npmjs.org/lagrange-server/-/lagrange-server-${PUBLISHED_PACKAGE.version}.tgz`);
  assert.equal(dependency.integrity,
    'sha512-qstNVQXV6BwaUrJ37mFTXtWJsSZH2dFrIjso5n8rt06f/PZybmJaWLxpCV++cG69ozUgIvNPewIUD/4vNuxtYg==');
});

const isCode = (line) => !line.trimStart().startsWith('#');

// The window of a block: from its anchor (matched exactly once) to the next
// sibling at the same indentation, comments excluded.
function windowOf(lines, anchorPredicate, siblingPattern, what) {
  const anchors = lines.map((l, i) => (isCode(l) && anchorPredicate(l) ? i : -1)).filter((i) => i >= 0);
  assert.equal(anchors.length, 1, `${what} must appear exactly once in ci.yml`);
  const out = [];
  for (let i = anchors[0] + 1; i < lines.length && !siblingPattern.test(lines[i]); i += 1) {
    if (isCode(lines[i])) out.push(lines[i]);
  }
  return out;
}

function exactlyOneTimeout(window, indent, what, max) {
  const re = new RegExp(`^${' '.repeat(indent)}timeout-minutes: (\\d+)$`);
  const found = window.map((l) => l.match(re)).filter(Boolean);
  assert.equal(found.length, 1, `${what} must declare exactly one timeout-minutes`);
  const minutes = Number(found[0][1]);
  assert.ok(minutes >= 1 && minutes <= max, `${what} timeout-minutes ${minutes} must be within 1..${max}`);
  return minutes;
}

test('ci policy: the browser proof step is bounded, runs only the proof, and the job is bounded too', () => {
  const step = windowOf(CI, (l) => l.startsWith(BROWSER_STEP), /^      - /, 'the Browser WebGPU proof step');
  const stepMinutes = exactlyOneTimeout(step, 8, 'the Browser WebGPU proof step', 30);
  assert.ok(step.some((l) => l.includes('npm run test:browser')), 'the bounded step is the one that runs the proof');
  assert.ok(!step.some((l) => l.includes('apt-get')), 'package installation is not inside the proof step (the bound must be attributable to the proof)');
  const testJob = windowOf(CI, (l) => l === '  test:', /^  \S/, 'the test job');
  const jobMinutes = exactlyOneTimeout(testJob, 4, 'the test job', 120);
  assert.ok(jobMinutes > stepMinutes, 'the job backstop is looser than the proof bound');
  exactlyOneTimeout(windowOf(CI, (l) => l === '  linux-host:', /^  \S/, 'the linux-host job'), 4, 'the linux-host job', 120);
});

// The real-runtime integration files (including E1's only identity proof) skip
// SILENTLY when no sibling lagrange-images resolves, so "all green" and "nothing
// ran" look identical. CI checks the sibling out at the pinned revision, so the
// npm test step must demand it — otherwise the demand is a comment, not a gate.
test('ci policy: the npm test step REQUIRES the pinned sibling Images runtime', () => {
  const step = windowOf(CI, (l) => l.trim() === 'run: npm test', /^      - /, 'the npm test step');
  assert.ok(
    step.some((l) => /^\s+LAGRANGE_IMAGES_REQUIRED: '1'$/.test(l)),
    "the npm test step must set LAGRANGE_IMAGES_REQUIRED: '1' so a silently skipped integration lane fails",
  );
  assert.ok(
    CI.some((l) => isCode(l) && l.includes('repository: psvensson/lagrange-images')),
    'requiring the sibling runtime is only meaningful if the workflow checks it out',
  );
  // ...and only meaningful if something READS it. Setting the variable while no
  // test consumes it would relocate the silent-skip defect one level up rather
  // than fixing it.
  const readers = readdirSync(join(REPO_ROOT, 'test'))
    .filter((file) => file.endsWith('.test.js'))
    .filter((file) => readFileSync(join(REPO_ROOT, 'test', file), 'utf8').includes('process.env.LAGRANGE_IMAGES_REQUIRED'));
  assert.ok(
    readers.length >= 1,
    'at least one test must READ process.env.LAGRANGE_IMAGES_REQUIRED and fail when the runtime is absent',
  );
});

test('ci policy: nothing in the workflow or the scripts forces the runner to exit past a leak', () => {
  assert.ok(!CI.some((l) => isCode(l) && l.includes('--test-force-exit')), 'ci.yml must not use --test-force-exit');
  for (const [name, script] of Object.entries(PACKAGE.scripts)) {
    assert.ok(!script.includes('--test-force-exit'), `package.json script ${name} must not use --test-force-exit`);
  }
});

test('ci policy: the browser lane is explicitly serialized, attributable, and runs every CI proof file', () => {
  const script = PACKAGE.scripts['test:browser'];
  const words = script.split(/\s+/);
  assert.equal(words[0], 'node');
  assert.equal(words[1], '--test');
  assert.ok(words.includes('--test-concurrency=1'), 'heavyweight browser proofs run serially until a shared harness is deliberately designed');
  assert.ok(words.some((w) => /^--test-timeout=\d+$/.test(w)), 'a per-test timeout attributes a hang inside a proof body to a named test');
  const listed = words.filter((w) => w.startsWith('test/browser/')).map((w) => w.slice('test/browser/'.length)).sort();
  const onDisk = readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.test.js') && f !== MANUAL_PROOF).sort();
  assert.deepEqual(listed, onDisk, 'the script lists exactly the CI proof files on disk (a new proof file cannot be silently left out)');
});

test('ci policy: every CI proof file goes through the ONE lifecycle owner with no options', () => {
  const files = readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.test.js') && f !== MANUAL_PROOF);
  assert.ok(files.length >= 4);
  for (const file of files) {
    const source = readFileSync(join(BROWSER_DIR, file), 'utf8');
    const imports = source.split('\n').filter((l) => /^import\b/.test(l));
    assert.ok(imports.some((l) => l.includes("'./support/proof-lane.js'")), `${file} imports the lifecycle owner`);
    assert.ok(!imports.some((l) => /puppeteer|['"](node:)?https?['"]/.test(l)), `${file} launches no browser and serves nothing of its own`);
    assert.ok(!/\bimport\s*\(/.test(source), `${file} must not import anything dynamically (the only browser comes from the lifecycle owner)`);
    assert.ok(!source.includes('serveRepo'), `${file} must not serve the repository itself`);
    const calls = source.match(/withProofPage\([^\n]*/g) ?? [];
    assert.ok(calls.length >= 1, `${file} uses withProofPage`);
    for (const call of calls) {
      assert.match(call, /^withProofPage\(async \(\{page\}\) => \{$/, `${file}: ${call} -- the proofs pass a body and NO options (the seams are for the lifecycle proof only)`);
    }
    for (const seam of ['launchTimeoutMs', 'closeTimeoutMs', 'launch:', 'serve:']) {
      assert.ok(!source.includes(seam), `${file} must not reach the ${seam} seam`);
    }
  }
});
