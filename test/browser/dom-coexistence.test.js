import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {available, withProofPage} from './support/proof-lane.js';

// The DOM + Component COEXISTENCE proof (Bead 9vl): DOM tool realizations
// (navigator/inspector) + a real GLB Component view behind ONE
// BrowserRendererAdapter, via the INJECTED realization-dispatch seam (not a
// hard-coded kind switch). Runs under Xvfb/headless SwiftShader.

// T4 visual materialization: the SAME resolved semantic token fixtures are
// consumed by browser and GTK. This is the PRODUCTION browser adapter path,
// not simply a style-function unit test or a hand-built themed fixture.
test('CI: two resolved Themes style independent DOM panes and never style an unthemed pane', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const result = await page.evaluate(() => window.__lagrangeProof.compareThemedToolRealizations());
    const [stock, derived, plain] = result.before;
    assert.equal(stock.themed, true);
    assert.equal(derived.themed, true);
    assert.equal(plain.themed, false);
    assert.deepEqual([stock.baseVariable, derived.baseVariable, plain.baseVariable],
      ['#e6e6e2', '#121922', '']);
    assert.deepEqual([stock.accentVariable, derived.accentVariable, plain.accentVariable],
      ['#245a81', '#ac4f81', '']);
    assert.deepEqual([stock.background, derived.background], ['rgb(230, 230, 226)', 'rgb(18, 25, 34)']);
    assert.deepEqual([stock.foreground, derived.foreground], ['rgb(28, 36, 40)', 'rgb(240, 243, 247)']);
    assert.deepEqual([stock.fontSize, derived.fontSize], ['13px', '16px']);
    assert.deepEqual([stock.padding, derived.padding], ['6px', '12px']);
    assert.deepEqual([stock.buttonBackground, derived.buttonBackground],
      ['rgb(245, 245, 240)', 'rgb(37, 50, 66)']);
    assert.deepEqual([stock.buttonColor, derived.buttonColor],
      ['rgb(36, 90, 129)', 'rgb(172, 79, 129)']);
    assert.equal(stock.hasStyleElement, 1);
    assert.equal(derived.hasStyleElement, 1);
    assert.equal(plain.hasStyleElement, 0, 'the unthemed pane obtains no implicit CSS Theme');
    assert.deepEqual(result.intents, [[], [{kind: 'activate-item', key: 0}], []],
      'styling must never change the ordinary descriptor-local Command intent');
    assert.equal(result.afterFirstTeardown.aConnected, false);
    assert.equal(result.afterFirstTeardown.bConnected, true);
    assert.deepEqual(result.afterFirstTeardown.b, derived,
      'destroying a differently themed pane cannot reset another pane style');
    assert.deepEqual(result.afterFirstTeardown.c, plain);
  });
});

function assertThemePanePreserved(sample) {
  for (const property of ['connected', 'samePane', 'sameInput', 'focused', 'logicalFocus', 'samePresentation', 'sameHandle']) {
    assert.equal(sample[property], true, 'Session Theme update preserves ' + property);
  }
  assert.equal(sample.typed, 'typed and retained');
}

