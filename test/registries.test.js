import test from 'node:test';
import assert from 'node:assert/strict';

import {Command, Presentation} from '../src/model.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {createCommandRegistry} from '../src/command-registry.js';

const subject = {kind: 'ref', imageId: 'img', objectId: 'obj-1'};

function presentationOf(id, subj = subject) {
  return new Presentation({id, subject: subj, kind: 'inspector', context: {}, state: {}});
}

// --- PresentationRegistry ---------------------------------------------------

test('presentation discovery returns Presentations from providers that can present, in registration order', () => {
  const registry = createPresentationRegistry();
  registry.register({id: 'a', present: (s) => (s.objectId === 'obj-1' ? presentationOf('pa', s) : null)});
  registry.register({id: 'b', present: () => null});
  registry.register({id: 'c', present: (s) => presentationOf('pc', s)});

  const {presentations, failures} = registry.discover(subject);
  assert.deepEqual(presentations.map((p) => p.id), ['pa', 'pc'], 'registration order, nulls dropped');
  assert.deepEqual(failures, []);
  for (const p of presentations) assert.ok(p instanceof Presentation);
});

test('reversing registration order reverses discovery order (no priority field)', () => {
  const registry = createPresentationRegistry();
  registry.register({id: 'first', present: (s) => presentationOf('first-p', s)});
  registry.register({id: 'second', present: (s) => presentationOf('second-p', s)});
  assert.deepEqual(registry.discover(subject).presentations.map((p) => p.id), ['first-p', 'second-p']);

  const reversed = createPresentationRegistry();
  reversed.register({id: 'second', present: (s) => presentationOf('second-p', s)});
  reversed.register({id: 'first', present: (s) => presentationOf('first-p', s)});
  assert.deepEqual(reversed.discover(subject).presentations.map((p) => p.id), ['second-p', 'first-p']);
});

test('a provider returning a non-Presentation is a fail-fast programming error', () => {
  const registry = createPresentationRegistry();
  registry.register({id: 'bad', present: () => ({not: 'a presentation'})});
  assert.throws(() => registry.discover(subject), /non-Presentation/);
});

test('a throwing provider is isolated from the others and its failure is surfaced, not swallowed', () => {
  const registry = createPresentationRegistry();
  registry.register({id: 'good-1', present: (s) => presentationOf('g1', s)});
  registry.register({id: 'broken', present: () => { throw new Error('boom'); }});
  registry.register({id: 'good-2', present: (s) => presentationOf('g2', s)});

  const {presentations, failures} = registry.discover(subject);
  assert.deepEqual(presentations.map((p) => p.id), ['g1', 'g2'], 'one bad provider does not poison the set');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].providerId, 'broken');
  assert.match(failures[0].error.message, /boom/);
});

test('presentation providers are disjoint by subject kind (an unavailable-ref provider does not race the inspector)', () => {
  const registry = createPresentationRegistry();
  registry.register({id: 'inspector', present: (s) => (s.kind === 'ref' ? presentationOf('insp', s) : null)});
  registry.register({id: 'unavailable', present: (s) => (s.kind === 'unavailable-ref' ? presentationOf('unavail', s) : null)});

  assert.deepEqual(registry.discover({kind: 'ref', imageId: 'i', objectId: 'o'}).presentations.map((p) => p.id), ['insp']);
  assert.deepEqual(registry.discover({kind: 'unavailable-ref', reason: 'denied'}).presentations.map((p) => p.id), ['unavail']);
});

test('register validates the provider shape eagerly', () => {
  const registry = createPresentationRegistry();
  assert.throws(() => registry.register(null), /must be an object/);
  assert.throws(() => registry.register({present: () => null}), /non-empty id/);
  assert.throws(() => registry.register({id: 'x'}), /present\(subject, context\) function/);
});

// --- CommandRegistry --------------------------------------------------------

function commandOf(id, applies) {
  return new Command({id, title: id, appliesTo: applies, invoke: () => {}});
}

test('command discovery returns applicable Commands in registration order, applicability-only', () => {
  const registry = createCommandRegistry();
  registry.register(commandOf('yes-1', () => true));
  registry.register(commandOf('no', () => false));
  registry.register(commandOf('yes-2', () => true));

  const {commands, failures} = registry.discover(subject);
  assert.deepEqual(commands.map((c) => c.id), ['yes-1', 'yes-2']);
  assert.deepEqual(failures, []);
});

test('an applicable-but-unauthorized command is still discovered (discovery never filters on authority)', () => {
  const registry = createCommandRegistry();
  // This command's invoke would be denied at the image boundary; discovery must
  // NOT consult authority and must still return it.
  const denied = new Command({
    id: 'delete', title: 'Delete', appliesTo: () => true,
    invoke: () => { throw new Error('not authorized'); },
  });
  registry.register(denied);
  const {commands} = registry.discover(subject, {});
  assert.deepEqual(commands.map((c) => c.id), ['delete'], 'discovery is applicability-only, not authorization');
});

test('a command whose appliesTo throws is treated as not applicable, isolated, and surfaced', () => {
  const registry = createCommandRegistry();
  registry.register(commandOf('ok', () => true));
  registry.register(new Command({id: 'broken', title: 'broken', appliesTo: () => { throw new Error('cannot decide'); }, invoke: () => {}}));
  registry.register(commandOf('also-ok', () => true));

  const {commands, failures} = registry.discover(subject);
  assert.deepEqual(commands.map((c) => c.id), ['ok', 'also-ok'], 'one bad appliesTo does not abort discovery');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].commandId, 'broken');
});

test('register requires a Command instance', () => {
  const registry = createCommandRegistry();
  assert.throws(() => registry.register({id: 'not-a-command'}), /Command instances/);
});

// --- Separation + purity -----------------------------------------------------

test('the two registries are separate owners: presentation discovery never yields Commands and vice versa', () => {
  const pres = createPresentationRegistry();
  const cmd = createCommandRegistry();
  pres.register({id: 'p', present: (s) => presentationOf('pp', s)});
  cmd.register(commandOf('c', () => true));

  const presResult = pres.discover(subject);
  const cmdResult = cmd.discover(subject);
  for (const p of presResult.presentations) assert.ok(p instanceof Presentation);
  for (const c of cmdResult.commands) assert.ok(c instanceof Command);
  assert.equal(presResult.commands, undefined, 'presentation discovery has no command surface');
  assert.equal(cmdResult.presentations, undefined, 'command discovery has no presentation surface');
});

test('the registries are constructed with no authority or image dependency (purity)', () => {
  // Both factories take no arguments and the registries hold no adapter/authority.
  const pres = createPresentationRegistry();
  const cmd = createCommandRegistry();
  assert.equal(createPresentationRegistry.length, 0);
  assert.equal(createCommandRegistry.length, 0);
  // Discovery works on a plain frozen subject with no image round-trip.
  pres.register({id: 'p', present: () => presentationOf('x')});
  cmd.register(commandOf('c', () => true));
  assert.equal(pres.discover(Object.freeze({objectId: 'plain'})).presentations.length, 1);
  assert.equal(cmd.discover(Object.freeze({objectId: 'plain'})).commands.length, 1);
});
