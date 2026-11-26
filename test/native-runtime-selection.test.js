import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {admitRuntimeSelection, validateRuntimeSelection, PUBLISHED_PACKAGE,
  SOURCE_DEVELOPMENT} from '../examples/native-cluster/runtime-selection.js';

const execute = promisify(execFile);
const MANIFEST = {name: 'lagrange-server', version: SOURCE_DEVELOPMENT.version, type: 'module',
  main: 'src/public-api.js', exports: {'.': './src/public-api.js'}};
const ENTRY = 'throw new Error("Admission must not import this public entry");\n';

async function sourceFixture(t, {manifest = MANIFEST, lock = true, linkedEntry = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oe-runtime-source-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  if (lock) await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\nsrc/ignored.mjs\n');
  if (linkedEntry) await symlink('/outside/public-api.js', join(root, 'src/public-api.js'));
  else await writeFile(join(root, 'src/public-api.js'), ENTRY);
  const git = (...args) => execute('git', args, {cwd: root, timeout: 5000, maxBuffer: 64 * 1024,
    env: {PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C'}});
  await git('init'); await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  // A tiny fixture cannot hash to the production commit. Replace only this
  // read; root/cleanliness/tracked-file checks still execute real git.
  const executeGit = (command, args, options) => args.join(' ') === 'rev-parse HEAD'
    ? Promise.resolve({stdout: SOURCE_DEVELOPMENT.revision + '\n', stderr: ''})
    : execute(command, args, options);
  return {root, git, executeGit, options: {lagrangeCheckout: root}};
}

test('source admission resolves its exact public entry without consulting or importing the installed package', async (t) => {
  const f = await sourceFixture(t);
  await mkdir(join(f.root, 'node_modules/dependency'), {recursive: true});
  await writeFile(join(f.root, 'node_modules/dependency/index.js'), '// installed dependency\n');
  const before = await readdir(f.root);
  let packageResolutions = 0;
  const selected = await admitRuntimeSelection(f.options, {executeGit: f.executeGit,
    packageFile: join(f.root, 'absent-package.json'),
    resolvePackage() { packageResolutions++; throw new Error('No installed package'); }});
  assert.deepEqual(selected, {...SOURCE_DEVELOPMENT,
    specifier: pathToFileURL(join(f.root, 'src/public-api.js')).href});
  assert.equal(packageResolutions, 0);
  assert.equal(Object.isFrozen(selected), true);
  assert.deepEqual(validateRuntimeSelection(JSON.parse(JSON.stringify(selected))), selected);
  assert.deepEqual(await readdir(f.root), before);
  assert.equal(await readFile(join(f.root, 'src/public-api.js'), 'utf8'), ENTRY);
});

test('wrong actual revision and a nested directory cannot acquire source admission', async (t) => {
  const f = await sourceFixture(t);
  await assert.rejects(admitRuntimeSelection(f.options), /Lagrange checkout must be/);
  await assert.rejects(admitRuntimeSelection({lagrangeCheckout: join(f.root, 'src')},
    {executeGit: f.executeGit}), /must name the repository root/);
  for (const lagrangeCheckout of ['', null, 12]) {
    await assert.rejects(admitRuntimeSelection({lagrangeCheckout}), /source repository root/);
  }
});

test('both unstaged and staged source changes refuse even when the reported revision matches', async (t) => {
  for (const staged of [false, true]) {
    const f = await sourceFixture(t);
    await writeFile(join(f.root, 'src/public-api.js'), ENTRY + '// changed\n');
    if (staged) await f.git('add', 'src/public-api.js');
    await assert.rejects(admitRuntimeSelection(f.options, {executeGit: f.executeGit}),
      (error) => error.code === 1 && error.cmd.includes('diff --quiet'));
  }
});

test('a staged source change remains dirty when its working file is restored to HEAD', async (t) => {
  const f = await sourceFixture(t);
  await writeFile(join(f.root, 'src/public-api.js'), ENTRY + '// staged change\n');
  await f.git('add', 'src/public-api.js');
  await writeFile(join(f.root, 'src/public-api.js'), ENTRY);
  // Establish the competing check's false-clean result before the refusal.
  await f.git('diff', '--quiet', 'HEAD', '--');
  await assert.rejects(admitRuntimeSelection(f.options, {executeGit: f.executeGit}),
    (error) => error.code === 1 && error.cmd.includes('--cached'));
});

test('untracked source cannot hide behind ignore rules or nested dependency paths', async (t) => {
  for (const path of ['src/extra.mjs', 'src/ignored.mjs', 'src/node_modules/injected/index.js']) {
    const f = await sourceFixture(t);
    if (path.includes('/node_modules/')) await mkdir(join(f.root, 'src/node_modules/injected'), {recursive: true});
    await writeFile(join(f.root, path), '// untracked source\n');
    await assert.rejects(admitRuntimeSelection(f.options, {executeGit: f.executeGit}), /untracked source/);
  }
});

test('untracked or missing lock, wrong public export and a linked entry refuse independently of clean tracked content', async (t) => {
  const missing = await sourceFixture(t, {lock: false});
  await assert.rejects(admitRuntimeSelection(missing.options, {executeGit: missing.executeGit}));
  await writeFile(join(missing.root, 'package-lock.json'), '{}');
  await assert.rejects(admitRuntimeSelection(missing.options, {executeGit: missing.executeGit}), /untracked source/);
  const wrong = await sourceFixture(t, {manifest: {...MANIFEST, exports: {'.': './src/index.js'}}});
  await assert.rejects(admitRuntimeSelection(wrong.options, {executeGit: wrong.executeGit}), /must expose src\/public-api.js/);
  const linked = await sourceFixture(t, {linkedEntry: true});
  await assert.rejects(admitRuntimeSelection(linked.options, {executeGit: linked.executeGit}), /regular file/);
});

test('published admission preserves its own identity and cannot fall back to source after package failure', async (t) => {
  const f = await sourceFixture(t);
  const packageFile = join(f.root, 'package.json');
  await writeFile(packageFile, JSON.stringify({...MANIFEST, gitHead: PUBLISHED_PACKAGE.revision}));
  let gitCalls = 0;
  const dependencies = {packageFile, executeGit() { gitCalls++; throw new Error('Source must not be inspected'); }};
  const selected = await admitRuntimeSelection({}, dependencies);
  assert.deepEqual(selected, {...PUBLISHED_PACKAGE,
    specifier: pathToFileURL(join(f.root, 'src/public-api.js')).href});
  assert.equal(selected.version, SOURCE_DEVELOPMENT.version);
  assert.equal(selected.revision, SOURCE_DEVELOPMENT.revision);
  assert.notEqual(selected.kind, SOURCE_DEVELOPMENT.kind);
  assert.notEqual(selected.imagesRevision, SOURCE_DEVELOPMENT.imagesRevision);
  assert.throws(() => validateRuntimeSelection({...selected, kind: SOURCE_DEVELOPMENT.kind}),
    /does not match an admitted identity/);
  for (const field of ['name', 'version', 'gitHead']) {
    await writeFile(packageFile, JSON.stringify({...MANIFEST, gitHead: PUBLISHED_PACKAGE.revision, [field]: 'wrong'}));
    await assert.rejects(admitRuntimeSelection({}, dependencies), /locked.*Lagrange package/);
  }
  await rm(packageFile);
  await assert.rejects(admitRuntimeSelection({}, dependencies), {code: 'ENOENT'});
  const resolutionFailure = new Error('Published package is not installed');
  await assert.rejects(admitRuntimeSelection({}, {resolvePackage() { throw resolutionFailure; }}),
    (error) => error === resolutionFailure);
  assert.equal(gitCalls, 0);
});

test('serialized runtime descriptors cannot substitute identity, mode or a private/remote entry', () => {
  const valid = {...SOURCE_DEVELOPMENT, specifier: 'file:///source/src/public-api.js'};
  const wrongRevision = '0'.repeat(40);
  assert.notEqual(wrongRevision, SOURCE_DEVELOPMENT.revision);
  const accessor = {...valid};
  let getterCalls = 0;
  Object.defineProperty(accessor, 'specifier', {
    get() { getterCalls++; throw new Error('Getter must not be invoked'); }, enumerable: true});
  for (const invalid of [null, [], Object.create(valid), accessor, {...valid, [Symbol('extra')]: true},
    {...valid, kind: PUBLISHED_PACKAGE.kind},
    {...valid, revision: wrongRevision}, {...valid, imagesRevision: PUBLISHED_PACKAGE.imagesRevision},
    {...valid, package: 'lagrange-server'}, {...valid, specifier: 'file:///source/src/index.js'},
    {...valid, specifier: 'https://example.invalid/src/public-api.js'},
    {...valid, specifier: 'file:///source/src/public-api.js?fallback=true'}]) {
    assert.throws(() => validateRuntimeSelection(invalid));
  }
  assert.equal(getterCalls, 0);
});
