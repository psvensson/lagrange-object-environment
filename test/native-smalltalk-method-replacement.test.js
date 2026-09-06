import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_METHOD_INPUTS,
  NATIVE_METHOD_SOURCE_INPUT_ROLE,
  NATIVE_SMALLTALK_VIEW_ID,
  REPLACE_NATIVE_METHOD_COMMAND_ID,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeMethodPresentationProvider,
  createNativeMethodSubject,
  createNativeSmalltalkBrowser,
  createReplaceNativeMethodCommand,
  resolveMethodReplacementInput,
} from '../src/native-smalltalk-browser.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {
  createUnauthorizedRefProvider,
  createUnavailableRefProvider,
} from '../src/object-presentation-providers.js';
import {createCompositor} from '../src/compositor.js';
import {createFakeRendererAdapter} from '../src/fake-renderer-adapter.js';

// E3 unit proofs (Bead eij.3): the transient replacement token, the affordance,
// the Command's refusals, and the mutation -> reread orchestration. The real
// vertical -- renderer intent through Images' authorized replacement and back to
// a fresh authorized reread -- lives in
// test/native-smalltalk-browser.integration.test.js against a real runtime.
//
// WHAT THE TOKEN IS FOR, since every proof below is about it: Images' writer-facing
// read answers {descriptor, versionToken} from ONE resolution, and the token is
// the caller's assumption about the binding it was SHOWN. Replacing without it
// would overwrite whatever happens to be current -- the lost update this lane
// exists to make impossible.

const IMAGE = 'img';
const ref = (objectId) => Object.freeze({kind: 'ref', imageId: IMAGE, objectId});
const CLASS_REF = ref('smalltalk/class/BrowseChild');
const SELECTOR = 'childFirst';
const BLOCK_REF = ref('smalltalk/class/BrowseChild/method/Y2hpbGRGaXJzdA');
const TOKEN = 'smalltalk-method-position-token/v0:opaque';

const methodSubject = () => createNativeMethodSubject({imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR});

function methodDescription(overrides = {}) {
  return Object.freeze({
    format: 'smalltalk-method-description/v1',
    class: CLASS_REF,
    side: 'instance',
    selector: SELECTOR,
    method: BLOCK_REF,
    source: null,
    provenance: null,
    ...overrides,
  });
}

const classDescription = () => Object.freeze({
  format: 'smalltalk-class-description/v1',
  class: CLASS_REF,
  name: 'BrowseChild',
  side: 'instance',
  superclass: null,
  classSide: null,
  layout: null,
  selectors: Object.freeze([SELECTOR]),
  provenance: null,
});

function registryFor() {
  const registry = createPresentationRegistry();
  registry.register(createNativeClassPresentationProvider());
  registry.register(createNativeMethodPresentationProvider());
  registry.register(createUnavailableRefProvider());
  registry.register(createUnauthorizedRefProvider());
  return registry;
}

