// Trusted test-input export, never an Environment import workflow.
// Uses the exact Images git object without checking out or changing its repository.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const fixture = new URL('../test/fixtures/yaxo/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
const repository = resolve(process.env.LAGRANGE_IMAGES_REPO
  ?? fileURLToPath(new URL('../../lagrange-images/', import.meta.url)));
const assets = resolve(process.env.LAGRANGE_CUIS_ASSETS ?? join(repository, '.integration'));
const check = process.argv.includes('--check');
assert.ok(process.argv.slice(2).every((arg) => arg === '--check'), 'only --check is supported');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = new Map();
for (const [name, pin] of Object.entries(provenance.inputs)) {
  const bytes = await readFile(join(assets, pin.path));
  assert.equal(digest(bytes), pin.sha256, name + ' input SHA-256');
  if (pin.gitBlob) {
    const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    assert.equal(blob, pin.gitBlob, name + ' upstream git blob');
  }
  inputs.set(name, bytes);
}

const directory = await mkdtemp(join(tmpdir(), 'environment-yaxo-export-'));
let runtime;
try {
  const source = join(directory, 'images');
  await mkdir(source);
  const archive = join(directory, 'images.tar');
  execFileSync('git', ['-C', repository, 'archive', '--format=tar',
    '--output=' + archive, provenance.imagesRevision]);
  execFileSync('tar', ['-xf', archive, '-C', source]);
  const api = await import(pathToFileURL(join(source, 'src/runtime.js')).href);
  runtime = await api.createRuntime({
    backend: {mode: 'mock'},
    toolchainProviders: [[api.OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID,
      api.createOpenSmalltalkCuisToolchainProvider({
        vmPath: join(assets, provenance.inputs.vm.path),
        vmIdentity: provenance.vmIdentity,
        timeoutMs: 900_000,
      })]],
  });
  const imageId = 'yaxo-export';
  await runtime.images.createImage({id: imageId});
  const put = (id, representation, content, logicalPath, metadata = {}) =>
    runtime.images.putCodeArtifact(imageId, {
      id, languageId: 'smalltalk', representation, content, logicalPath, metadata, dependencies: [],
    });
  const baseImage = await put('base-image', api.CUIS_IMAGE_V1, api.bytesValue(inputs.get('image')),
    'Cuis7.9-8090.image', {identity: provenance.cuisImageIdentity});
  const changes = await put('base-changes', api.CUIS_CHANGES_V1, api.bytesValue(inputs.get('changes')),
    'Cuis7.9-8090.changes');
  const sources = await put('base-sources', api.CUIS_SOURCES_V1, api.bytesValue(inputs.get('sources')),
    'Cuis7.8.sources');
  const pkg = await put('yaxo-package', api.CUIS_PACKAGE_V1,
    api.textValue(inputs.get('package').toString('utf8')), 'YAXO.pck.st',
    {identity: provenance.packageIdentity});
  await runtime.images.putCodeArtifact(imageId, {
    id: 'build-root', languageId: 'smalltalk', representation: api.CUIS_BUILD_V1,
    content: api.textValue(api.CUIS_BUILD_CONTRACT_V0), metadata: {},
    dependencies: [
      {role: 'base-image', artifact: api.objectRef(imageId, baseImage.id)},
      {role: 'base-changes', artifact: api.objectRef(imageId, changes.id)},
      {role: 'base-sources', artifact: api.objectRef(imageId, sources.id)},
      {role: 'package', artifact: api.objectRef(imageId, pkg.id)},
    ],
  });
  await runtime.toolchains.run({
    providerId: api.OPENSMALLTALK_CUIS_TOOLCHAIN_PROVIDER_ID, imageId,
    roots: [api.objectRef(imageId, 'build-root')],
    target: {representation: api.CUIS_IMAGE_V1, fileName: 'YaxoEnvironmentInput.image'},
    options: {semanticExport: api.CUIS_SEMANTIC_EXPORT_V2},
    outputIds: {image: 'derived-image', changes: 'derived-changes', 'semantic-export': 'export'},
  });
  const artifact = await runtime.images.getCodeArtifact(imageId, 'export');
  assert.equal(artifact.representation, api.CUIS_SEMANTIC_EXPORT_V2);
  const bytes = Buffer.from(artifact.content.value, 'utf8');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.classes.length, 24);
  assert.equal(manifest.methods.length, 341);
  const scopeBytes = await readFile(new URL('scope.json', fixture));
  const output = {
    sha256: digest(bytes), bytes: bytes.length, classes: 24, methods: 341,
    scopeSha256: digest(scopeBytes),
  };
  if (check) {
    assert.deepEqual(bytes, await readFile(new URL('manifest.json', fixture)), 'repeated export bytes');
    assert.deepEqual(output, provenance.output, 'recorded export identity');
  } else {
    await writeFile(new URL('manifest.json', fixture), bytes);
    await writeFile(new URL('provenance.json', fixture),
      JSON.stringify({...provenance, output}, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify({mode: check ? 'check' : 'export', ...output}) + '\n');
} finally {
  try {
    if (runtime) await runtime.close();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
