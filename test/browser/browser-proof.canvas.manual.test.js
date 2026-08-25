import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The PR B CANVAS PIXEL proof — the real triangle Component rendering to a real
// on-screen <canvas> (CanvasRenderTarget), with pixels verified via the host
// read-back. This is the full end-to-end browser-presentation proof.
//
// It is a MANUAL / real-display integration test, NOT part of CI: reading back
// an on-screen canvas's WebGPU texture crashes Chrome+SwiftShader under
// Xvfb/headless (a recorded environment limitation, not an implementation bug).
// Run it on a machine with a real display:
//
//   DISPLAY=:0 npm run test:browser:canvas
//
// The gating automated proof (deterministic under Xvfb) is browser-proof.test.js,
// which verifies the same Component/WIT/shim path into a TextureRenderTarget.

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

test('manual (real display): Component renders triangle pixels to a real canvas', {skip: !available && 'no Chrome available'}, async (t) => {
  const {server, port} = await serveRepo();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, args: CHROME_FLAGS,
    env: {...process.env, DISPLAY: process.env.DISPLAY ?? ':0'},
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1000, height: 900});
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${port}/test/browser/proof.html`, {waitUntil: 'networkidle0'});
    await page.waitForFunction('window.__lagrangeProof !== undefined', {timeout: 15000});

    const gpuInfo = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a?.info ? {vendor: a.info.vendor, architecture: a.info.architecture} : null;
    });
    t.diagnostic(`WebGPU adapter: ${JSON.stringify(gpuInfo)} (software expected; hardware never claimed)`);

    // On a real display, the canvas's current texture CAN be read back via the
    // host hook. openCanvasSession exposes readRendered for this purpose.
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCanvasSession();
      const {a, b} = await S.openTwo();
      const frameA = await S.readRendered(a);
      const frameB = await S.readRendered(b);
      await S.destroyAll();
      return {frameA, frameB};
    });

    for (const [label, frame] of [['canvas view A', result.frameA], ['canvas view B', result.frameB]]) {
      assert.ok(frame, `${label}: read-back returned no frame (canvas read-back needs a real display)`);
      assert.ok(
        frame.red > frame.width * frame.height * 0.1,
        `${label} should render a red triangle (red ${frame.red}/${frame.width * frame.height})`,
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
});
