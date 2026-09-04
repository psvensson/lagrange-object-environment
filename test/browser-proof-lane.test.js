import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {withProofPage, serveRepo, BrowserLifecycleError} from './browser/support/proof-lane.js';

// The browser proof lane's LIFECYCLE proof (Bead vbe). Node-only, no display,
// no real Chrome: it drives withProofPage's failure paths through the injected
// seams and asserts that every path RELEASES the server and the browser and
// that no failure is ever swallowed. The one real control (last test) runs the
// helper in a child process against a fake Chrome that never publishes its
// DevTools endpoint -- the exact failure that hung CI for 37 minutes -- and
// requires the child to exit by itself: a leaked handle would keep it alive.
//
// A released server is proven two ways because process.getActiveResourcesInfo()
// is unreliable here (still lists a closed TCPServerWrap for a few ticks, and
// an unref()'d server disappears from it while still accepting connections):
// server.listening must be false AND a connect to the captured port must be
// refused.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

function fakePage(overrides = {}) {
  return {
    setViewport: async () => {}, on() {}, goto: async () => {}, waitForFunction: async () => {},
    ...overrides,
  };
}

function fakeBrowser({close = 'resolve', proc = null, page = fakePage()} = {}) {
  const browser = {
    closeCalls: 0,
    newPage: async () => page,
    process: () => proc,
    close() {
      browser.closeCalls += 1;
      if (close === 'hang') return new Promise(() => {});
      if (close === 'reject') return Promise.reject(new Error('close exploded'));
      return Promise.resolve();
    },
  };
  return browser;
}

// Every server handed out by the seam is closed after the file: a helper that
// LEAKS one still turns its test red (assertReleased), but must not also hang
// this file.
const captured = [];
test.after(() => { for (const server of captured) if (server.listening) server.close(); });

function capturingServe() {
  const seen = {};
  const serve = async () => {
    const r = await serveRepo();
    seen.server = r.server; seen.port = r.port; captured.push(r.server);
    return r;
  };
  return {seen, serve};
}

