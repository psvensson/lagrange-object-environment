import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnvironmentShell} from '../src/environment-shell.js';

// INPUT BINDINGS (SemanticUi/v2, Bead ngh): the shell's THIRD intent-routing
// table, beside activation and edit bindings.
//
// It is deliberately a separate table rather than a generalization of the edit
// table. `edit-field` mutates a REPRESENTED FIELD of a record; `submit-input`
// supplies a TRANSIENT ARGUMENT to an interaction. Those are different meanings,
// and collapsing them to share code would erase the distinction SemanticUi/v2
// exists to draw. The mechanics are near-identical; the semantics are not.
//
// THE VERSION TOKEN ARRIVED WITH ITS COMMAND (E3, Bead eij.3). ngh left `tokenFor`
// out because optimistic concurrency belongs to a Command that consumes a token,
// and an unpaired supplier with nothing to conflict against could not be
// falsified. One exists now, so the OPTIONAL supplier is part of this table --
// with the edit table's contract, and with the shell learning nothing about what
// a token MEANS. A binding that declares none still dispatches, with an explicit
// null rather than an absent key.
//
// The CommandRouter is a FAKE that always routes, so none of these proofs
// depends on the real router's command-selection policy (see Bead 4c4).

const VIEW = 'demo-view';
const HANDLE = 'surface-1';
const DESCRIPTOR = {kind: 'object', subject: {objectId: 'o'}, parameters: {inputs: [{role: 'replacement-source'}]}};

function harness({inputBindings = [], editBindings = []} = {}) {
  let onIntent = null;
  const calls = {consumeIntent: 0, resolveInput: 0, resolveField: 0};
  const contexts = [];
  const adapter = {onIntent(h) { onIntent = h; return () => {}; }};
  const compositor = {
    viewForSurfaceHandle: (h) => (h === HANDLE ? {viewId: VIEW, presentationDescriptor: DESCRIPTOR} : null),
    openView: async () => {}, presentOn: async () => {}, liveView: () => null,
  };
  const commandRouter = {
    async consumeIntent(intent, {context}) { calls.consumeIntent += 1; contexts.push(context); return {ok: true}; },
  };
  const shell = createEnvironmentShell({
    navigator: {navigate: async () => null}, selectionModel: {select: () => {}}, compositor, adapter,
    presentationRegistry: {discover: () => ({presentations: [], failures: []})},
  });
  shell.bindIntents({adapter, commandRouter, inputBindings, editBindings});
  return {emit: (intent) => onIntent(intent, HANDLE), calls, contexts};
}


test('NO input binding: zero resolver calls, zero consumeIntent, zero error', async () => {
  const h = harness({inputBindings: []});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 0, 'the CommandRouter was reached');
  assert.equal(h.calls.resolveInput, 0);
});