function harness({read, versionToken = TOKEN} = {}) {
  const reads = [];
  const compositor = createCompositor({rendererAdapter: createFakeRendererAdapter()});
  const adapter = {
    describeSmalltalkClass: () => classDescription(),
    classifySmalltalkClassReadError: (e) => (e?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable'),
    classifySmalltalkMethodReadError: (e) => (e?.name === 'AuthorityError' ? 'unauthorized' : 'unavailable'),
    readSmalltalkMethodForUpdate(args) {
      reads.push(args);
      if (read) return read(args);
      return {descriptor: methodDescription(), versionToken};
    },
  };
  const browser = createNativeSmalltalkBrowser({adapter, presentationRegistry: registryFor(), compositor});
  return {adapter, browser, compositor, reads};
}

const openMethod = async (h) => h.browser.open(methodSubject(), {
  authority: 'A', viewDescriptor: {kind: 'surface', width: 8, height: 8},
});

// --- the affordance ---------------------------------------------------------

test('a displayed native METHOD carries the one replacement input; a CLASS carries none', async () => {
  const h = harness();
  const method = await openMethod(h);
  assert.equal(method.kind, 'native-method');
  assert.equal(method.parameters.inputs, NATIVE_METHOD_INPUTS,
    'the affordance is threaded BY IDENTITY from the owner that also supplies the binding and the Command');
  assert.equal(method.parameters.inputs[0].role, NATIVE_METHOD_SOURCE_INPUT_ROLE);

  const klass = await h.browser.present(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {authority: 'A'});
  assert.equal(klass.kind, 'native-class');
  assert.equal(klass.parameters.inputs, undefined, 'there is no class-level replacement, so no class affordance');
});

test('the resolver indexes the SAME array the projector keys, and answers only the role', () => {
  const descriptor = {kind: 'native-method', parameters: {inputs: NATIVE_METHOD_INPUTS}};
  assert.deepEqual(resolveMethodReplacementInput(descriptor, 0), {role: NATIVE_METHOD_SOURCE_INPUT_ROLE});
  assert.deepEqual(Object.keys(resolveMethodReplacementInput(descriptor, 0)), ['role'],
    'no label, no subject, no token crosses back');
  // Every non-answer is a quiet no-op, never a wrong input.
  assert.equal(resolveMethodReplacementInput(descriptor, 1), null, 'a key past the array');
  assert.equal(resolveMethodReplacementInput(descriptor, -1), null);
  assert.equal(resolveMethodReplacementInput(descriptor, 0.5), null);
  assert.equal(resolveMethodReplacementInput({kind: 'native-class', parameters: {inputs: NATIVE_METHOD_INPUTS}}, 0), null,
    'a class descriptor has no replacement input, whatever it carries');
  assert.equal(resolveMethodReplacementInput(null, 0), null);
});

// --- the transient token ----------------------------------------------------

test('the token is paired with the EXACT displayed descriptor, and never leaves it', async () => {
  const h = harness();
  const binding = h.browser.replacementInputBinding({authorityFor: () => 'A', onReplacementError: () => {}});
  const descriptor = await openMethod(h);

  assert.equal(binding.tokenFor(descriptor), TOKEN);
  // It reached NO document, descriptor, subject or presentation.
  assert.equal(JSON.stringify(descriptor).includes(TOKEN), false, 'the token must not enter the descriptor');
  // A structurally equal COPY is not the paired object and gets nothing: this is
  // identity pairing, not deep equality, so a caller cannot resurrect a token by
  // rebuilding a descriptor that merely looks the same.
  assert.equal(binding.tokenFor(JSON.parse(JSON.stringify(descriptor))), null);
  assert.equal(binding.tokenFor(null), null);
  assert.equal(binding.tokenFor({kind: 'native-method', parameters: {}}), null);
});

test('the token is masked once the view no longer shows that descriptor, and cleared by a failed read', async () => {
  const h = harness();
  const binding = h.browser.replacementInputBinding({authorityFor: () => 'A', onReplacementError: () => {}});
  const first = await openMethod(h);
  assert.equal(binding.tokenFor(first), TOKEN);

  // Re-present the SAME method: a new descriptor object, a new token pairing, and
  // the previous descriptor is dead even though it is still structurally valid.
  const second = await h.browser.present(methodSubject(), {authority: 'A'});
  assert.notEqual(second, first);
  assert.equal(binding.tokenFor(first), null, 'the superseded descriptor keeps nothing');
  assert.equal(binding.tokenFor(second), TOKEN);

  // A CLASS on the same view: no token at all, and the method pairing is gone.
  const klass = await h.browser.present(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {authority: 'A'});
  assert.equal(binding.tokenFor(klass), null);
  assert.equal(binding.tokenFor(second), null);
});

test('a torn-down view takes the token with it, even though the descriptor object still exists', async () => {
  // THE ONE PROOF THE LIVENESS CHECK OWNS. Identity pairing alone cannot answer
  // this: the caller still holds the exact descriptor object that was paired, and
  // this owner never cleared the pairing -- the Compositor closed the view, which
  // is its call and not this owner's to observe any other way. Without the
  // liveness clause a replacement could be dispatched against a method nobody is
  // looking at any more.
  //
  // Stated because a perturbation run proved it: the identity clause and the
  // liveness clause are REDUNDANT for a structurally-equal COPY (either one
  // refuses it). They are not redundant here.
  const h = harness();
  const binding = h.browser.replacementInputBinding({authorityFor: () => 'A', onReplacementError: () => {}});
  const descriptor = await openMethod(h);
  assert.equal(binding.tokenFor(descriptor), TOKEN);

  await h.compositor.closeView(NATIVE_SMALLTALK_VIEW_ID);
  assert.equal(h.compositor.liveView(NATIVE_SMALLTALK_VIEW_ID), null);
  assert.equal(binding.tokenFor(descriptor), null, 'the very same descriptor object now yields nothing');
});

test('a DENIED method read leaves no token behind, so nothing can be replaced from a failure view', async () => {
  const denied = Object.assign(new Error('denied'), {name: 'AuthorityError'});
  const h = harness({read: () => { throw denied; }});
  const binding = h.browser.replacementInputBinding({authorityFor: () => 'A', onReplacementError: () => {}});
  const descriptor = await openMethod(h);
  assert.equal(descriptor.kind, 'unauthorized-reference', 'a denied read presents through the ordinary route');
  assert.equal(binding.tokenFor(descriptor), null);
});

test('a read that answers no token is LOUD, not an affordance that would always refuse', async () => {
  const h = harness({read: () => ({descriptor: methodDescription()})});
  await assert.rejects(openMethod(h), /must return \{descriptor, versionToken\}/);
});

// --- the Command ------------------------------------------------------------

function commandHarness() {
  const calls = [];
  const adapter = {replaceSmalltalkMethod: async (args) => { calls.push(args); return {replaced: true}; }};
  return {calls, adapter, command: createReplaceNativeMethodCommand()};
}

test('the Command carries the subject, the supplied source and the token to the ONE authorized seam', async () => {
  const c = commandHarness();
  const subject = methodSubject();
  const result = await c.command.invoke(subject, {
    adapter: c.adapter,
    authority: 'per-invocation',
    text: '[ ^42 ]',
    versionToken: TOKEN,
    input: {role: NATIVE_METHOD_SOURCE_INPUT_ROLE},
  });
  assert.deepEqual(result, {replaced: true}, "Images' receipt is returned unchanged");
  assert.deepEqual(c.calls, [{
    imageId: IMAGE,
    classRef: CLASS_REF,
    selector: SELECTOR,
    source: '[ ^42 ]',
    versionToken: TOKEN,
    authority: 'per-invocation',
  }]);
  assert.equal(c.calls[0].classRef, CLASS_REF, 'the subject ref crosses by IDENTITY, never rebuilt');
});

test('the Command REFUSES rather than guessing: no token, wrong role, empty source', async () => {
  const c = commandHarness();
  const subject = methodSubject();
  const base = {adapter: c.adapter, text: '[ ^42 ]', versionToken: TOKEN, input: {role: NATIVE_METHOD_SOURCE_INPUT_ROLE}};

  // A missing token is the load-bearing refusal: a token-free replacement would
  // overwrite whatever is current instead of what the user was shown.
  await assert.rejects(c.command.invoke(subject, {...base, versionToken: null}), /requires the version token/);
  await assert.rejects(c.command.invoke(subject, {...base, versionToken: ''}), /requires the version token/);
  await assert.rejects(c.command.invoke(subject, {...base, input: {role: 'something-else'}}), /consumes the native-method-source input/);
  await assert.rejects(c.command.invoke(subject, {...base, input: undefined}), /consumes the native-method-source input/);
  await assert.rejects(c.command.invoke(subject, {...base, text: ''}), /requires the supplied source text/);
  await assert.rejects(c.command.invoke(subject, {...base, adapter: {}}), /replaceSmalltalkMethod/);
  assert.deepEqual(c.calls, [], 'not one refusal reached the image');
});

test('applicability is not authorization, and not identity', () => {
  const command = createReplaceNativeMethodCommand();
  assert.equal(command.id, REPLACE_NATIVE_METHOD_COMMAND_ID);
  // It applies to ANY native method, including one the caller may not write:
  // whether the write is allowed is Images' decision at invocation.
  assert.equal(command.applies(methodSubject(), {}), true);
  assert.equal(command.applies(createNativeClassSubject({imageId: IMAGE, classRef: CLASS_REF}), {}), false);
  assert.equal(command.applies({kind: 'ref', imageId: IMAGE, objectId: 'o'}, {}), false);
  assert.equal(command.applies(null, {}), false);
});

// --- mutation -> reread orchestration ---------------------------------------

test('a completed replacement is followed by a FRESH authorized read of the same method', async () => {
  const h = harness();
  const authorities = [];
  const binding = h.browser.replacementInputBinding({
    authorityFor: (subject) => { authorities.push(subject); return 'fresh'; },
    onReplacementError: () => {},
  });
  const before = await openMethod(h);
  assert.equal(h.reads.length, 1);

  await binding.onSubmitted({replaced: true});

  assert.equal(h.reads.length, 2, 'the displayed truth comes from a new authorized read, never from the receipt');
  assert.deepEqual(h.reads[1], {imageId: IMAGE, classRef: CLASS_REF, selector: SELECTOR, authority: 'fresh'});
  assert.deepEqual(authorities, [methodSubject()], 'authority is fresh per action, for the method on screen');
  const after = h.compositor.liveView(NATIVE_SMALLTALK_VIEW_ID).presentationDescriptor;
  assert.notEqual(after, before, 'the view was re-presented, not patched');
  assert.equal(binding.tokenFor(after), TOKEN, 'the new descriptor is paired with the new read');
  assert.equal(binding.tokenFor(before), null);
});

test('a router NULL is not a replacement, so nothing is reread', async () => {
  const h = harness();
  const binding = h.browser.replacementInputBinding({authorityFor: () => 'A', onReplacementError: () => {}});
  await openMethod(h);
  assert.equal(h.reads.length, 1);
  await binding.onSubmitted(null);
  assert.equal(h.reads.length, 1, '"not routed" is not "replaced"');
});

test('a CONFLICT is surfaced AND authoritatively reread; every other failure leaves the display alone', async () => {
  const h = harness();
  const reported = [];
  const binding = h.browser.replacementInputBinding({
    authorityFor: () => 'A',
    onReplacementError: (error) => reported.push(error),
  });
  await openMethod(h);
  assert.equal(h.reads.length, 1);

  // A lost update: the position moved, so what is on screen is stale.
  const conflict = Object.assign(new Error('conflicted'), {name: 'CommandConflictError'});
  await binding.onInputError(conflict);
  assert.deepEqual(reported, [conflict], 'the composition owns failure presentation, and is told FIRST');
  assert.equal(h.reads.length, 2, 'a stale conflict is reread authoritatively');

  // A denied write, a rejected source and a transient contention all leave the
  // observed position exactly where it was, so the descriptor on screen is still
  // what Images would answer. Rereading would be busywork that also throws the
  // user's failed attempt off the screen.
  for (const name of ['CommandAuthorizationError', 'CommandExecutionError', 'RequestedCommandUnavailableError']) {
    await binding.onInputError(Object.assign(new Error(name), {name}));
  }
  assert.equal(h.reads.length, 2, 'no non-conflict failure triggers a reread');
  assert.deepEqual(reported.map((e) => e.name),
    ['CommandConflictError', 'CommandAuthorizationError', 'CommandExecutionError', 'RequestedCommandUnavailableError']);
});

test('a reread that itself FAILS is reported once, and never starts a reporting loop', async () => {
  // Made genuinely discriminating after the first draft was green by
  // construction: a failed READ is classified and PRESENTED (an
  // unavailable-reference), so it never throws out of present(). The reread has
  // to fail for real, and the honest way is the composition's own authority
  // supplier refusing -- which is exactly the failure a reporting loop would
  // amplify, because reporting it would trigger another reread.
  const h = harness();
  const reported = [];
  const authorityDied = new Error('the composition cannot mint authority any more');
  const binding = h.browser.replacementInputBinding({
    // The view below is opened directly with its own authority, so this supplier
    // is reached ONLY by the reread -- which is what makes the failure the
    // reread's own rather than the open's.
    authorityFor: () => { throw authorityDied; },
    onReplacementError: (error) => reported.push(error),
  });
  await openMethod(h);

  const conflict = Object.assign(new Error('conflicted'), {name: 'CommandConflictError'});
  await binding.onInputError(conflict);

  assert.deepEqual(reported, [conflict, authorityDied], 'the original failure, then the reread failure -- once each');
  assert.equal(h.reads.length, 1, 'the failed reread reached no seam, and no second reread was attempted');
});

test('the binding refuses a composition that cannot report or cannot authorize', () => {
  const h = harness();
  assert.throws(() => h.browser.replacementInputBinding({onReplacementError: () => {}}), /authorityFor/);
  assert.throws(() => h.browser.replacementInputBinding({authorityFor: () => 'A'}), /onReplacementError/);
});
