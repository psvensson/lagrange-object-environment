import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

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
