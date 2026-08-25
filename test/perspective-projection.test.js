import assert from 'node:assert/strict';
import test from 'node:test';

import {Perspective} from '../src/index.js';
import {
  PERSPECTIVE_FORMAT_VERSION,
  decodePerspective,
  encodePerspective,
} from '../src/perspective-projection.js';

const ref = (objectId) => ({kind: 'ref', imageId: 'image:world', objectId});
const pinned = (objectId, revision) => ({
  kind: 'pinned-ref',
  imageId: 'image:world',
  objectId,
  revision: String(revision),
});

function sample() {
  return new Perspective({
    id: 'perspective:dev',
    subject: ref('project:alpha'),
    title: 'Development',
    presentations: [
      {id: 'p:insp', kind: 'object/inspector', subject: ref('object:42'), context: {pane: 'left'}, state: {open: true}},
      {id: 'p:graph', kind: 'graph/node', subject: pinned('object:7', 3)},
    ],
    layout: {kind: 'split', ratio: 0.5},
  });
}

test('a perspective encodes into a small object graph', () => {
  const {perspectiveRecord, presentationRecords} = encodePerspective(sample());

  // The Perspective record: subject is a ref slot; scalars are leaf slots.
  assert.deepEqual(perspectiveRecord.slots.subject, ref('project:alpha'));
  assert.equal(perspectiveRecord.slots.title.value, 'Development');
  assert.equal(perspectiveRecord.slots.formatVersion.value, String(PERSPECTIVE_FORMAT_VERSION));

  // One child record per presentation, ordered by ordinal.
  assert.equal(presentationRecords.length, 2);
  assert.equal(presentationRecords[0].slots.ordinal.value, '0');
  assert.equal(presentationRecords[1].slots.ordinal.value, '1');
  assert.deepEqual(presentationRecords[1].slots.subject, pinned('object:7', 3));
});

test('edges live in ref slots and scalars in leaf text/integer slots', () => {
  const {perspectiveRecord, presentationRecords} = encodePerspective(sample());

  // No metadata object anywhere in the encoded form.
  assert.equal('metadata' in perspectiveRecord, false);
  // The subject edge is a real ref Value in a slot.
  assert.equal(perspectiveRecord.slots.subject.kind, 'ref');
  // Scalars are leaf slots; none is a ref.
  for (const name of ['title', 'layout', 'formatVersion']) {
    assert.notEqual(perspectiveRecord.slots[name].kind, 'ref');
  }
  // context/state serialize to ref-free text.
  assert.equal(typeof presentationRecords[0].slots.context.value, 'string');
  assert.equal(presentationRecords[0].slots.context.value.includes('"kind":"ref"'), false);
});

test('the graph round-trips with order and pinned/unpinned preserved', () => {
  const source = sample();
  const {perspectiveRecord, presentationRecords} = encodePerspective(source);

  // Simulate durable storage as JSON and back.
  const stored = JSON.parse(JSON.stringify({perspectiveRecord, presentationRecords}));
  // Shuffle to prove decode restores ordinal order.
  const shuffled = [stored.presentationRecords[1], stored.presentationRecords[0]];

  const decoded = decodePerspective({
    id: source.id,
    perspectiveRecord: stored.perspectiveRecord,
    presentationRecords: shuffled,
  });

  assert.equal(decoded.id, source.id);
  assert.deepEqual(decoded.subject, source.subject);
  assert.equal(decoded.title, 'Development');
  assert.deepEqual(decoded.layout, {kind: 'split', ratio: 0.5});
  assert.deepEqual(decoded.presentations.map((p) => p.id), ['p:insp', 'p:graph']);
  // Pinned stays pinned, unpinned stays unpinned.
  assert.equal(decoded.presentations[0].subject.kind, 'ref');
  assert.equal(decoded.presentations[1].subject.kind, 'pinned-ref');
  assert.equal(decoded.presentations[1].subject.revision, '3');
});

test('a pinned subject on the Perspective itself stays pinned', () => {
  const source = new Perspective({id: 'p:pinned', subject: pinned('image:root', 9)});
  const {perspectiveRecord, presentationRecords} = encodePerspective(source);
  const decoded = decodePerspective({id: 'p:pinned', perspectiveRecord, presentationRecords});

  assert.equal(decoded.subject.kind, 'pinned-ref');
  assert.equal(decoded.subject.revision, '9');
});

