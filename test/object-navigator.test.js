import test from 'node:test';
import assert from 'node:assert/strict';

import {Command, Presentation} from '../src/model.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND, createObjectNavigator} from '../src/object-navigator.js';
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider} from '../src/object-presentation-providers.js';

const ref = (objectId) => ({kind: 'ref', imageId: 'img', objectId});
const pinned = (objectId, revision) => ({kind: 'pinned-ref', imageId: 'img', objectId, revision});

// A minimal injected referencesOfValue (mirrors the substrate's canonical
// Value walk: a ref/pinned-ref Value is its own single followable reference,
// anything else has none), so the navigator stays dependency-free. The
// navigator composes this over the read record's slots + indexed.
function referencesOfValue(value) {
  return (value && (value.kind === 'ref' || value.kind === 'pinned-ref')) ? [value] : [];
}

function makeNavigator({records = {}, readError = null, authorityFor = null} = {}) {
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  const calls = [];
  const adapter = {
    // Mirrors the authorized read seam: readObject({imageId, objectId,
    // authority, blockId}). authorityFor (optional) decides per-call whether the
    // threaded authority is honored, so tests can prove authority is threaded
    // (never stored) and that denied reads become unauthorized-ref.
    async readObject({imageId, objectId, authority, blockId} = {}) {
      calls.push({imageId, objectId, authority, blockId});
      if (readError) throw readError;
      if (authorityFor && !authorityFor({imageId, objectId, authority})) {
        const denied = new Error(`not authorized: object/read ${objectId}`);
        denied.name = 'AuthorityError';
        throw denied;
      }
      return records[objectId] ?? null;
    },
  };
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue,
  });
  return {navigator, commandRegistry, presentationRegistry, calls};
}

// --- the happy path: object -> inspector -> discover refs -------------------

test('navigate a readable object yields an inspector presentation with the record refs in context', async () => {
  const records = {
    'obj-a': {
      // shape/behavior are NOT disclosed by the read lane (it carries slots +
      // indexed only), so they must NOT appear in the discovered references.
      shape: ref('shape-1'),
      behavior: ref('behavior-1'),
      slots: {'slot-title': {kind: 'text', value: 'A'}, 'slot-target': ref('obj-b')},
      indexed: [pinned('obj-c', '3')],
    },
  };
  const {navigator} = makeNavigator({records});
  const {presentations, commands, failures} = await navigator.navigate(ref('obj-a'));

  assert.equal(presentations.length, 1);
  const insp = presentations[0];
  assert.ok(insp instanceof Presentation);
  assert.equal(insp.kind, 'inspector');
  assert.equal(insp.subject.objectId, 'obj-a');
  // fields are leaf slots as Values keyed by slot id (not flattened to strings)
  assert.equal(insp.context.fields['slot-title'].value, 'A');
  // references walked from slots + indexed ONLY (the structures the read lane
  // discloses), as RAW ref Values (revision kept); shape/behavior excluded
  const refIds = insp.context.references.map((r) => r.objectId);
  for (const id of ['obj-b', 'obj-c']) {
    assert.ok(refIds.includes(id), `references must reach ${id}`);
  }
  for (const id of ['shape-1', 'behavior-1']) {
    assert.ok(!refIds.includes(id), `references must NOT reach ${id} (the lane does not disclose shape/behavior)`);
  }
  const pinnedC = insp.context.references.find((r) => r.objectId === 'obj-c');
  assert.equal(pinnedC.kind, 'pinned-ref');
  assert.equal(pinnedC.revision, '3');
  assert.deepEqual(commands, []);
  assert.deepEqual(failures, []);
});

test('following a ref navigates to the referenced object (object -> inspector -> ref -> inspector)', async () => {
  const records = {
    'obj-a': {slots: {'slot-target': ref('obj-b')}},
    'obj-b': {slots: {'slot-title': {kind: 'text', value: 'B'}}},
  };
  const {navigator} = makeNavigator({records});
  const first = await navigator.navigate(ref('obj-a'));
  const targetRef = first.presentations[0].context.references.find((r) => r.objectId === 'obj-b');
  const second = await navigator.navigate(targetRef);
  assert.equal(second.presentations[0].kind, 'inspector');
  assert.equal(second.presentations[0].subject.objectId, 'obj-b');
  assert.equal(second.presentations[0].context.fields['slot-title'].value, 'B');
});

// --- the failure branch: follow ref -> unavailable -> explicit presentation -