function assertThemeCompositionRetired(result) {
  assert.equal(result.destroyIsClose, true, 'the published Compositor destroy is the lifecycle close');
  assert.equal(result.singleFlight, true, 'concurrent and repeated facade shutdown share the same Promise');
  assert.equal(result.postCloseOpenRejected, true, 'same-turn post-close opening rejects through canonical admission');
  assert.equal(result.postClosePresentRejected, true, 'same-turn post-close presentation rejects through canonical admission');
  assert.equal(result.postCloseFocusRejected, true, 'same-turn post-close focus rejects through canonical admission');
  assert.deepEqual(result.rendererCallsAfterClose, ['destroyAll'],
    'no post-close createSurface, detachPresentation or attachPresentation may reach the actual adapter');
  assert.equal(result.destructionSawRetiredFollow, true, 'actual renderer destruction waits for follow retirement');
  assert.equal(result.observationAborted, true, 'facade shutdown aborts the canonical follow');
  assert.equal(result.iteratorReturned, true);
  assert.equal(result.disconnected, true, 'facade shutdown destroys the actual DOM pane');
  assert.equal(result.viewRetired, true);
  assert.equal(result.mountEmpty, true, 'post-close requests cannot mount another pane');
  assert.equal(result.lateViewStatus, null, 'post-close opening cannot reinsert a lost view after teardown');
  assert.deepEqual(result.durableIntentAfterClose, [], 'all requests have settled with no resurrected durable intent');
  assert.equal(result.noReadsAfterClose, true, 'a late event cannot issue another Theme read');
  assert.deepEqual(result.sessionState, {selection: 'retained'});
  assert.equal(result.sessionPerspective, null);
  assert.deepEqual(result.rendererOperations,
    ['createSurface', 'attachPresentation', 'detachPresentation', 'resize', 'destroySurface', 'destroyAll'],
    'Session styling does not add a seventh renderer lifecycle operation');
}

test('CI: public Session Theme lifecycle preserves a real semantic pane through refresh and failure withdrawal', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const r = await page.evaluate(() => window.__lagrangeProof.observeAndRecolorLiveDom());
    assert.equal(r.before.background, 'rgb(230, 230, 226)');
    assert.equal(r.after.background, 'rgb(18, 25, 34)',
      'changed DesignToken must be reread, resolved, then rendered without reattach');
    assert.deepEqual([r.before.base, r.after.base], ['#e6e6e2', '#121922']);
    assert.deepEqual([r.before.styleCount, r.after.styleCount], [1, 1]);
    assertThemePanePreserved(r.before);
    assertThemePanePreserved(r.after);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'ThemeResolutionError');
    assert.match(r.errors[0].message, /Theme color requires lowercase opaque/);
    assert.equal(r.terminalStatus, 'rejected');
    assert.equal(r.reportedFailureMatchesDone, true);
    assert.equal(r.afterError.themed, false, 'failed following withdraws styling without choosing a fallback');
    assert.equal(r.afterError.styleCount, 0);
    assert.equal(r.afterError.base, '');
    assertThemePanePreserved(r.afterError);
    assert.equal(r.closeStatus, 'rejected');
    assert.equal(r.sameFailureOnClose, true, 'complete teardown still reports the recorded Theme failure');
    assertThemeCompositionRetired(r);
  });
});

test('CI: published Compositor destruction retires an active Session Theme follow and the actual DOM pane', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const r = await page.evaluate(() => window.__lagrangeProof.observeAndRecolorLiveDom({failTheme: false}));
    assert.equal(r.after.background, 'rgb(18, 25, 34)');
    assertThemePanePreserved(r.after);
    assert.equal(r.afterError, null);
    assert.deepEqual(r.errors, []);
    assert.equal(r.activeBeforeClose, true, 'the healthy follow must remain active until facade shutdown');
    assert.equal(r.pendingEventBeforeClose, true, 'close wins over an outstanding observation next()');
    assert.equal(r.terminalStatus, 'fulfilled');
    assert.equal(r.closeStatus, 'fulfilled');
    assertThemeCompositionRetired(r);
  });
});

