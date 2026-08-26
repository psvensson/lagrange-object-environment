import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The PR D BROWSER half (Bead lagrange-object-environment-nlg): a synthetic-
// injected pointer event on a Component-backed view drives the SAME input
// stream + intent-resolution path a real DOM pointer event would, delivering a
// SEMANTIC INTENT DESCRIPTOR ({kind:'activate'}, no subject) to the host's
// intent consumers. This is the input -> intent half of the semantic-
// interaction route; the intent -> Command -> authorized mutation half is the
// Node integration proof (command-router.integration.test.js). The seam between
// them is one consumeIntent call.
//
// Runs under Xvfb/headless SwiftShader on the TextureRenderTarget path (no
// mounted canvas), proving the synthetic-injection seam is honest — it reaches
// the same intent resolution a DOM event would.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
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

test('CI: synthetic pointer event on a Component view resolves a semantic intent (no subject)', {skip: !available && 'no Chrome available'}, async (t) => {
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

    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openGlbSession();
      const handle = await S.open(320, 200);

      // Register an intent consumer on the adapter; inject a pointer-down on
      // the view's surface; the consumer must receive {kind:'activate'} bound
      // to THIS handle (and never a subject).
      const received = [];
      const unsubscribe = S.adapter.onIntent((intent, h) => received.push({intent, handle: h}));
      await S.adapter.injectPointerEvent(handle, {type: 'pointer-down', x: 160, y: 100, button: 0});
      await S.adapter.injectPointerEvent(handle, {type: 'pointer-up', x: 160, y: 100, button: 0});
      unsubscribe();
      await S.destroyAll();
      return {received, handle};
    });

    assert.equal(result.received.length, 1, 'pointer-down resolves exactly one intent (pointer-up does not)');
    assert.deepEqual(result.received[0].intent, {kind: 'activate'}, 'the intent is a semantic descriptor, not a pixel coordinate');
    assert.equal(result.received[0].handle, result.handle, 'the intent is bound to the interacting view handle');
    assert.ok(!('subject' in result.received[0].intent), 'the intent carries NO subject (the CommandRouter resolves it)');
  } finally {
    await browser.close();
    server.close();
  }
});
