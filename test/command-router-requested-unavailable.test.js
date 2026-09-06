import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandRouter, RequestedCommandUnavailableError} from '../src/command-router.js';

// Bead z9b. `4c4` established the SAFETY rule: an explicit commandId never falls
// back to another Command. It left the DIAGNOSTICS insufficient -- an explicit id
// that could not be selected returned a silent `null`, indistinguishable from
// "the view is gone" / "no subject" / "nothing applies".
//
// These are two orthogonal defects with two orthogonal falsifiers:
//   restoring `find(...) ?? commands[0]`  -> the 4c4 proof goes red
//   returning null on an explicit miss    -> the proof below goes red
//
// The error deliberately does NOT say whether the cause was "unregistered" or
// "inapplicable here". That distinction is not needed to solve the consumer's
// problem, and it is not cleanly available anyway: `discover(subject, context)`
// forwards the caller's context to `applies`, so `commandId` may legitimately
// influence applicability.

const SUBJECT = {kind: 'ref', imageId: 'img', objectId: 'obj'};
const HANDLE = 'surface-1';

function harness({commandIds = [], discover = null} = {}) {
  const dispatched = [];
  const authorized = [];
  const commands = commandIds.map((id) => ({id}));
  const router = createCommandRouter({
    compositor: {
      viewForSurfaceHandle: (h) => (h === HANDLE
        ? {viewId: 'v', presentationDescriptor: {subject: SUBJECT}}
        : null),
    },
    commandRegistry: {discover: discover ?? (() => ({commands}))},
    authorityProvider: async (demand) => { authorized.push(demand.commandId); return {}; },
    dispatch: async (command) => { dispatched.push(command.id); return {ran: command.id}; },
  });
  return {router, dispatched, authorized};
}
const submit = (router, context) => router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context});

test('an explicit commandId that cannot be selected is LOUD, and mints no authority', async () => {
  const h = harness({commandIds: ['alpha', 'beta']});
  const error = await submit(h.router, {commandId: 'gamma'}).then(
    () => { throw new Error('it returned instead of throwing'); },
    (e) => e,
  );
  assert.ok(error instanceof RequestedCommandUnavailableError);
  assert.equal(error.name, 'RequestedCommandUnavailableError');
  assert.equal(error.commandId, 'gamma');
  assert.deepEqual(h.dispatched, [], 'nothing may dispatch');
  // A refused request must not reach the authority provider at all: authority is
  // minted per invocation for a command that RUNS.
  assert.deepEqual(h.authorized, [], 'a refused request minted authority');
});

test('the error discloses only the requested id', async () => {
  const h = harness({commandIds: ['alpha', 'beta']});
  const error = await submit(h.router, {commandId: 'gamma'}).catch((e) => e);
  const text = `${error.message} ${JSON.stringify({...error, message: error.message, name: error.name})}`;
  // No other Command's id, no registry status, no authority information.
  assert.ok(!text.includes('alpha') && !text.includes('beta'), 'the error leaked the registry contents');
  assert.ok(!/registered|unregistered|applicab/i.test(text), 'the error claims a CAUSE it cannot know');
  assert.ok(!/authority|authoriz/i.test(text), 'the error mentions authority');
});

test('an explicit commandId that CAN be selected still dispatches exactly it', async () => {
  for (const order of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const h = harness({commandIds: order});
    assert.deepEqual(await submit(h.router, {commandId: 'beta'}), {ran: 'beta'});
    assert.deepEqual(h.dispatched, ['beta']);
    assert.deepEqual(h.authorized, ['beta'], 'authority must name the Command that runs');
  }
});

test('discovery keeps the caller context, so applicability may depend on the requested id', async () => {
  // THE SUBTLE CASE. A Command whose own `applies` reads `context.commandId`
  // becomes applicable only when it is the one being asked for. This proves the
  // router still runs discovery FIRST with the full context and only selects
  // afterwards -- it has not become "look the id up, then discover", and it does
  // not strip commandId out of the context the registry forwards to `applies`.
  const seen = [];
  const discover = (subject, context) => {
    seen.push(context?.commandId);
    const commands = [{id: 'alpha'}];
    if (context?.commandId === 'beta') commands.push({id: 'beta'});
    return {commands};
  };
  const h = harness({discover});
  assert.deepEqual(await submit(h.router, {commandId: 'beta'}), {ran: 'beta'});
  assert.deepEqual(h.dispatched, ['beta']);
  assert.deepEqual(seen, ['beta'], 'discovery must receive the caller context verbatim');

  // ...and the same Command is correctly unavailable when it is not requested.
  const h2 = harness({discover});
  const error = await submit(h2.router, {commandId: 'gamma'}).catch((e) => e);
  assert.ok(error instanceof RequestedCommandUnavailableError);
  assert.deepEqual(h2.dispatched, []);
});

test('the ABSENT-id path is untouched: still a quiet default, still a quiet null', async () => {
  // z9b changes only the explicit-id branch. An absent id keeps the first
  // applicable Command, and a subject with NOTHING applicable stays an ordinary
  // quiet no-op -- it is not a programmer error and must not become loud.
  const h = harness({commandIds: ['alpha', 'beta']});
  assert.deepEqual(await submit(h.router, {}), {ran: 'alpha'});
  const empty = harness({commandIds: []});
  assert.equal(await submit(empty.router, {}), null);
  assert.deepEqual(empty.dispatched, []);
  const nulled = harness({commandIds: ['alpha']});
  assert.deepEqual(await submit(nulled.router, {commandId: null}), {ran: 'alpha'});
});

test('a dead view is still a quiet null, even with an explicit commandId', async () => {
  // The loudness is about the REQUEST being unanswerable, not about every null.
  const h = harness({commandIds: ['alpha']});
  const result = await h.router.consumeIntent({kind: 'activate'}, {
    surfaceHandle: 'dead-handle', context: {commandId: 'nope'},
  });
  assert.equal(result, null);
  assert.deepEqual(h.dispatched, []);
});
