import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// The DOM + Component COEXISTENCE proof (Bead 9vl): DOM tool realizations
// (navigator/inspector) + a real GLB Component view behind ONE
// BrowserRendererAdapter, via the INJECTED realization-dispatch seam (not a
// hard-coded kind switch). Runs under Xvfb/headless SwiftShader.

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

async function launch() {
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

test('CI: DOM tool realizations + a GLB Component coexist behind one adapter (injected dispatch seam)', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launch();
  try {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCoexistenceSession();
      // GLB Component renders pixels (TextureRenderTarget read-back).
      const glbFrame = await S.readGlb();
      const glbMesh = (() => {
        if (!glbFrame) return 0;
        let mesh = 0;
        const {data, width, height, bytesPerRow} = glbFrame;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = y * bytesPerRow + x * 4;
            if (data[i] > 40 && data[i + 1] > 35 && data[i + 2] < data[i] - 15) mesh += 1;
          }
        }
        return mesh;
      })();
      // DOM panes: navigator shows its reference buttons; inspector shows fields.
      const toolRoots = S.toolRoots().map((n) => n.className);
      const refButtons = S.referenceButtons().map((b) => b.textContent);
      // Activate ref-row 0 (obj-b): the DOM emits a descriptor-local item key.
      const intents = [];
      S.onIntent((intent, handle) => intents.push(intent));
      S.referenceButtons()[0].click();
      return {glbMesh, glbOk: Boolean(glbFrame), toolRoots, refButtons, intents};
    });

    // The GLB Component still renders (coexistence with the DOM panes).
    assert.ok(result.glbOk, 'the GLB Component renders a frame behind the same adapter');
    assert.ok(result.glbMesh > 320 * 200 * 0.02, `GLB mesh pixels present (coexisting with DOM), got ${result.glbMesh}`);
    // The DOM panes realized (navigator + inspector).
    assert.ok(result.toolRoots.some((c) => c.includes('lagrange-tool-navigator')), 'navigator DOM pane realized');
    assert.ok(result.toolRoots.some((c) => c.includes('lagrange-tool-inspector')), 'inspector DOM pane realized');
    // The navigator's reference rows are native buttons labeled by objectId.
    assert.deepEqual(result.refButtons, ['obj-b', 'obj-c'], 'navigator reference rows rendered as native buttons');
    // Activating row 0 emits a DESCRIPTOR-LOCAL item key (never a ref).
    assert.equal(result.intents.length, 1, 'one intent from the click');
    assert.deepEqual(result.intents[0], {kind: 'activate-item', key: 0}, 'DOM emits a descriptor-local item key, not a ref');
    assert.ok(!('ref' in result.intents[0]) && !('subject' in result.intents[0]), 'no ref/subject leaks into the intent');
  } finally {
    await browser.close();
    server.close();
  }
});

// F3: the PRODUCTION DOM edit path — the real adapter's DOM realizer builds the
// inspector <input>, and Enter commits through the adapter's REAL emitIntent
// seam (not a test-harness copy of the intent literal).
test('CI: the production DOM edit path emits a raw-string edit-field intent through the real adapter seam', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launch();
  try {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCoexistenceSession();
      const intents = [];
      S.onIntent((intent) => intents.push(intent));
      // The inspector's writable slot-title is an <input>; slot-count is not.
      const inputs = S.inspectorFieldInputs();
      const inputValues = inputs.map((i) => i.value);
      if (inputs[0]) {
        inputs[0].value = 'Root-edited';
        inputs[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      }
      await S.destroyAll();
      return {inputValues, intents};
    });
    // Exactly one editable input (the writable slot-title, value 'Root').
    assert.deepEqual(result.inputValues, ['Root'], 'only the writable field renders an <input> in the real adapter');
    // Enter committed a RAW-STRING edit-field intent through the production seam.
    assert.deepEqual(result.intents, [{kind: 'edit-field', key: 0, text: 'Root-edited'}],
      'the production DOM realizer emits a raw-string edit-field intent via the adapter emitIntent seam');
  } finally {
    await browser.close();
    server.close();
  }
});