test('duplicate ordinals keep supply order (stable sort)', () => {
  const {perspectiveRecord, presentationRecords} = encodePerspective(sample());
  // Force both children to ordinal 0; Node's sort is stable, so supply order wins.
  const colliding = presentationRecords.map((record) => ({
    slots: {...record.slots, ordinal: {kind: 'integer', value: '0'}},
  }));
  const decoded = decodePerspective({id: 'p', perspectiveRecord, presentationRecords: colliding});

  assert.deepEqual(decoded.presentations.map((p) => p.id), ['p:insp', 'p:graph']);
});

test('an empty perspective is a valid, round-trippable state', () => {
  const empty = new Perspective({id: 'p:empty', subject: ref('image:root')});
  const {perspectiveRecord, presentationRecords} = encodePerspective(empty);

  assert.equal(presentationRecords.length, 0);
  const decoded = decodePerspective({id: 'p:empty', perspectiveRecord, presentationRecords});
  assert.deepEqual(decoded.presentations, []);
  assert.equal(decoded.title, null);
});

test('a non-ref subject is rejected rather than silently dropped', () => {
  const bad = new Perspective({id: 'bad', subject: {objectRef: 'object:1'}});
  assert.throws(() => encodePerspective(bad), /must be an image ref/);
});

test('a ref hidden in context/state/layout is rejected before it reaches a text slot', () => {
  const withRefContext = new Perspective({
    id: 'p',
    subject: ref('o'),
    presentations: [{id: 'x', kind: 'k', subject: ref('o'), context: {see: ref('leak')}}],
  });
  assert.throws(() => encodePerspective(withRefContext), /must not contain a ref/);

  const withRefLayout = new Perspective({id: 'p', subject: ref('o'), layout: {target: pinned('o', 1)}});
  assert.throws(() => encodePerspective(withRefLayout), /must not contain a ref/);
});

test('formatVersion is an integer slot with a decimal-string payload', () => {
  const {perspectiveRecord} = encodePerspective(sample());
  assert.deepEqual(perspectiveRecord.slots.formatVersion, {kind: 'integer', value: '2'});
});

test('an unknown formatVersion is rejected, including abandoned v1', () => {
  const {perspectiveRecord, presentationRecords} = encodePerspective(sample());

  const v3 = JSON.parse(JSON.stringify(perspectiveRecord));
  v3.slots.formatVersion = {kind: 'integer', value: '3'};
  assert.throws(
    () => decodePerspective({id: 'p', perspectiveRecord: v3, presentationRecords}),
    /unsupported perspective formatVersion/,
  );

  // v1 (nested-array form) is abandoned: rejected, not migrated.
  const v1 = JSON.parse(JSON.stringify(perspectiveRecord));
  v1.slots.formatVersion = {kind: 'integer', value: '1'};
  assert.throws(
    () => decodePerspective({id: 'p', perspectiveRecord: v1, presentationRecords}),
    /unsupported perspective formatVersion/,
  );
});

test('decoding never produces authority from a ref', () => {
  const {perspectiveRecord, presentationRecords} = encodePerspective(sample());
  const decoded = decodePerspective({id: 'p', perspectiveRecord, presentationRecords});

  assert.deepEqual(Object.keys(decoded.subject).sort(), ['imageId', 'kind', 'objectId']);
  for (const key of Object.keys(decoded)) {
    assert.doesNotMatch(key, /author|grant|token|capab|permission/i);
  }
});

test('no session or behavior leaks into the durable form', () => {
  const source = sample();
  const {perspectiveRecord, presentationRecords} = encodePerspective(source);
  const blob = JSON.stringify({perspectiveRecord, presentationRecords});

  assert.equal(blob.includes('function'), false);
  for (const record of presentationRecords) {
    // Only the data slots exist; no callbacks, renderers or sessions.
    assert.deepEqual(
      Object.keys(record.slots).sort(),
      ['context', 'id', 'kind', 'ordinal', 'state', 'subject'],
    );
  }
});
