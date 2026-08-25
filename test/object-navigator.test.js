import test from 'node:test';
import assert from 'node:assert/strict';

import {Command, Presentation} from '../src/model.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {UNAVAILABLE_REF_KIND, createObjectNavigator} from '../src/object-navigator.js';
import {createObjectInspectorProvider, createUnavailableRefProvider} from '../src/object-presentation-providers.js';

const ref = (objectId) => ({kind: 'ref', imageId: 'img', objectId});
const pinned = (objectId, revision) => ({kind: 'pinned-ref', imageId: 'img', objectId, revision});

// A minimal injected referencesOfRecord (mirrors the substrate's walk: slots +
// indexed + shape/behavior), so the navigator stays dependency-free.
function referencesOfRecord(record) {
  const refs = [];
  if (record.shape) refs.push(record.shape);
  if (record.behavior) refs.push(record.behavior);
  for (const value of Object.values(record.slots ?? {})) {
    if (value && (value.kind === 'ref' || value.kind === 'pinned-ref')) refs.push(value);
  }
  for (const value of record.indexed ?? []) {
    if (value && (value.kind === 'ref' || value.kind === 'pinned-ref')) refs.push(value);
  }
  return refs;
}

function makeNavigator({records = {}, readError = null} = {}) {
  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  const commandRegistry = createCommandRegistry();
  const adapter = {
    async readObject(imageId, objectId) {
      if (readError) throw readError;
      return records[objectId] ?? null;
    },
  };
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfRecord,
  });
  return {navigator, commandRegistry, presentationRegistry};
}

// --- the happy path: object -> inspector -> discover refs -------------------

test('navigate a readable object yields an inspector presentation with the record refs in context', async () => {
  const records = {
    'obj-a': {
      shape: ref('shape-1'),
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
  // references walked from slots + indexed + shape, as RAW ref Values (revision kept)
  const refIds = insp.context.references.map((r) => r.objectId);
  for (const id of ['shape-1', 'obj-b', 'obj-c']) {
    assert.ok(refIds.includes(id), `references must reach ${id}`);
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

test('a read error also routes to the unavailable-ref presentation (reads are unguarded, never a crash)', async () => {
  const {navigator} = makeNavigator({readError: new Error('backend gone')});
  const {presentations} = await navigator.navigate(ref('obj-a'));
  assert.equal(presentations[0].kind, 'unavailable-reference');
  assert.equal(presentations[0].context.reason, 'backend gone');
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
    /referencesOfRecord/,
  );
});
