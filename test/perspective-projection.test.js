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

test('perspective round-trips through its durable representation', () => {
  const perspective = new Perspective({
    id: 'perspective:development',
    subject: ref('project:alpha'),
    title: 'Development',
    presentations: [
      {
        id: 'presentation:inspector',
        kind: 'object/inspector',
        subject: ref('object:42'),
        context: {pane: 'left'},
        state: {expanded: true},
      },
    ],
    layout: {kind: 'split', ratio: 0.5},
  });

  const encoded = encodePerspective(perspective);
  // The durable form must be plain JSON-compatible data.
  const serialized = JSON.parse(JSON.stringify(encoded));
  const decoded = decodePerspective({id: perspective.id, ...serialized});

  assert.equal(decoded.id, perspective.id);
  assert.deepEqual(decoded.subject, perspective.subject);
  assert.equal(decoded.title, 'Development');
  assert.deepEqual(decoded.layout, {kind: 'split', ratio: 0.5});
  assert.equal(decoded.presentations.length, 1);
  assert.equal(decoded.presentations[0].kind, 'object/inspector');
  assert.deepEqual(decoded.presentations[0].subject, ref('object:42'));
});

test('edges live in slots and scalars in metadata', () => {
  const encoded = encodePerspective(
    new Perspective({id: 'p', subject: ref('object:1'), title: 'T', layout: {kind: 'stack'}}),
  );

  assert.deepEqual(encoded.slots.subject, ref('object:1'));
  // Metadata must carry scalars/layout and must not contain any ref.
  assert.equal(encoded.metadata.title, 'T');
  assert.deepEqual(encoded.metadata.layout, {kind: 'stack'});
  assert.equal(JSON.stringify(encoded.metadata).includes('"kind":"ref"'), false);
  assert.equal(JSON.stringify(encoded.metadata).includes('"pinned-ref"'), false);
});

test('pinned and unpinned subject refs stay distinct across a round trip', () => {
  const live = new Perspective({id: 'live', subject: ref('object:1')});
  const bookmark = new Perspective({id: 'bookmark', subject: pinned('object:1', 7)});

  const liveRoundTrip = decodePerspective({id: 'live', ...encodePerspective(live)});
  const bookmarkRoundTrip = decodePerspective({id: 'bookmark', ...encodePerspective(bookmark)});

  assert.equal(liveRoundTrip.subject.kind, 'ref');
  assert.equal('revision' in liveRoundTrip.subject, false);
  assert.equal(bookmarkRoundTrip.subject.kind, 'pinned-ref');
  assert.equal(bookmarkRoundTrip.subject.revision, '7');
});

test('a non-ref, non-null subject is rejected rather than silently dropped', () => {
  const bad = new Perspective({id: 'bad', subject: {objectRef: 'object:1'}});

  assert.throws(() => encodePerspective(bad), /must be an image ref/);
});

test('a null subject is rejected, matching the current Perspective model', () => {
  // The in-memory Perspective requires a subject; the durable form must not
  // silently invent an "unbound" concept the model has not decided on.
  const encoded = encodePerspective(new Perspective({id: 'p', subject: ref('object:1')}));
  encoded.slots.subject = null;

  assert.throws(() => decodePerspective({id: 'p', ...encoded}), /must be an image ref/);
});

test('decoding never produces authority from a ref', () => {
  const encoded = encodePerspective(new Perspective({id: 'p', subject: ref('secret:object')}));
  const decoded = decodePerspective({id: 'p', ...encoded});

  // The decoded perspective holds data only. There is no grant, token or
  // authorization context, and the subject is an inert tagged record.
  assert.equal(typeof decoded.subject, 'object');
  assert.deepEqual(Object.keys(decoded.subject).sort(), ['imageId', 'kind', 'objectId']);
  for (const key of Object.keys(decoded)) {
    assert.doesNotMatch(key, /author|grant|token|capab|permission/i);
  }
});

test('session-shaped state cannot smuggle into the durable form', () => {
  const perspective = new Perspective({
    id: 'p',
    subject: ref('object:1'),
    presentations: [
      {id: 'pres', kind: 'object/inspector', subject: ref('object:1'), state: {hover: 'x'}},
    ],
  });

  const encoded = encodePerspective(perspective);
  const blob = JSON.stringify(encoded);

  // Durable state is data; nothing function-valued survives, and there is no
  // channel for callbacks by construction.
  assert.equal(blob.includes('function'), false);
  for (const p of encoded.slots.presentations) {
    for (const value of Object.values(p.state)) {
      assert.equal(typeof value === 'function', false);
    }
  }
});

test('a function-valued presentation field is dropped, not serialized', () => {
  // Presentations in memory may carry renderer-era conveniences; the durable
  // form keeps only the data contract {id, kind, subject, context, state}.
  const perspective = new Perspective({
    id: 'p',
    subject: ref('object:1'),
    presentations: [
      {
        id: 'pres',
        kind: 'object/inspector',
        subject: ref('object:1'),
        onSelect: () => 'side-effect',
      },
    ],
  });

  const encoded = encodePerspective(perspective);
  const presentation = encoded.slots.presentations[0];

  assert.deepEqual(Object.keys(presentation).sort(), ['context', 'id', 'kind', 'state', 'subject']);
  assert.equal('onSelect' in presentation, false);
});

test('an unknown formatVersion is rejected rather than guessed', () => {
  const encoded = encodePerspective(new Perspective({id: 'p', subject: ref('object:1')}));
  encoded.metadata.formatVersion = PERSPECTIVE_FORMAT_VERSION + 1;

  assert.throws(() => decodePerspective({id: 'p', ...encoded}), /unsupported perspective formatVersion/);
});

test('a non-ref durable presentation subject is rejected', () => {
  const encoded = encodePerspective(new Perspective({id: 'p', subject: ref('object:1')}));
  encoded.slots.presentations = [
    {id: 'pres', kind: 'object/inspector', subject: {not: 'a-ref'}, context: {}, state: {}},
  ];

  assert.throws(() => decodePerspective({id: 'p', ...encoded}), /must be an image ref/);
});
