import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Command,
  Perspective,
  Presentation,
  Session,
} from '../src/index.js';

test('one subject may have several semantic presentations', () => {
  const subject = Object.freeze({objectRef: 'object:42'});

  const inspector = new Presentation({
    id: 'presentation:inspector',
    subject,
    kind: 'object/inspector',
  });
  const graphNode = new Presentation({
    id: 'presentation:graph',
    subject,
    kind: 'graph/node',
  });

  assert.equal(inspector.subject, subject);
  assert.equal(graphNode.subject, subject);
  assert.notEqual(inspector.kind, graphNode.kind);
});

test('discovering a command is separate from image authorization', async () => {
  const calls = [];
  const image = {
    async renameObject(subject, name) {
      calls.push({subject, name});
      return {subject, name};
    },
  };

  const rename = new Command({
    id: 'object/rename',
    title: 'Rename',
    appliesTo: subject => subject?.objectRef !== undefined,
    invoke: (subject, {name}) => image.renameObject(subject, name),
  });

  const subject = {objectRef: 'object:42'};
  assert.equal(rename.applies(subject), true);
  await rename.run(subject, {name: 'Example'});
  assert.deepEqual(calls, [{subject, name: 'Example'}]);
});

test('perspective is durable intention while session remains mutable and local', () => {
  const perspective = new Perspective({
    id: 'perspective:development',
    subject: {projectRef: 'project:alpha'},
    title: 'Development',
    layout: {kind: 'split'},
  });

  assert.equal(Object.isFrozen(perspective), true);

  const session = new Session({
    principal: {principalRef: 'principal:peter'},
    perspective,
  });
  session.set('hovered', 'presentation:1');

  assert.equal(session.get('hovered'), 'presentation:1');
  assert.equal(perspective.layout.kind, 'split');
});

test('perspective is not a workspace container', () => {
  const image = {imageRef: 'image:shared-world'};
  const perspective = new Perspective({
    id: 'perspective:ops',
    subject: image,
    title: 'Operations',
  });

  assert.equal(perspective.subject, image);
  assert.equal('objects' in perspective, false);
});