test('CI: the real navigator -> selection -> inspector loop drives through real DOM', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launch();
  try {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openDomLoopSession();
      const before = {subject: S.inspectorSubject(), selected: S.selected(), focused: S.focused()};
      // The navigator shows two reference rows (obj-b, obj-c) as native buttons.
      const buttons = S.navigatorButtons().map((b) => b.textContent);
      // Click the obj-b row in the REAL DOM -> activate-item -> selection -> inspector.
      S.navigatorButtons()[0].click();
      await new Promise((r) => setTimeout(r, 100));
      const after = {
        subject: S.inspectorSubject(), selected: S.selected(), focused: S.focused(),
        inspectorText: S.inspectorText(),
        inspectorFieldValues: S.inspectorFieldInputs().map((i) => i.value),
        inspectorNodeCount: document.querySelectorAll('#mount .lagrange-tool-inspector').length,
      };
      await S.destroyAll();
      return {buttons, before, after};
    });

    assert.deepEqual(result.buttons, ['obj-b', 'obj-c'], 'navigator reference rows are native DOM buttons');
    assert.equal(result.before.subject, 'obj-root', 'inspector starts on the root');
    assert.equal(result.before.selected, null, 'nothing selected before the click');
    // After clicking obj-b: selection = obj-b, focus = navigator-view, inspector = obj-b.
    assert.equal(result.after.selected, 'obj-b', 'DOM click -> selectionModel selects obj-b');
    assert.equal(result.after.focused, 'navigator-view', 'focus is the navigator pane (the user is interacting there)');
    assert.equal(result.after.subject, 'obj-b', 'the inspector re-presents the selected obj-b');
    // B's title is the EDITABLE <input> value (not in textContent); the
    // read-only count renders as text. Both prove the descriptor drove the DOM.
    assert.ok(result.after.inspectorFieldValues.includes('B'), 'the inspector DOM shows B\'s editable title input (the descriptor drove the DOM)');
    assert.ok(result.after.inspectorText.includes('17'), 'the inspector DOM shows B\'s read-only count as text');
    // presentOn detach DISPOSES the old inspector node (no lingering duplicate).
    assert.equal(result.after.inspectorNodeCount, 1, 'exactly one inspector DOM node after the presentOn swap (detach disposed the old one)');
  } finally {
    await browser.close();
    server.close();
  }
});

test('CI: the dispatch seam is INJECTED, not a hard-coded kind switch (sentinel realizer)', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launch();
  try {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openCoexistenceSession({sentinelNavigator: true});
      const glbFrame = await S.readGlb();
      const sentinelNode = document.getElementById('sentinel-navigator');
      const out = {
        sentinelUsed: S.sentinelUsed(),
        sentinelInDom: Boolean(sentinelNode),
        sentinelText: sentinelNode?.textContent ?? null,
        glbOk: Boolean(glbFrame),
      };
      await S.destroyAll();
      out.mountEmptyAfterDestroy = document.querySelectorAll('#mount canvas, #mount .lagrange-tool, #mount #sentinel-navigator').length === 0;
      return out;
    });
    // The injected sentinel realizer was ACTUALLY used for the navigator leaf
    // (a hard-coded kind switch would ignore it).
    assert.ok(result.sentinelUsed, 'the injected sentinel realizer was invoked for kind navigator');
    assert.ok(result.sentinelInDom, 'the sentinel DOM node is in the document (the seam honored the injection)');
    assert.equal(result.sentinelText, 'SENTINEL-NAVIGATOR-REALIZED');
    // The GLB Component still rendered (the sentinel only displaced the navigator).
    assert.ok(result.glbOk, 'GLB still renders while the navigator uses the sentinel realizer');
    // destroyAll tears down BOTH the canvas and the DOM/sentinel nodes.
    assert.ok(result.mountEmptyAfterDestroy, 'destroyAll disposes the Component canvas AND the DOM realizations');
  } finally {
    await browser.close();
    server.close();
  }
});

