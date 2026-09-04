import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The browser proof lane's ONE execution-lifecycle owner (Bead vbe).
//
// Every CI browser proof (test/browser/*.test.js) drives a real Chromium +
// SwiftShader through a local HTTP server. Before this helper each file
// created its server (and two of them the browser + page) BEFORE the `try`
// whose `finally` released them, so a launch/setup failure leaked a listening
// server; a leaked handle keeps the `node --test` worker alive forever, and the
// runner (which reports files in order) then prints nothing for every later
// file -- the 37-minute CI hang on PR #59. puppeteer's own `browser.close()`
// is also unbounded after a successful CDP Browser.close (it awaits process
// exit with no kill fallback), so a close that never resolves needs a bound
// here, not a longer wait.
//
// Contract of withProofPage(body):
//   serve -> launch -> page -> viewport -> pageerror log -> goto -> ready,
//   then body({page, browser, port, server}); THEN, unconditionally: the
//   browser is closed under a deadline (on expiry its process group is
//   SIGKILLed and a BrowserLifecycleError is raised) and the server is closed
//   in its own step so a browser-close failure can never leak it.
//   Nothing is swallowed: a body failure propagates unchanged (a cleanup
//   failure rides along as `cause`); a cleanup failure on a green body FAILS.
//   `--test-force-exit` is deliberately NOT used anywhere in the lane: a leak
//   must remain a red test, never a green one.
//
// `opts.launch` / `opts.serve` / `opts.launchTimeoutMs` / `opts.closeTimeoutMs`
// exist ONLY for the lifecycle proof (test/browser-proof-lane.test.js) to drive
// the failure paths without a display; the CI proofs call withProofPage with no
// options (fenced by test/ci-policy.test.js).

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
export const PROOF_PATH = '/test/browser/proof.html';
export const CLOSE_TIMEOUT_MS = 10_000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
};

export const CHROME_FLAGS = Object.freeze([
  '--no-sandbox', '--enable-blink-features=WebGPU', '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader', '--window-size=1000,900',
]);

export async function chromeAvailable(executable = CHROME) {
  try {
    await promisify(execFile)(executable, ['--version']);
    return true;
  } catch {
    return false;
  }
}

export const available = await chromeAvailable();
const puppeteer = available ? (await import('puppeteer-core')).default : null;

export function serveRepo() {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' ? PROOF_PATH : new URL(req.url, 'http://x').pathname;
      const file = join(REPO_ROOT, path);
      if (!file.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream'});
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port}));
  });
}

export class BrowserLifecycleError extends Error {
  constructor(message) { super(message); this.name = 'BrowserLifecycleError'; }
}

function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserLifecycleError(`${what} did not resolve within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Chrome is spawned detached (its own process-group leader), so killing the
// group reaches every Chrome child and nothing else. Guard against a reaped
// (and possibly recycled) pid exactly as puppeteer does.
export function killBrowserProcessGroup(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return false;
  try { process.kill(-proc.pid, 'SIGKILL'); return true; } catch { /* no such group: fall through */ }
  try { proc.kill('SIGKILL'); return true; } catch { return false; }
}

async function closeBrowserBounded(browser, ms) {
  const closing = browser.close();
  closing.catch(() => {}); // a late rejection after the deadline must not become an unhandled rejection
  try {
    await withDeadline(closing, ms, 'browser.close()');
  } catch (error) {
    if (error instanceof BrowserLifecycleError) {
      const killed = killBrowserProcessGroup(browser.process?.());
      error.message += killed ? '; the Chrome process group was SIGKILLed' : '; no live Chrome process was left to kill';
    }
    throw error;
  }
}

async function closeServerBounded(server, ms) {
  const closed = new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  server.closeAllConnections?.();
  await withDeadline(closed, ms, 'server.close()');
}

export async function withProofPage(body, opts = {}) {
  const serve = opts.serve ?? serveRepo;
  const launch = opts.launch ?? ((options) => puppeteer.launch(options));
  const closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const launchOptions = {
    executablePath: CHROME, headless: false, args: [...CHROME_FLAGS],
    env: {...process.env, DISPLAY: process.env.DISPLAY ?? ':0'},
    ...(opts.launchTimeoutMs === undefined ? {} : {timeout: opts.launchTimeoutMs}),
  };
  let server = null;
  let browser = null;
  let bodyError = null;
  let result;
  try {
    let port;
    ({server, port} = await serve());
    browser = await launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({width: 1000, height: 900});
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${port}${PROOF_PATH}`, {waitUntil: 'networkidle0'});
    await page.waitForFunction('window.__lagrangeProof !== undefined', {timeout: 15000});
    result = await body({page, browser, port, server});
  } catch (error) {
    bodyError = error;
  }
  const cleanupErrors = [];
  if (browser) {
    try { await closeBrowserBounded(browser, closeTimeoutMs); } catch (error) { cleanupErrors.push(error); }
  }
  if (server) {
    try { await closeServerBounded(server, closeTimeoutMs); } catch (error) { cleanupErrors.push(error); }
  }
  for (const error of cleanupErrors) console.error('[proof-lane cleanup]', error.message);
  const cleanupError = cleanupErrors.length === 0 ? null
    : cleanupErrors.length === 1 ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'proof-lane cleanup failed more than once');
  if (bodyError) {
    if (cleanupError && bodyError instanceof Object && bodyError.cause === undefined) bodyError.cause = cleanupError;
    throw bodyError;
  }
  if (cleanupError) throw cleanupError;
  return result;
}