test('an EDIT binding does not answer a submit-input', async () => {
  const h = harness({editBindings: [{
    viewId: VIEW, commandId: 'edit-cmd',
    resolveField: () => { h.calls.resolveField += 1; return {slot: 'x'}; },
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 0, 'a submit-input was routed through an edit binding');
});

test('WITH an input binding: resolved context arrives under `input`, never `field`', async () => {
  let seen = null;
  const h = harness({inputBindings: [{
    viewId: VIEW, commandId: 'replace-demo', onInputError: () => {},
    resolveInput: (descriptor, key) => { seen = {descriptor, key}; return {role: descriptor.parameters.inputs[key].role}; },
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'line one\nline two'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 1);
  const ctx = h.contexts[0];
  assert.deepEqual(ctx.input, {role: 'replacement-source'});
  assert.ok(!Object.hasOwn(ctx, 'field'), 'an input context leaked under `field`');
  // E3 (Bead eij.3) replaced ngh's "carries NO version token" assertion: the
  // token arrived WITH the Command that consumes it. A binding that declares no
  // tokenFor still dispatches -- with an explicit null, never an absent key, so a
  // Command can tell "no supplier" from "a supplier that answered nothing".
  assert.ok(Object.hasOwn(ctx, 'versionToken'), 'the input context must carry the token slot');
  assert.equal(ctx.versionToken, null, 'a binding with no tokenFor supplies null');
  assert.equal(ctx.text, 'line one\nline two', 'the raw multiline text must survive unparsed');
  assert.equal(ctx.commandId, 'replace-demo');
  assert.equal(seen.descriptor, DESCRIPTOR, 'the resolver must see the EXACT live descriptor');
});

test('a null resolver result is an explicit no-op, not a dispatch', async () => {
  const h = harness({inputBindings: [{viewId: VIEW, commandId: 'c', resolveInput: () => null, onInputError: () => {}}]});
  h.emit({kind: 'submit-input', key: 99, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 0);
});

test('a malformed resolver result dispatches nothing and reports once', async () => {
  let reported = 0;
  const h = harness({inputBindings: [{
    viewId: VIEW, commandId: 'c', resolveInput: () => 'not-an-object',
    onInputError: () => { reported += 1; },
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 0);
  assert.equal(reported, 1, 'reported ' + reported + ' times');
});

test('the inspector view may not be bound through inputBindings', async () => {
  assert.throws(() => harness({inputBindings: [{viewId: 'inspector-view', commandId: 'c', resolveInput: () => ({}), onInputError: () => {}}]}),
    /inspector view may not be bound through inputBindings/);
});

test('an input binding must declare its own commandId', async () => {
  assert.throws(() => harness({inputBindings: [{viewId: VIEW, resolveInput: () => ({}), onInputError: () => {}}]}),
    /must declare its commandId/);
});

test('a stale handle is ignored before any binding is consulted', async () => {
  let resolved = 0;
  let onIntent = null;
  const adapter = {onIntent(h) { onIntent = h; return () => {}; }};
  const compositor = {viewForSurfaceHandle: () => null, openView: async () => {}, presentOn: async () => {}, liveView: () => null};
  let consumed = 0;
  const shell = createEnvironmentShell({navigator: {navigate: async () => null}, selectionModel: {select: () => {}}, compositor, adapter, presentationRegistry: {discover: () => ({presentations: [], failures: []})}});
  shell.bindIntents({adapter, commandRouter: {async consumeIntent() { consumed += 1; return null; }},
    inputBindings: [{viewId: VIEW, commandId: 'c', onInputError: () => {}, resolveInput: () => { resolved += 1; return {}; }}]});
  onIntent({kind: 'submit-input', key: 0, text: 'x'}, 'dead-handle');
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, 0);
  assert.equal(consumed, 0);
});


test('a REFUSED command reaches the consumer: onInputError fires, exactly once', async () => {
  // The regression this guards, found by review: CommandRouter now REFUSES an
  // unavailable requested Command by throwing (Bead z9b). On the renderer's
  // fire-and-forget path a binding without an error channel observed NOTHING at
  // all -- not even the `onSubmitted(null)` it used to get -- so a user pressed
  // the control and nothing whatsoever happened. That is the dead-affordance
  // failure z9b exists to make visible, reintroduced by z9b itself.
  //
  // onInputError is now REQUIRED on this table, so the channel always exists.
  const {createCommandRouter} = await import('../src/command-router.js');
  let onIntent = null;
  const events = [];
  const adapter = {onIntent(h) { onIntent = h; return () => {}; }};
  const compositor = {
    viewForSurfaceHandle: (h) => (h === HANDLE ? {viewId: VIEW, presentationDescriptor: DESCRIPTOR} : null),
    openView: async () => {}, presentOn: async () => {}, liveView: () => null,
  };
  const commandRouter = createCommandRouter({
    compositor,
    // Nothing applicable answers the id the binding names.
    commandRegistry: {discover: () => ({commands: [{id: 'something-else'}], failures: []})},
    authorityProvider: async () => ({}),
    dispatch: async (c) => ({ran: c.id}),
  });
  const shell = createEnvironmentShell({
    navigator: {navigate: async () => null}, selectionModel: {select: () => {}},
    compositor, adapter, presentationRegistry: {discover: () => ({presentations: [], failures: []})},
  });
  shell.bindIntents({adapter, commandRouter, inputBindings: [{
    viewId: VIEW, commandId: 'not-wired-yet',
    resolveInput: (d, k) => ({role: d.parameters.inputs[k].role}),
    onSubmitted: (r) => events.push(['onSubmitted', r]),
    onInputError: (e) => events.push(['onInputError', e.name, e.commandId]),
  }]});
  onIntent({kind: 'submit-input', key: 0, text: 'x'}, HANDLE);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(events, [['onInputError', 'RequestedCommandUnavailableError', 'not-wired-yet']]);
  // and NOT reported as a success with a null result
  assert.ok(!events.some(([kind]) => kind === 'onSubmitted'), 'a refusal was reported as a submission');
});

test('a bound Command that CRASHES deciding applicability reaches onInputError as ITSELF', async () => {
  // Bead 1yb, end to end, with NO shell change: CommandRouter rethrows the
  // registry's own applicability error unchanged, and it travels the ORDINARY
  // binding channel -- router rejection -> handleInputIntent catch ->
  // onInputError. The shell must NOT special-case it (nor
  // RequestedCommandUnavailableError); the consumer receives the SAME value the
  // Command's own `applies` threw -- here an Error, so its identity and stack
  // arrive intact, which is the whole point of not wrapping it.
  const {createCommandRouter} = await import('../src/command-router.js');
  const boom = new TypeError('applies() read a field of undefined');
  let onIntent = null;
  const events = [];
  const adapter = {onIntent(h) { onIntent = h; return () => {}; }};
  const compositor = {
    viewForSurfaceHandle: (h) => (h === HANDLE ? {viewId: VIEW, presentationDescriptor: DESCRIPTOR} : null),
    openView: async () => {}, presentOn: async () => {}, liveView: () => null,
  };
  const commandRouter = createCommandRouter({
    compositor,
    commandRegistry: {discover: () => ({commands: [], failures: [{commandId: 'crashes', error: boom}]})},
    authorityProvider: async () => { throw new Error('a refused request must not mint authority'); },
    dispatch: async () => { throw new Error('nothing may dispatch'); },
  });
  const shell = createEnvironmentShell({
    navigator: {navigate: async () => null}, selectionModel: {select: () => {}},
    compositor, adapter, presentationRegistry: {discover: () => ({presentations: [], failures: []})},
  });
  shell.bindIntents({adapter, commandRouter, inputBindings: [{
    viewId: VIEW, commandId: 'crashes',
    resolveInput: (d, k) => ({role: d.parameters.inputs[k].role}),
    onSubmitted: (r) => events.push(['onSubmitted', r]),
    onInputError: (e) => events.push(['onInputError', e]),
  }]});
  onIntent({kind: 'submit-input', key: 0, text: 'x'}, HANDLE);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'onInputError');
  assert.equal(events[0][1], boom, 'the consumer receives the Command\'s OWN error object');
});

test('a tokenFor is called with the SAME live descriptor, and its result reaches the Command untouched', async () => {
  const seen = [];
  const h = harness({inputBindings: [{
    viewId: VIEW, commandId: 'replace-demo', onInputError: () => {},
    resolveInput: () => ({role: 'replacement-source'}),
    tokenFor: (descriptor) => { seen.push(descriptor); return 'opaque-token'; },
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [DESCRIPTOR], 'the token comes from the descriptor the binding was selected by');
  assert.equal(seen[0], DESCRIPTOR, 'by IDENTITY: a consumer pairing on identity must be handed the paired object');
  assert.equal(h.contexts[0].versionToken, 'opaque-token');
});

test('a THROWING tokenFor is reported and dispatches NOTHING', async () => {
  // The alternative -- swallowing it into a token-free dispatch -- would replace
  // whatever is current instead of what the user was shown. A supplier that
  // cannot answer must stop the interaction, not weaken it.
  const errors = [];
  const boom = new Error('the pairing is gone');
  const h = harness({inputBindings: [{
    viewId: VIEW, commandId: 'replace-demo',
    resolveInput: () => ({role: 'replacement-source'}),
    tokenFor: () => { throw boom; },
    onInputError: (e) => errors.push(e),
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 0, 'a token-free dispatch must never happen');
  assert.deepEqual(errors, [boom], 'and the consumer is told, by identity');
});

test('a tokenFor answering NULL still dispatches: the Command decides what a missing token means', async () => {
  // The shell has no opinion. A Command that requires a token refuses loudly
  // (that refusal is its own, and proven with it); a Command that does not is
  // unaffected. Deciding here would put a token policy in the owner that is
  // meant to learn nothing about tokens.
  const h = harness({inputBindings: [{
    viewId: VIEW, commandId: 'replace-demo', onInputError: () => {},
    resolveInput: () => ({role: 'replacement-source'}),
    tokenFor: () => null,
  }]});
  h.emit({kind: 'submit-input', key: 0, text: 'x'});
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.consumeIntent, 1);
  assert.equal(h.contexts[0].versionToken, null);
});

test('a non-function tokenFor is REJECTED at bind time', () => {
  assert.throws(
    () => harness({inputBindings: [{
      viewId: VIEW, commandId: 'c', resolveInput: () => ({}), onInputError: () => {}, tokenFor: 'nope',
    }]}),
    /tokenFor must be a function/,
  );
});

test('an input binding without an error channel is REJECTED at bind time', async () => {
  assert.throws(
    () => harness({inputBindings: [{viewId: VIEW, commandId: 'c', resolveInput: () => ({})}]}),
    /must declare onInputError/,
  );
});
