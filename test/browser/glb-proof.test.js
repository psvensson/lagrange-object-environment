import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The PR C CI browser proof — runs under Xvfb/headless SwiftShader (NO hardware
// GPU, NO display compositor) and is the GATING automated proof for the GLB
// renderer.
//
// It drives the REAL GLB renderer Component through its exact pinned WIT
// imports — including the NEW lagrange:assets/provider@0.1.0 import, so the
// durable Box.glb bytes cross the host -> Component boundary at runtime — into
// a host-owned TextureRenderTarget, and verifies:
//   (b) the shaded Box renders (pixel coverage in a discriminating band,
//       distinct from the exact clear color);
//   (c) the per-frame camera uniform (writeBufferWithCopy) auto-orbits: pixels
//       differ across frame indices AND each frame stays a coherent render;
//   (d) Session destroy/recreate re-injects the bytes and re-renders (proves
//       the asset flows per-attach, not from ambient page state);
//   (f) negative: an attach whose byte source lacks the asset fails to render.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
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

// The renderer clears to a dark blue-ish (0.05,0.05,0.08) and shades the Box
// yellow-ish (r&g clearly > b, brighter than the clear). A coherent render has
// a band of these bright, yellow-tinted mesh pixels. A FAILED render (e.g. the
// negative missing-asset case) leaves the texture black/empty — which has NONE
// of these, so this predicate discriminates a real Box from both the clear AND
// from a blank/black frame.
function meshPixels(frame) {
  let mesh = 0;
  const {data, width, height, bytesPerRow} = frame;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * bytesPerRow + x * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      // Shaded mesh: meaningfully bright, and yellow-tinted (b stays low).
      if (r > 40 && g > 35 && b < r - 15) mesh += 1;
    }
  }
  return mesh;
}

function assertMesh(frame, label) {
  assert.ok(frame, `${label}: read-back returned no frame (not rendering)`);
  const mesh = meshPixels(frame);
  const total = frame.width * frame.height;
  assert.ok(
    mesh > total * 0.02 && mesh < total * 0.8,
    `${label} should render a shaded Box (mesh ${mesh}/${total} = ${(mesh / total).toFixed(3)}, want 0.02..0.8)`,
  );
  return mesh;
}

test('CI: GLB Component renders a shaded Box (asset transfer + buffers + depth + camera)', {skip: !available && 'no Chrome available'}, async (t) => {
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

    // (b) the Box renders; (c) the camera orbits across frames.
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openGlbSession();
      const h = await S.open(320, 200);
      const frame1 = await S.readRendered(h);
      // Advance several frames so the auto-orbit camera moves, then read again.
      for (let i = 0; i < 30; i += 1) await new Promise((r) => requestAnimationFrame(r));
      const frame2 = await S.readRendered(h);
      // Return only what the assertions need (raw data is large).
      return {
        frame1, frame2,
        // A per-pixel diff count to prove the camera moved the mesh.
        diff: (() => {
          let d = 0;
          const a = frame1.data, b = frame2.data, bpr = frame1.bytesPerRow;
          for (let y = 0; y < frame1.height; y += 1) {
            for (let x = 0; x < frame1.width; x += 1) {
              const i = y * bpr + x * 4;
              if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) d += 1;
            }
          }
          return d;
        })(),
      };
    });

    assertMesh(result.frame1, 'GLB Box frame 1');
    assertMesh(result.frame2, 'GLB Box frame 2 (after camera orbit)');
    // (c) the camera moved the mesh: a meaningful fraction of pixels changed.
    const total = result.frame1.width * result.frame1.height;
    assert.ok(
      result.diff > total * 0.01,
      `the per-frame camera uniform should move the mesh (diff ${result.diff}/${total}, want >1%)`,
    );

    // (d) Session destroy/recreate re-injects the bytes and re-renders.
    const recreated = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openGlbSession();
      const h = await S.recreateSession(320, 200); // destroyAll + fresh adapter re-injects
      return {frame: await S.readRendered(h), h};
    });
    assertMesh(recreated.frame, 'GLB Box after Session recreate (bytes re-injected)');

    // (f) negative: an attach whose byte source lacks the asset must not render.
    const negative = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openGlbSession();
      const {handle, adapter} = await S.openMissingAsset(320, 200);
      return adapter.readRenderedPixels(handle);
    });
    const negMesh = negative ? meshPixels(negative) : 0;
    assert.ok(
      negMesh < 320 * 200 * 0.02,
      `a missing asset must not render the Box (mesh ${negMesh}, want ~0)`,
    );
  } finally {
    await browser.close();
    server.close();
  }
});

// Bead 0dm: per-instance asset isolation. TWO simultaneous GLB views each load
// 'main-model' but with DIFFERENT bytes (small vs big Box). Per-instance import
// closures (jco instantiation mode) mean A renders its small Box, B renders its
// big Box, and A STILL renders its small Box AFTER B is instantiated — the
// critical falsifier against a shared/clobbered provider.
test('CI: per-instance asset isolation — A and B render their own bytes; A unaffected by B', {skip: !available && 'no Chrome available'}, async (t) => {
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

    const r = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openTwoIsolatedGlbSessions(320, 200);
      return {frameA1: S.frameA1, frameA2: S.frameA2, frameB: S.frameB};
    });

    const meshA1 = assertMesh(r.frameA1, 'A (small Box) before B');
    const meshA2 = assertMesh(r.frameA2, 'A (small Box) AFTER B instantiated');
    const meshB = assertMesh(r.frameB, 'B (big Box)');

    // B's big Box covers a discriminatingly larger area than A's small Box.
    assert.ok(
      meshB > meshA1 * 1.3,
      `B (big Box, mesh ${meshB}) should cover clearly more than A (small Box, mesh ${meshA1}) — they resolved DIFFERENT bytes for 'main-model'`,
    );
    // A is unchanged by B's instantiation: A-after-B ≈ A-before-B (same bytes).
    // Allow drift for the auto-orbit camera (a rotating cube's silhouette varies
    // with angle), but A must NOT jump toward B's larger footprint. A clobbered
    // provider would push meshA2 ≈ meshB (|delta| ≈ meshB − meshA1), far above
    // this 0.75 bound; per-instance closures keep the delta to orbit drift only.
    assert.ok(
      Math.abs(meshA2 - meshA1) < (meshB - meshA1) * 0.75,
      `A AFTER B (mesh ${meshA2}) must stay near A BEFORE B (mesh ${meshA1}), NOT jump toward B's footprint (mesh ${meshB}) — proves A's provider was not clobbered by B`,
    );
  } finally {
    await browser.close();
    server.close();
  }
});