test('CI: live resolved Theme updates change computed DOM style without replacing controls or intents', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const r = await page.evaluate(() => window.__lagrangeProof.updateLiveThemeOnRealDom());
    assert.equal(r.before.themed, true);
    assert.deepEqual([r.before.base, r.before.background, r.before.foreground, r.before.fontSize],
      ['#e6e6e2', 'rgb(230, 230, 226)', 'rgb(28, 36, 40)', '13px']);
    assert.deepEqual([r.after.base, r.after.background, r.after.foreground, r.after.fontSize],
      ['#121922', 'rgb(18, 25, 34)', 'rgb(240, 243, 247)', '16px']);
    assert.equal(r.stillSame, true, 'original DOM node, focused editable field and typed text survive');
    assert.deepEqual(r.idempotent, r.after, 'repeated delivery never stacks Theme style nodes');
    assert.equal(r.idempotent.styleCount, 1);
    assert.equal(r.rejectedInvalid, true, 'an incomplete Theme is rejected BEFORE changing style');
    assert.deepEqual(r.afterInvalid, r.after);
    assert.deepEqual(r.intents, [
      {intent: {kind: 'activate-item', key: 0}, handle: r.handle},
      {intent: {kind: 'edit-field', key: 0, text: 'Text typed during a Theme change'}, handle: r.handle},
    ], 'ordinary intent routing is identical before and after a live style change');
    assert.equal(r.cleared.themed, false, 'explicit no Theme unstyles rather than selecting stock');
    assert.equal(r.cleared.styleCount, 0);
    assert.equal(r.cleared.base, '');
    assert.equal(r.stillSameAfterClear, true);
    assert.deepEqual(r.restored, r.before, 'a re-authorized Theme can be applied to the SAME pane');
    assert.deepEqual(r.plainAfter, r.plainBefore, 'another adapter without Theme remains untouched');
    assert.equal(r.rejectedAfterDestroy, true, 'retired renderers cannot be styled');
  });
});

test('CI: DOM tool realizations + a GLB Component coexist behind one adapter (injected dispatch seam)', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
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
  });
});

// F3: the PRODUCTION DOM edit path — the real adapter's DOM realizer builds the
// inspector <input>, and Enter commits through the adapter's REAL emitIntent
// seam (not a test-harness copy of the intent literal).
test('CI: the production DOM edit path emits a raw-string edit-field intent through the real adapter seam', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
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
  });
});

test('CI: the real navigator -> selection -> inspector loop drives through real DOM', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
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
  });
});

test('CI: inspector references continue navigation through actual DOM actions', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
    const result = await page.evaluate(async () => {
      const S = await window.__lagrangeProof.openDomLoopSession();
      const waitForSubject = async (id) => {
        const deadline = Date.now() + 2000;
        while (S.inspectorSubject() !== id && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (S.inspectorSubject() !== id) throw new Error('navigation did not reach ' + id);
      };
      try {
        S.navigatorButtons()[0].click();
        await waitForSubject('obj-b');
        const labels = S.inspectorButtons().map((button) => button.textContent);
        const intents = [];
        S.onIntent((intent) => intents.push(intent));
        S.inspectorButtons()[0].click();
        await waitForSubject('obj-c');
        return {labels, intents, subject: S.inspectorSubject(), selected: S.selected(),
          focused: S.focused(), reads: S.navigationReads()};
      } finally {
        await S.destroyAll();
      }
    });
    assert.deepEqual(result.labels, ['obj-c']);
    assert.deepEqual(result.intents, [{kind: 'activate-item', key: 0}]);
    assert.equal(result.subject, 'obj-c');
    assert.equal(result.selected, 'obj-c');
    assert.equal(result.focused, 'inspector-view');
    assert.deepEqual(result.reads, ['obj-root', 'obj-b', 'obj-c']);
  });
});

test('CI: the dispatch seam is INJECTED, not a hard-coded kind switch (sentinel realizer)', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
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
  });
});

// L2 cross-host identity: the browser SemanticUi->DOM rendering path consumes
// the CHECKED-IN fixtures (the SAME bytes the Linux GTK realizer consumes).
// This also covers the unavailable/unauthorized kinds, which had NO DOM-level
// coverage before L2.
// The two PROJECTOR lanes bind their case lists to the fixture directory; the DOM
// realizer lane did not, which is exactly why a new green fixture could be added
// and silently never rendered in a browser. This closes that hole: the render test
// below must name every green fixture on disk.
test('CI: every green fixture is rendered by the browser realizer test', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const onDisk = (await readdir(join(here, '..', 'fixtures', 'semantic-ui'), {withFileTypes: true}))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    // No by-name exclusion: INTENT fixtures are a separate contract domain and
    // live in fixtures/semantic-ui/intents/, which this file-only walk never sees.
    ;
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const missing = onDisk.filter((name) => !source.includes(`../fixtures/semantic-ui/${name}`));
  assert.deepEqual(missing, [], 'every green fixture must be rendered through the real DOM realizer');
});