// A helper that stops bounding browser.close() would hang forever; this bound
// exists so that defect is a NAMED red, not a hung file.
function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} (proof deadline ${ms} ms)`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('error', (e) => resolve(e.code));
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); });
  });
}

async function assertReleased(seen) {
  assert.ok(seen.server, 'the serve seam handed the test the real server');
  assert.equal(seen.server.listening, false, 'the server is no longer listening');
  assert.equal(await probe(seen.port), 'ECONNREFUSED', 'the captured port refuses connections');
}

test('lifecycle: a launch failure releases the server and propagates the launch error', async () => {
  const {seen, serve} = capturingServe();
  const launchError = new Error('launch failed');
  await assert.rejects(
    withProofPage(async () => 'never', {serve, launch: async () => { throw launchError; }}),
    (e) => e === launchError,
  );
  await assertReleased(seen);
});

test('lifecycle: a setup failure AFTER launch closes the browser and releases the server', async () => {
  const {seen, serve} = capturingServe();
  const browser = fakeBrowser({page: fakePage({goto: async () => { throw new Error('navigation failed'); }})});
  await assert.rejects(withProofPage(async () => 'never', {serve, launch: async () => browser}), /navigation failed/);
  assert.equal(browser.closeCalls, 1, 'the browser was closed even though the body never ran');
  await assertReleased(seen);
});

test('lifecycle: a body failure propagates UNCHANGED (same object, full assertion diff) after both resources are released', async () => {
  const {seen, serve} = capturingServe();
  const browser = fakeBrowser();
  let thrown;
  try { assert.equal(1, 2, 'the real proof assertion'); } catch (e) { thrown = e; }
  await assert.rejects(
    withProofPage(async () => { throw thrown; }, {serve, launch: async () => browser}),
    (e) => e === thrown && e.cause === undefined && e.expected === 2 && e.actual === 1,
  );
  assert.equal(browser.closeCalls, 1);
  await assertReleased(seen);
});

test('lifecycle: a body failure plus a cleanup failure surfaces the body error with the cleanup error as its cause', async () => {
  const {seen, serve} = capturingServe();
  const browser = fakeBrowser({close: 'reject'});
  const bodyError = new Error('the proof failed');
  await assert.rejects(
    withProofPage(async () => { throw bodyError; }, {serve, launch: async () => browser}),
    (e) => e === bodyError && e.cause instanceof Error && e.cause.message === 'close exploded',
  );
  await assertReleased(seen);
});

test('lifecycle: a GREEN body with a rejecting browser.close FAILS (nothing is swallowed)', async () => {
  const {seen, serve} = capturingServe();
  const browser = fakeBrowser({close: 'reject'});
  await assert.rejects(withProofPage(async () => 'green', {serve, launch: async () => browser}), /close exploded/);
  await assertReleased(seen);
});

test('lifecycle: a browser.close that never resolves is bounded: the Chrome process group is SIGKILLed, the failure is raised, the server is still released', async () => {
  // A real detached child stands in for Chrome (puppeteer spawns Chrome
  // detached, as its own process-group leader); the fake browser's close hangs.
  const proc = spawn('sleep', ['300'], {detached: true, stdio: 'ignore'});
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({code, signal})));
  try {
    const {seen, serve} = capturingServe();
    const browser = fakeBrowser({close: 'hang', proc});
    const started = Date.now();
    await assert.rejects(
      within(withProofPage(async () => 'green', {serve, launch: async () => browser, closeTimeoutMs: 300}), 5000, 'the helper did not bound browser.close()'),
      (e) => e instanceof BrowserLifecycleError && /browser\.close\(\) did not resolve within 300 ms; the Chrome process group was SIGKILLed/.test(e.message),
    );
    assert.ok(Date.now() - started < 5000, 'the bound, not the hang, decided the outcome');
    assert.deepEqual(await exited, {code: null, signal: 'SIGKILL'}, 'the stand-in Chrome process group was killed');
    await assertReleased(seen);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});

test('lifecycle: a green body returns its value and releases both resources', async () => {
  const {seen, serve} = capturingServe();
  const browser = fakeBrowser();
  assert.equal(await withProofPage(async ({page, port, server}) => {
    assert.ok(page && port > 0 && server === seen.server, 'the body sees the page, the port and the server');
    return 'value';
  }, {serve, launch: async () => browser}), 'value');
  assert.equal(browser.closeCalls, 1);
  await assertReleased(seen);
});

// THE REAL CONTROL (the CI failure of 2026-09-03, PR #59): a Chrome executable
// that answers --version but never publishes its DevTools endpoint makes the
// REAL puppeteer launch time out with "Timed out after N ms while waiting for
// the WS endpoint URL to appear in stdout!". Before the helper, that failure
// leaked the listening server and the worker never exited. Now the helper must
// reject with that error, the server must be released, and the child process
// running it must exit ON ITS OWN -- no --test-force-exit anywhere.
test('control: a real puppeteer launch timeout releases the server and lets the process exit by itself', {skip: process.platform !== 'linux' && 'linux-only fake executable'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proof-lane-'));
  try {
    const fakeChrome = join(dir, 'fake-chrome');
    await writeFile(fakeChrome, '#!/bin/sh\ncase " $* " in *" --version "*) echo "Google Chrome 140.0.0.0"; exit 0;; esac\nexec sleep 300\n');
    await chmod(fakeChrome, 0o755);
    const helperUrl = pathToFileURL(join(REPO_ROOT, 'test', 'browser', 'support', 'proof-lane.js')).href;
    const script = `
      const {withProofPage, serveRepo} = await import(${JSON.stringify(helperUrl)});
      const net = await import('node:net');
      let seen = null;
      const serve = async () => { const r = await serveRepo(); seen = r; return r; };
      let message = null;
      try { await withProofPage(async () => 'never', {serve, launchTimeoutMs: 1500}); } catch (e) { message = e.message; }
      const probe = await new Promise((resolve) => {
        const s = net.connect(seen.port, '127.0.0.1');
        s.once('error', (e) => resolve(e.code)); s.once('connect', () => { s.destroy(); resolve('CONNECTED'); });
      });
      process.stdout.write(JSON.stringify({message, listening: seen.server.listening, probe}));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT, env: {...process.env, CHROME_PATH: fakeChrome}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({code: null, signal: 'TIMEOUT'}); }, 15000);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({code, signal}); });
    });
    assert.deepEqual(exit, {code: 0, signal: null}, `the child exited by itself (a leaked handle would have kept it alive)\nstderr: ${stderr}`);
    const report = JSON.parse(stdout);
    assert.match(report.message, /Timed out after 1500 ms while waiting for the WS endpoint URL/, 'the real puppeteer launch failure surfaced unchanged');
    assert.equal(report.listening, false, 'the server was released on the launch-failure path');
    assert.equal(report.probe, 'ECONNREFUSED');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
