import test from 'node:test';
import assert from 'node:assert/strict';

import {Perspective} from '../src/model.js';
import {
  PERSPECTIVE_FORMAT_VERSION,
  decodePerspective,
  encodePerspectiveRecord,
  encodePresentations,
} from '../src/perspective-projection.js';

const subjectRef = {kind: 'ref', imageId: 'img', objectId: 'subj-1'};
const pinnedRef = {kind: 'pinned-ref', imageId: 'img', objectId: 'subj-2', revision: 'rev-9'};

function sample() {
  return new Perspective({
    id: 'p:1',
    subject: subjectRef,
    title: 'Main',
    layout: {split: 'horizontal', ratio: 0.5},
    presentations: [
      {id: 'a', kind: 'editor', subject: subjectRef, context: {line: 12}, state: {cursor: [1, 2]}},
      {id: 'b', kind: 'inspector', subject: pinnedRef, context: {}, state: {}},
      {id: 'c', kind: 'browser', subject: subjectRef, context: {pkg: 'core'}, state: {}},
    ],
  });
}

// Encode a Perspective the way the adapter would: phase 1 (children), then
// phase 3 (Perspective with the child refs). Returns the records plus the
// child refs (simulating the ids the creation step would mint).
function encodeGraph(perspective, childRefs) {
  const presentationRecords = encodePresentations(perspective);
  const refs = childRefs ?? presentationRecords.map((_, i) => ({
    kind: 'ref', imageId: 'img', objectId: `child-${i}`,
  }));
  const perspectiveRecord = encodePerspectiveRecord(perspective, refs);
  return {perspectiveRecord, presentationRecords, childRefs: refs};
}

// A resolveChild that serves records by ref, simulating the adapter's getObject.
function resolverFor(presentationRecords, childRefs) {
  const byRef = new Map(presentationRecords.map((rec, i) => [childRefs[i].objectId, rec]));
  return async (childRef) => {
    const rec = byRef.get(childRef.objectId);
    if (!rec) throw new Error(`no such child ${childRef.objectId}`);
    return rec;
  };
}

test('encodePerspectiveRecord holds scalars in leaf slots and the ordered child refs in the indexed part', () => {
  const {perspectiveRecord, presentationRecords, childRefs} = encodeGraph(sample());
  assert.equal(perspectiveRecord.slots.title.value, 'Main');
  assert.equal(perspectiveRecord.slots.layout.value, JSON.stringify({split: 'horizontal', ratio: 0.5}));
  assert.equal(perspectiveRecord.slots.formatVersion.value, String(PERSPECTIVE_FORMAT_VERSION));
  assert.equal(perspectiveRecord.slots.subject, subjectRef);
  // The indexed part carries the ordered refs, in presentation order.
  assert.deepEqual(perspectiveRecord.indexed, childRefs);
  // No ordinal or perspective back-edge on the children (single owner of order/membership).
  for (const rec of presentationRecords) {
    assert.ok(!('ordinal' in rec.slots));
    assert.ok(!('perspective' in rec.slots));
  }
});

test('presentation children carry scalars as leaf slots and subjects as refs', () => {
  const {presentationRecords} = encodeGraph(sample());
  assert.equal(presentationRecords.length, 3);
  const [a, b] = presentationRecords;
  assert.equal(a.slots.subject, subjectRef);
  assert.equal(b.slots.subject, pinnedRef);
  assert.equal(a.slots.id.value, 'a');
  assert.equal(a.slots.kind.value, 'editor');
  assert.equal(a.slots.context.value, JSON.stringify({line: 12}));
  assert.equal(a.slots.state.value, JSON.stringify({cursor: [1, 2]}));
  assert.equal(b.slots.context.value, '{}');
});

test('round trip preserves identity, order, refs and JSON payloads', async () => {
  const source = sample();
  const {perspectiveRecord, presentationRecords, childRefs} = encodeGraph(source);
  const decoded = await decodePerspective({
    id: 'p:1',
    perspectiveRecord,
    resolveChild: resolverFor(presentationRecords, childRefs),
  });
  assert.ok(decoded instanceof Perspective);
  assert.equal(decoded.id, 'p:1');
  assert.equal(decoded.subject, subjectRef);
  assert.equal(decoded.title, 'Main');
  assert.deepEqual(decoded.layout, {split: 'horizontal', ratio: 0.5});
  assert.deepEqual(
    decoded.presentations.map((p) => p.id),
    ['a', 'b', 'c'],
    'presentation order follows the indexed part',
  );
  assert.equal(decoded.presentations[1].subject, pinnedRef);
  assert.deepEqual(decoded.presentations[0].context, {line: 12});
  assert.deepEqual(decoded.presentations[0].state, {cursor: [1, 2]});
});