test('CI: the browser realizer renders the checked-in SemanticUi fixtures (every green fixture)', {skip: !available && 'no Chrome available'}, async () => {
  await withProofPage(async ({page}) => {
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
      out.canonicalEditIntent = await (await fetch('../fixtures/semantic-ui/intents/edit-field.json')).json();
      // SemanticUi/v2: the transient input. Realized as a genuinely multiline
      // <textarea> plus an EXPLICIT submit button — never the single-line
      // editable-field <input>, which would silently make a multiline value
      // impossible and would look like the field affordance it must not be.
      const v2 = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/v2-input.json', 'object');
      out.v2Input = {
        textareas: v2.inputTextareas,
        submitLabels: v2.inputSubmitLabels,
        fieldInputs: v2.fieldInputs,
      };
      // The canonical RAW multiline value: leading/trailing spaces, a tab, and a
      // TRAILING NEWLINE, each of which a trimming host would destroy.
      out.canonicalSubmitIntent = await (await fetch('../fixtures/semantic-ui/intents/submit-input-multiline.json')).json();
      out.canonicalSubmitEmpty = await (await fetch('../fixtures/semantic-ui/intents/submit-input-empty.json')).json();
      const reorder = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/v2-input-reorder.json', 'object');
      out.v2Reorder = {labels: reorder.inputLabels, keys: reorder.inputTextareas.map((t) => t.key)};
      reorder.submitInput(2, out.canonicalSubmitIntent.text);
      out.v2ReorderIntent = reorder.takeIntents();
      reorder.dispose();
      const v2empty = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/v2-input.json', 'object');
      v2empty.submitInput(0, '');
      out.v2EmptyIntent = v2empty.takeIntents();
      v2empty.dispose();
      v2.dispose();
      // project: canonical Project fields + stable member identity/role/target
      // display, with only a descriptor-local integer in the emitted intent.
      const project = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/project.json', 'project');
      out.project = {heading: project.heading, fields: project.fields, fieldValues: project.fieldValues, buttons: project.buttons};
      project.clickButton(1);
      out.projectIntent = project.takeIntents();
      project.dispose();
      // editable project (okv Slice C): the Name field is the ONLY <input>;
      // Enter emits the ORDINARY edit-field intent (the same bytes as GTK).
      const editableProject = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/project-editable.json', 'project');
      out.editableProject = {fields: editableProject.fields, fieldInputs: editableProject.fieldInputs, buttons: editableProject.buttons};
      editableProject.editField(0, 'New');
      out.editableProjectIntent = editableProject.takeIntents();
      editableProject.dispose();
      // native-class (Images ADR 0087): the authorized native Smalltalk class
      // description renders from the SAME fixture bytes the GTK realizer
      // consumes. Selectors and relations are ACTIONS carrying only a
      // descriptor-local key, drawn from ONE array across both visual groups.
      const nativeClass = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/native-class.json', 'native-class');
      out.nativeClass = {
        heading: nativeClass.heading,
        fields: nativeClass.fields,
        fieldValues: nativeClass.fieldValues,
        fieldInputs: nativeClass.fieldInputs,
        buttons: nativeClass.buttons,
        collectionRows: nativeClass.collectionRows,
        controls: nativeClass.controls,
      };
      // Click a SELECTOR row and a CLASS-LOCATOR row: both emit through the same
      // ordinary path, and the keys come from the one browser-owned array.
      nativeClass.clickButton(0);
      nativeClass.clickButton(2);
      out.nativeClassIntents = nativeClass.takeIntents();
      nativeClass.dispose();
      const retainedClass = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/native-class-retained.json', 'native-class');
      out.retainedClass = {fields: retainedClass.fields, fieldValues: retainedClass.fieldValues,
        fieldInputs: retainedClass.fieldInputs, controls: retainedClass.controls};
      retainedClass.dispose();
      // native-method (Images ADR 0087): the authorized METHOD description renders
      // from the SAME fixture bytes the GTK realizer consumes. source/provenance
      // rows are absent entirely, and Slice A ships no action here.
      const nativeMethod = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/native-method.json', 'native-method');
      out.nativeMethod = {
        heading: nativeMethod.heading,
        fields: nativeMethod.fields,
        fieldValues: nativeMethod.fieldValues,
        controls: nativeMethod.controls,
      };
      out.nativeMethodIntents = nativeMethod.takeIntents();
      nativeMethod.dispose();
      // E3 (Bead eij.3): the SAME method as the browser DISPLAYS it -- identical
      // Images description, plus the ONE transient replacement input. Same fields
      // as above, same absent Source/Provenance rows, and now a multiline
      // <textarea> with its own submit control. Proven from the SAME fixture bytes
      // the GTK realizer consumes, which is what "both hosts take the same route"
      // means for a production affordance.
      const editableMethod = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/native-method-editable.json', 'native-method');
      out.editableMethod = {
        heading: editableMethod.heading,
        fields: editableMethod.fields,
        fieldValues: editableMethod.fieldValues,
        controls: editableMethod.controls,
        textareas: editableMethod.inputTextareas,
        submitLabels: editableMethod.inputSubmitLabels,
        fieldInputs: editableMethod.fieldInputs,
      };
      editableMethod.submitInput(0, '[ ^42 ]');
      out.editableMethodIntents = editableMethod.takeIntents();
      editableMethod.dispose();
      const retainedMethod = await window.__lagrangeProof.renderSemanticUiFixture('../fixtures/semantic-ui/native-method-retained.json', 'native-method');
      out.retainedMethod = {
        fields: retainedMethod.fields, fieldValues: retainedMethod.fieldValues,
        sourceBlocks: retainedMethod.sourceBlocks, html: retainedMethod.html,
        textareas: retainedMethod.inputTextareas, fieldInputs: retainedMethod.fieldInputs,
        buttons: retainedMethod.buttons, controls: retainedMethod.controls,
      };
      // Same transient input binding as E3, independent of displayed source.
      retainedMethod.submitInput(0, 'replacement');
      out.retainedMethodIntents = retainedMethod.takeIntents();
      retainedMethod.dispose();
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
      'the DOM edit-field intent matches the canonical cross-host bytes (intents/edit-field.json)');
    // --- SemanticUi/v2: the transient input -------------------------------
    // A genuinely MULTILINE control. A regression to the single-line
    // editable-field <input> would fail here AND would silently truncate the
    // newline case below.
    assert.deepEqual(result.v2Input.textareas.map((t) => t.tag), ['textarea'],
      'a v2 input must realize as a multiline textarea, never the single-line field input');
    assert.deepEqual(result.v2Input.submitLabels, ['Replace'],
      'a v2 input carries an EXPLICIT submit control (Enter stays newline insertion)');
    assert.deepEqual(result.v2Input.textareas.map((t) => t.value), [''],
      'the input starts EMPTY: the document carries no value, and none may be invented');
    assert.deepEqual(result.v2Input.fieldInputs, [],
      'a v2 input must not also render an editable field');

    // CROSS-HOST INTENT BYTES: the DOM submit-input deep-equals the SAME
    // canonical fixture the native test asserts its serialized intent against.
    // The value carries leading/trailing spaces, a tab and a trailing newline —
    // RAW means no trimming, no parsing, no normalization.
    assert.deepEqual(result.v2ReorderIntent, [result.canonicalSubmitIntent],
      'the DOM submit-input intent matches the canonical cross-host bytes (intents/submit-input-multiline.json)');
    // An EMPTY submission still carries its text field: absent text is not an
    // empty value, it is a malformed intent.
    assert.deepEqual(result.v2EmptyIntent, [result.canonicalSubmitEmpty],
      'an empty submission must still carry text:"" (intents/submit-input-empty.json)');

    // KEY DERIVATION across the DOM boundary: the reorder fixture lists Gamma
    // first, so Gamma holds key 0. Submitting the THIRD control emitted key 2.
    assert.deepEqual(result.v2Reorder.labels, ['Gamma', 'Beta', 'Alpha']);
    assert.deepEqual(result.v2Reorder.keys, ['0', '1', '2'],
      'input keys follow ARRAY POSITION, never the entry content');

    // Project
    assert.equal(result.project.heading, 'Project: Alpha');
    assert.deepEqual(result.project.fields, ['Name', 'Project ID', 'Namespace']);
    assert.deepEqual(result.project.fieldValues, ['Alpha', 'project-alpha', '-> workspace']);
    assert.deepEqual(result.project.buttons, [
      'member/a [source] -> image-a/obj-a',
      'member/b [dependency] -> image-b/obj-b',
    ]);
    assert.deepEqual(result.projectIntent, [{kind: 'activate-item', key: 1}],
      'Project activation emits only its descriptor-local integer key');
    // Editable Project: only Name renders an <input>; its commit is the ordinary intent.
    assert.deepEqual(result.editableProject.fields, ['Name', 'Project ID', 'Namespace']);
    assert.deepEqual(result.editableProject.fieldInputs, ['Alpha'], 'only the Name field renders an <input>');
    assert.deepEqual(result.editableProjectIntent, [{kind: 'edit-field', key: 0, text: 'New'}],
      'Enter on the Name input emits the ordinary raw-string edit-field intent');
    // native-class: the class's own facts, and nothing activatable.
    assert.equal(result.nativeClass.heading, 'Class: BrowseChild');
    assert.deepEqual(result.nativeClass.fields, ['Name', 'Side', 'Class', 'Instance variables', 'Indexed']);
    assert.ok(result.nativeClass.fieldValues.includes('instance'), 'the kernel-decided side is displayed');
    assert.ok(result.nativeClass.fieldValues.includes('baseValue, childFirst'), 'declared layout NAMES are displayed');
    // The selector and locator ROWS are VISIBLE — the same information GTK shows
    // from the same bytes.
    assert.deepEqual(result.nativeClass.collectionRows, [
      // The class's OWN selector names (baseValue is an instance VARIABLE and
      // renders as a field, not a row), then both locators.
      'childFirst', 'childSecond',
      'superclass -> img/smalltalk/class/BrowseBase',
      'class-side -> img/smalltalk/metaclass/BrowseChild',
    ], 'own selector names and both locators are rendered as visible rows');
    // E2 (Bead gzz) makes them ACTIVATABLE: each row is a real button, and
    // clicking one emits the ordinary intent carrying ONLY its descriptor-local
    // key — the same bytes GTK emits for the same fixture. The E1 negative that
    // stood here (no operable control) inverts, but its point survives as the
    // payload assertion: a rendered row still discloses no semantic target.
    assert.deepEqual(result.nativeClass.buttons, [
      'childFirst', 'childSecond',
      'superclass -> img/smalltalk/class/BrowseBase',
      'class-side -> img/smalltalk/metaclass/BrowseChild',
    ], 'selectors and relations are activatable rows');
    assert.deepEqual(result.nativeClass.controls, ['button', 'button', 'button', 'button'],
      'exactly four operable controls, and nothing editable');
    assert.deepEqual(result.nativeClass.fieldInputs, [], 'E2 is navigation, not editing');
    // Clicking the FIRST row (a selector) and the THIRD (a class locator) emits
    // keys 0 and 2 — one key space across two visual groups.
    assert.deepEqual(result.nativeClassIntents, [{kind: 'activate-item', key: 0}, {kind: 'activate-item', key: 2}],
      'the DOM emits only descriptor-local integers, from ONE key space');

    // Images-owned retained metadata is now visible, but remains non-editable.
    assert.deepEqual(result.retainedClass.fields, ['Name', 'Side', 'Class', 'Layout', 'Category', 'File', 'Package']);
    assert.deepEqual(result.retainedClass.fieldValues.slice(-3), ['accessing', 'YAXO.pck.st', 'YAXO']);
    assert.deepEqual(result.retainedClass.fieldInputs, []);
    assert.deepEqual(result.retainedClass.controls, [], 'provenance never grants a control or authority');

    // native-method: only what Images owns, and the absent rows really absent.
    assert.equal(result.nativeMethod.heading, 'Method: childFirst');
    assert.deepEqual(result.nativeMethod.fields, ['Selector', 'Side', 'Declaring class', 'Method']);
    assert.ok(result.nativeMethod.fieldValues.includes('-> smalltalk/class/BrowseChild/method/Y2hpbGRGaXJzdA'),
      'the Images-owned Block identity is displayed -- the point of the second authorization');
    assert.equal(result.nativeMethod.fields.includes('Source'), false, 'a truthful absence is an omitted row');
    assert.equal(result.nativeMethod.fields.includes('Provenance'), false);
    assert.deepEqual(result.nativeMethod.controls, [], 'Slice A adds no operable control to a native method pane');
    assert.deepEqual(result.nativeMethodIntents, []);

    // E3 (Bead eij.3): the SAME method with its production replacement input.
    assert.equal(result.editableMethod.heading, 'Method: childFirst');
    assert.deepEqual(result.editableMethod.fields, ['Selector', 'Side', 'Declaring class', 'Method'],
      'the displayed method is unchanged: the affordance ADDS an input, it does not restate the record');
    assert.equal(result.editableMethod.fields.includes('Source'), false,
      'still a truthful absence: an input is not a field, and asserts no durable source exists');
    assert.deepEqual(result.editableMethod.fieldInputs, [],
      'the replacement input must NOT render as an editable field');
    assert.deepEqual(result.editableMethod.textareas.map((t) => t.tag), ['textarea'],
      'new source is multiline: a single-line input would make a real method body impossible');
    assert.deepEqual(result.editableMethod.textareas.map((t) => t.value), [''],
      'it starts EMPTY -- there is no current source to prefill, and inventing one would be a lie');
    assert.deepEqual(result.editableMethod.submitLabels, ['Replace']);
    assert.deepEqual(result.editableMethodIntents, [{kind: 'submit-input', key: 0, text: '[ ^42 ]'}],
      'the host emits the realized key and the RAW text, and names no Command, subject or method');

    // Retained source is a literal text node (not HTML, not a field edit and
    // not a replacement input's prefilling). Newlines and source operators survive.
    assert.deepEqual(result.retainedMethod.fields,
      ['Selector', 'Side', 'Declaring class', 'Method', 'Category', 'File', 'Package']);
    assert.deepEqual(result.retainedMethod.sourceBlocks,
      [{tag: 'pre', text: "childFirst\n  ^ '<tag> & data'\n", editable: false}]);
    assert.ok(result.retainedMethod.html.includes('&lt;tag&gt; &amp; data'),
      'source must become inert textContent, never executable markup');
    assert.deepEqual(result.retainedMethod.fieldInputs, []);
    assert.deepEqual(result.retainedMethod.textareas.map(t => t.value), [''],
      'retained source never prepopulates the independent replacement input');
    assert.deepEqual(result.retainedMethodIntents,
      [{kind: 'submit-input', key: 0, text: 'replacement'}]);
    assert.deepEqual(result.retainedMethod.buttons, []);
    assert.deepEqual(result.retainedMethod.controls, ['textarea', 'button'],
      'a read-only source block introduces no operable control');

    // unavailable + unauthorized (the previously-uncovered kinds)
    assert.equal(result.unavailable.heading, 'unavailable-reference');
    assert.equal(result.unavailable.reason, 'Unavailable: obj-gone (not found)');
    assert.deepEqual(result.unavailable.buttons, []);
    assert.equal(result.unauthorized.heading, 'unauthorized-reference');
    assert.equal(result.unauthorized.reason, 'Not authorized: obj-secret (denied)');
    assert.deepEqual(result.unauthorized.buttons, []);
  });
});