// L2 cross-host identity: the browser SemanticUi->DOM rendering path consumes
// the CHECKED-IN fixtures (the SAME bytes the Linux GTK realizer consumes).
// This also covers the unavailable/unauthorized kinds, which had NO DOM-level
// coverage before L2.
test('CI: the browser realizer renders the checked-in SemanticUi fixtures (all four kinds)', {skip: !available && 'no Chrome available'}, async () => {
  const {server, browser, page} = await launch();
  try {
    const result = await page.evaluate(async () => {
      const out = {};
      // navigator: heading + fields + reference buttons + activate-item intent.
      const nav = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/navigator.json', 'navigator');
      out.nav = {heading: nav.heading, fields: nav.fields, buttons: nav.buttons};
      nav.clickButton(1);
      out.navIntent = nav.takeIntents();
      nav.dispose();
      // inspector: heading + fields + one reference. The writable slot-title is
      // an editable <input> (the SAME fixture bytes the GTK realizer consumes);
      // slot-count is a read-only <dd>. Committing an edit emits a RAW-STRING
      // edit-field intent with the descriptor-local key — identical to GTK.
      const insp = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/inspector.json', 'inspector');
      out.insp = {heading: insp.heading, fields: insp.fields, fieldValues: insp.fieldValues, fieldInputs: insp.fieldInputs, buttons: insp.buttons};
      insp.clickButton(0);
      out.inspIntent = insp.takeIntents();
      insp.editField(0, 'B2');
      out.inspEditIntent = insp.takeIntents();
      insp.dispose();
      // The canonical cross-host intent fixture (the SAME bytes the GTK test
      // asserts its serialized intent against).
      out.canonicalEditIntent = await (await fetch('../fixtures/semantic-ui/edit-field-intent.json')).json();
      // unavailable + unauthorized: heading + an explicit reason line, no refs.
      const un = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/unavailable.json', 'unavailable-reference');
      out.unavailable = {heading: un.heading, reason: un.reason, buttons: un.buttons};
      un.dispose();
      const unauth = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/unauthorized.json', 'unauthorized-reference');
      out.unauthorized = {heading: unauth.heading, reason: unauth.reason, buttons: unauth.buttons};
      unauth.dispose();
      return out;
    });

    // navigator
    assert.equal(result.nav.heading, 'Navigator: obj-root');
    assert.deepEqual(result.nav.fields, ['slot-title']);
    assert.deepEqual(result.nav.buttons, ['obj-b', 'obj-c']);
    assert.deepEqual(result.navIntent, [{kind: 'activate-item', key: 1}], 'navigator click emits the descriptor-local key, no ref');
    // inspector (field value normalization: int Value -> "17")
    assert.equal(result.insp.heading, 'Inspector: obj-b');
    assert.deepEqual(result.insp.fields, ['slot-title', 'slot-count']);
    assert.deepEqual(result.insp.fieldValues, ['B', '17']);
    assert.deepEqual(result.insp.buttons, ['obj-c']);
    assert.deepEqual(result.inspIntent, [{kind: 'activate-item', key: 0}]);
    // S3: exactly one editable input (the writable slot-title); slot-count is a
    // read-only <dd>. Enter commits a RAW-STRING edit-field intent — identical
    // shape to the GTK GtkEntry's intent (cross-host edit parity).
    assert.deepEqual(result.insp.fieldInputs, ['B'], 'only the writable field renders an <input>');
    assert.deepEqual(result.inspEditIntent, [{kind: 'edit-field', key: 0, text: 'B2'}],
      'Enter on the editable input emits a raw-string edit-field intent (descriptor-local key, no ref)');
    // CROSS-HOST INTENT BYTES (F2): the DOM edit intent deep-equals the SAME
    // canonical fixture the GTK test asserts its serialized intent against — one
    // source of truth for the intent shape/kind-string/key across both hosts.
    assert.deepEqual(result.inspEditIntent[0], result.canonicalEditIntent,
      'the DOM edit-field intent matches the canonical cross-host bytes (edit-field-intent.json)');
    // unavailable + unauthorized (the previously-uncovered kinds)
    assert.equal(result.unavailable.heading, 'unavailable-reference');
    assert.equal(result.unavailable.reason, 'Unavailable: obj-gone (not found)');
    assert.deepEqual(result.unavailable.buttons, []);
    assert.equal(result.unauthorized.heading, 'unauthorized-reference');
    assert.equal(result.unauthorized.reason, 'Not authorized: obj-secret (denied)');
    assert.deepEqual(result.unauthorized.buttons, []);
  } finally {
    await browser.close();
    server.close();
  }
});