test('decode enumerates children from the indexed part (forward enumeration, no supplied list)', async () => {
  // Non-trivial order: the indexed part is [c, a, b].
  const source = new Perspective({
    id: 'p:x', subject: subjectRef, title: null, layout: {},
    presentations: [
      {id: 'c', kind: 'browser', subject: subjectRef, context: {}, state: {}},
      {id: 'a', kind: 'editor', subject: subjectRef, context: {}, state: {}},
      {id: 'b', kind: 'inspector', subject: subjectRef, context: {}, state: {}},
    ],
  });
  const {perspectiveRecord, presentationRecords, childRefs} = encodeGraph(source);
  const decoded = await decodePerspective({
    id: 'p:x',
    perspectiveRecord,
    resolveChild: resolverFor(presentationRecords, childRefs),
  });
  assert.deepEqual(decoded.presentations.map((p) => p.id), ['c', 'a', 'b']);
});

test('an empty Perspective (zero presentations) round-trips', async () => {
  const empty = new Perspective({id: 'p:e', subject: subjectRef, title: null, layout: {}, presentations: []});
  const {perspectiveRecord} = encodeGraph(empty, []);
  assert.deepEqual(perspectiveRecord.indexed, []);
  const decoded = await decodePerspective({
    id: 'p:e',
    perspectiveRecord,
    resolveChild: async () => { throw new Error('should not resolve any child'); },
  });
  assert.deepEqual(decoded.presentations, []);
});

test('a non-durable (non-ref) subject is rejected at encode', () => {
  const bad = new Perspective({
    id: 'p:bad', subject: {name: 'in-memory'}, title: null, layout: {},
    presentations: [{id: 'x', kind: 'editor', subject: subjectRef, context: {}, state: {}}],
  });
  assert.throws(() => encodePerspectiveRecord(bad, [{kind: 'ref', imageId: 'img', objectId: 'c0'}]), /must be an image ref/);
});

test('refs hidden in context, state or layout are rejected', () => {
  const hidden = {kind: 'ref', imageId: 'img', objectId: 'sneaky'};
  const withRefContext = new Perspective({
    id: 'p', subject: subjectRef, title: null, layout: {},
    presentations: [{id: 'x', kind: 'editor', subject: subjectRef, context: {inner: hidden}, state: {}}],
  });
  assert.throws(() => encodePresentations(withRefContext), /must not contain a ref/);

  const withRefLayout = new Perspective({id: 'p', subject: subjectRef, title: null, layout: {bad: hidden}, presentations: []});
  assert.throws(() => encodePerspectiveRecord(withRefLayout, []), /must not contain a ref/);
});

test('formatVersion is 3; versions 1 and 2 are rejected at decode', async () => {
  const {perspectiveRecord} = encodeGraph(sample());
  assert.equal(perspectiveRecord.slots.formatVersion.value, '3');

  const v2 = {...perspectiveRecord, slots: {...perspectiveRecord.slots, formatVersion: {kind: 'integer', value: '2'}}};
  await assert.rejects(
    () => decodePerspective({id: 'p', perspectiveRecord: v2, resolveChild: async () => ({})}),
    /unsupported perspective formatVersion/,
  );

  const v1 = {...perspectiveRecord, slots: {...perspectiveRecord.slots, formatVersion: {kind: 'integer', value: '1'}}};
  await assert.rejects(
    () => decodePerspective({id: 'p', perspectiveRecord: v1, resolveChild: async () => ({})}),
    /unsupported perspective formatVersion/,
  );
});

test('decode yields a Perspective and nothing else (no authority, no extra surface)', async () => {
  const {perspectiveRecord, presentationRecords, childRefs} = encodeGraph(sample());
  const decoded = await decodePerspective({
    id: 'p', perspectiveRecord, resolveChild: resolverFor(presentationRecords, childRefs),
  });
  assert.deepEqual(Object.keys(decoded).sort(), ['id', 'layout', 'presentations', 'subject', 'title']);
});

test('childRefs length must match the presentation count at encode', () => {
  const source = sample();
  assert.throws(
    () => encodePerspectiveRecord(source, [{kind: 'ref', imageId: 'img', objectId: 'c0'}]),
    /does not match/,
  );
});

test('a non-decimal formatVersion is rejected', async () => {
  const {perspectiveRecord} = encodeGraph(sample());
  const bad = {...perspectiveRecord, slots: {...perspectiveRecord.slots, formatVersion: {kind: 'integer', value: '0x3'}}};
  await assert.rejects(
    () => decodePerspective({id: 'p', perspectiveRecord: bad, resolveChild: async () => ({})}),
    /decimal-string integer/,
  );
});