test('a dangling ref yields an explicit unavailable-ref presentation (a ref is never authority)', async () => {
  const {navigator} = makeNavigator({records: {}}); // nothing is readable
  const {presentations} = await navigator.navigate(ref('ghost'));
  assert.equal(presentations.length, 1, 'the reference must not vanish');
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(presentations[0].subject.kind, UNAVAILABLE_REF_KIND);
  assert.equal(presentations[0].subject.objectId, 'ghost');
  assert.equal(presentations[0].context.reason, 'unavailable');
});

test('a read error also routes to the unavailable-ref presentation (backend failure, never a crash)', async () => {
  const {navigator} = makeNavigator({readError: new Error('backend gone')});
  const {presentations} = await navigator.navigate(ref('obj-a'));
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(presentations[0].context.reason, 'backend gone');
});

// An operational TypeError whose message merely CONTAINS "not found" (e.g. a
// wrong readBlockId -> `activation block not found: ...`) is NOT a missing
// object: it must fall through to the operational branch with its ORIGINAL
// message, not be re-reasoned as the lane's missing-object form. This is the
// falsification arm for the tightened /^object not found: / discriminator.
test('an operational TypeError containing "not found" is NOT classified as a missing object', async () => {
  const {navigator} = makeNavigator({readError: new TypeError('activation block not found: img/wrong-block')});
  const {presentations} = await navigator.navigate(ref('obj-a'));
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(
    presentations[0].context.reason,
    'activation block not found: img/wrong-block',
    'the operational message is preserved verbatim, not collapsed to missing-object semantics',
  );
});

// The lane's exact single-owned not-found prefix IS classified as a missing
// object (distinct from operational failures).
test('the lane\'s exact "object not found: <image>/<id>" prefix IS classified as a missing object', async () => {
  const {navigator} = makeNavigator({readError: new TypeError('object not found: img/obj-a')});
  const {presentations} = await navigator.navigate(ref('obj-a'));
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(presentations[0].context.reason, 'object not found: img/obj-a');
});

// The PRIMARY discriminator is the lane-owned stable error code (OBJECT_NOT_FOUND), not the message
// text. An error carrying the code is missing-object even if its message does NOT match the prefix;
// and an operational TypeError WITHOUT the code but WITH "not found" in its message is still NOT a
// missing object (covered by the falsification test above).
test('the stable OBJECT_NOT_FOUND code IS classified as a missing object (machine-readable, not message text)', async () => {
  const coded = new TypeError('object not found: img/obj-b');
  coded.code = 'OBJECT_NOT_FOUND';
  const {navigator} = makeNavigator({readError: coded});
  const {presentations} = await navigator.navigate(ref('obj-b'));
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(presentations[0].context.reason, 'object not found: img/obj-b');
});

// --- the authorized read lane: unauthorized vs unavailable -------------------

