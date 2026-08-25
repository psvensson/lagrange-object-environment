import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The PR B CI browser proof — runs under Xvfb/headless SwiftShader (NO hardware
// GPU, NO display compositor required) and is the GATING automated proof.
//
// It drives the REAL triangle Component through its EXACT pinned WIT imports,
// the jco transpilation, and the real wasi-gfx-shim WebGPU mapping, into a
// host-owned TextureRenderTarget, and positively verifies the rendered triangle
// pixels via copyTextureToBuffer. The Component is unaware it is not rendering
// to a screen — the render-target realization is a host-side detail.
//
// It also exercises the real CanvasRenderTarget lifecycle (two independent
// surfaces, resize independence, teardown/recreate) WITHOUT reading canvas
// pixels, because reading back an on-screen canvas's WebGPU texture crashes
// Chrome+SwiftShader under Xvfb/headless (a recorded environment limitation,
// not an implementation bug). The full canvas PIXEL proof is retained as a
// manual real-display integration test (browser-proof.canvas.manual.test.js).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
};

async function chromeAvailable() {
  try {
    await promisify(execFile)(CHROME, ['--version']);
    return true;
  } catch {
    return false;
  }
}

function serveRepo() {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' ? '/test/browser/proof.html' : new URL(req.url, 'http://x').pathname;
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

const available = await chromeAvailable();
const puppeteer = available ? (await import('puppeteer-core')).default : null;

const CHROME_FLAGS = [
  '--no-sandbox', '--enable-blink-features=WebGPU', '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader', '--window-size=1000,900',
];

// The triangle covers roughly the central half of the frame; require a
// comfortably positive fraction of strongly-red pixels (SwiftShader-tolerant,
// never exact). This is a discriminating assertion: it goes red if the
// Component does not actually draw.
function assertTriangle(frame, label) {
  assert.ok(frame, `${label}: read-back returned no frame (not rendering)`);
  assert.ok(
    frame.red > frame.width * frame.height * 0.1,
    `${label} should render a red triangle (red ${frame.red}/${frame.width * frame.height})`,
  );
}

async function launchPage() {
  const {server, port} = await serveRepo();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args: CHROME_FLAGS,
    env: {...process.env, DISPLAY: process.env.DISPLAY ?? ':0'},
  });
  const page = await browser.newPage();
  await page.setViewport({width: 1000, height: 900});
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/test/browser/proof.html`, {waitUntil: 'networkidle0'});
  await page.waitForFunction('window.__lagrangeProof !== undefined', {timeout: 15000});
  return {server, browser, page};
}

test('CI: real Component renders triangle pixels into a TextureRenderTarget', {skip: !available && 'no Chrome available'}, async (t) => {
  const {server, browser, page} = await launchPage();
  try {
    const gpuInfo = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a?.info ? {vendor: a.info.vendor, architecture: a.info.architecture} : null;
    });
    t.diagnostic(`WebGPU adapter: ${JSON.stringify(gpuInfo)} (software expected; hardware never claimed)`);

    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openTextureSession();
      const {a, b} = await S.openTwo();
      const frameA = await S.readRendered(a);
      const frameB = await S.readRendered(b);
      // Resize A -> A tracks the new size, B is unchanged.
      await S.resize(a, 480, 300);
      const frameAResized = await S.readRendered(a);
      const frameBAfter = await S.readRendered(b);
      await S.destroyAll();
      return {frameA, frameB, frameAResized, frameBAfter};
    });

    assertTriangle(result.frameA, 'texture view A');
    assertTriangle(result.frameB, 'texture view B');
    assert.equal(result.frameAResized.width, 480, 'resized A width');
    assert.equal(result.frameAResized.height, 300, 'resized A height');
    assertTriangle(result.frameAResized, 'texture view A after resize');
    assert.equal(result.frameBAfter.width, 640, 'B width unchanged by resizing A');
    assertTriangle(result.frameBAfter, 'texture view B after resizing A');
  } finally {
    await browser.close();
    server.close();
  }
});

test('CI: CanvasRenderTarget lifecycle — two surfaces, resize independence, teardown/recreate', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launchPage();
  try {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCanvasSession();
      const {a, b} = await S.openTwo();
      const twoCanvases = window.__lagrangeProof.canvases().length;

      // Resize A -> A's canvas tracks it, B's canvas is unchanged.
      await S.resize(a, 480, 300);
      const dims = window.__lagrangeProof.canvases().map((c) => ({width: c.width, height: c.height}));

      // Destroy A -> only A's canvas is gone; B survives.
      await S.destroyView(a);
      const afterDestroyA = window.__lagrangeProof.canvases().length;

      // Session teardown removes every canvas.
      await S.destroyAll();
      const afterDestroyAll = window.__lagrangeProof.canvases().length;

      // A fresh Session over the same durable intent recreates the view.
      await S.recreateSession(320, 200);
      const afterRecreate = window.__lagrangeProof.canvases().length;

      return {twoCanvases, dims, afterDestroyA, afterDestroyAll, afterRecreate};
    });

    assert.equal(result.twoCanvases, 2, 'two independent surfaces produce two canvases');
    assert.deepEqual(result.dims[0], {width: 480, height: 300}, 'resize A applied per-view');
    assert.deepEqual(result.dims[1], {width: 640, height: 400}, 'resize A must not affect B');
    assert.equal(result.afterDestroyA, 1, 'destroying A removes only A');
    assert.equal(result.afterDestroyAll, 0, 'Session teardown must remove all canvases');
    assert.equal(result.afterRecreate, 1, 'a fresh Session recreates the render view');
  } finally {
    await browser.close();
    server.close();
  }
});