test('navigate threads authority to the read seam per call and never stores it', async () => {
  const records = {'obj-a': {slots: {}}};
  const {navigator, calls} = makeNavigator({records});
  const auth = {kind: 'authority-context', id: 'ctx-1'};
  await navigator.navigate(ref('obj-a'), {authority: auth, readBlockId: 'read-block'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority, auth, 'the exact authority context is threaded to the read');
  assert.equal(calls[0].blockId, 'read-block', 'the read block id is threaded');
  // A second navigate with a DIFFERENT authority uses that one: no storage.
  const auth2 = {kind: 'authority-context', id: 'ctx-2'};
  await navigator.navigate(ref('obj-a'), {authority: auth2, readBlockId: 'read-block'});
  assert.equal(calls[1].authority, auth2);
});

test('a denied read yields an explicit unauthorized-ref presentation, not unavailable', async () => {
  const records = {'obj-a': {slots: {}}};
  // Deny every read (authority present but not honored).
  const {navigator} = makeNavigator({records, authorityFor: () => false});
  const {presentations} = await navigator.navigate(ref('obj-a'), {authority: {deny: true}});
  assert.equal(presentations.length, 1, 'the reference must not vanish');
  assert.equal(presentations[0].kind, 'unauthorized-reference');
  assert.equal(presentations[0].subject.kind, UNAUTHORIZED_REF_KIND);
  assert.equal(presentations[0].subject.objectId, 'obj-a');
});

test('unauthorized-existing and unauthorized-nonexistent are INDISTINGUISHABLE (both unauthorized-ref)', async () => {
  const records = {'obj-a': {slots: {}}}; // obj-a exists, ghost does not
  const {navigator} = makeNavigator({records, authorityFor: () => false});
  const existing = await navigator.navigate(ref('obj-a'), {authority: {deny: true}});
  const missing = await navigator.navigate(ref('ghost'), {authority: {deny: true}});
  assert.equal(existing.presentations[0].kind, 'unauthorized-reference');
  assert.equal(missing.presentations[0].kind, 'unauthorized-reference');
  assert.equal(existing.presentations[0].subject.kind, UNAUTHORIZED_REF_KIND);
  assert.equal(missing.presentations[0].subject.kind, UNAUTHORIZED_REF_KIND);
});

test('authorized-nonexistent is DISTINGUISHABLE from unauthorized (unavailable-ref vs unauthorized-ref)', async () => {
  const authorityFor = ({objectId}) => objectId !== 'denied-obj';
  const {navigator} = makeNavigator({records: {}, authorityFor});
  const missing = await navigator.navigate(ref('ghost'), {authority: {ok: true}});
  assert.equal(missing.presentations[0].kind, 'unavailable-reference');
  const denied = await navigator.navigate(ref('denied-obj'), {authority: {ok: true}});
  assert.equal(denied.presentations[0].kind, 'unauthorized-reference');
});

test('a ref present in a readable parent does NOT authorize reading its target (ref != authority)', async () => {
  const records = {
    'obj-parent': {slots: {'slot-target': ref('obj-child')}},
    'obj-child': {slots: {'slot-title': {kind: 'text', value: 'child'}}},
  };
  // Authority authorizes reading the parent only, not the child.
  const authorityFor = ({objectId}) => objectId === 'obj-parent';
  const {navigator} = makeNavigator({records, authorityFor});
  const parent = await navigator.navigate(ref('obj-parent'), {authority: {ok: true}});
  assert.equal(parent.presentations[0].kind, 'inspector', 'the parent reads fine under its own authority');
  const childRef = parent.presentations[0].context.references.find((r) => r.objectId === 'obj-child');
  assert.ok(childRef, 'the parent discloses the child ref as identity');
  const child = await navigator.navigate(childRef, {authority: {ok: true}});
  assert.equal(child.presentations[0].kind, 'unauthorized-reference', 'reading the child is separately authorized (and here denied)');
});

// --- discovery is consumed, not hard-coded ----------------------------------

test('a second, higher-specificity provider registered later is included (registry consumed, not bypassed)', async () => {
  const records = {'obj-a': {slots: {}}};
  const {navigator, presentationRegistry} = makeNavigator({records});
  // Register a domain-specific provider AFTER the generic inspector. A
  // hard-coded navigator would ignore it; a registry-consuming one includes it.
  presentationRegistry.register({
    id: 'domain-view',
    present: (subject) => (subject.kind === 'ref'
      ? new Presentation({id: `domain:${subject.objectId}`, subject, kind: 'domain-view', context: {}, state: {}})
      : null),
  });
  const {presentations} = await navigator.navigate(ref('obj-a'));
  assert.deepEqual(presentations.map((p) => p.kind), ['inspector', 'domain-view']);
});

test('an applicable-but-unauthorized command is still discovered at navigate (discovery != authorization)', async () => {
  const records = {'obj-a': {slots: {}}};
  const {navigator, commandRegistry} = makeNavigator({records});
  commandRegistry.register(new Command({
    id: 'delete', title: 'Delete', appliesTo: () => true,
    invoke: () => { throw new Error('not authorized'); },
  }));
  const {commands} = await navigator.navigate(ref('obj-a'));
  assert.deepEqual(commands.map((c) => c.id), ['delete'], 'applicable-but-denied command is discovered');
});

test('inspect is the sync escape hatch for an already-materialized subject', () => {
  const {navigator} = makeNavigator({});
  const {presentations} = navigator.inspect({kind: UNAVAILABLE_REF_KIND, objectId: 'x', reason: 'unavailable'});
  assert.equal(presentations[0].kind, 'unavailable-reference');
});

test('navigate rejects a non-ref subject', async () => {
  const {navigator} = makeNavigator({});
  await assert.rejects(navigator.navigate({objectId: 'no-kind'}), /requires a ref subject/);
});

test('createObjectNavigator validates its injected dependencies', () => {
  assert.throws(() => createObjectNavigator({}), /adapter with readObject/);
  assert.throws(
    () => createObjectNavigator({adapter: {readObject: async () => null}, presentationRegistry: createPresentationRegistry(), commandRegistry: createCommandRegistry()}),
    /referencesOfValue/,
  );
});
