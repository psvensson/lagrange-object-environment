import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandRouter} from '../src/command-router.js';

// An explicit `context.commandId` is a STATEMENT OF INTENT: it dispatches exactly
// that Command, or nothing. It must never degrade to another applicable Command.
//
// THE WRONG IMPLEMENTATION THIS KILLS, named before the proofs: the selection
// `commands.find((c) => c.id === context.commandId) ?? commands[0]` -- a caller
// asks for X, X is absent or inapplicable, and Y runs against its subject.
//
// Every assertion below is against a DISPATCH COUNTER, never a null return alone:
// `consumeIntent` already answers null for three unrelated reasons (the view is
// gone, the view has no subject, nothing applies), so a null result does not by
// itself prove that nothing ran.

const SUBJECT = {kind: 'ref', imageId: 'img', objectId: 'obj'};
const HANDLE = 'surface-1';

function harness(commandIds) {
  const dispatched = [];
  const commands = commandIds.map((id) => ({id, run: async () => ({ran: id})}));
  const router = createCommandRouter({
    compositor: {
      viewForSurfaceHandle: (h) => (h === HANDLE
        ? {viewId: 'v', presentationDescriptor: {subject: SUBJECT}}
        : null),
    },
    commandRegistry: {discover: () => ({commands})},
    authorityProvider: async () => ({kind: 'authority'}),
    dispatch: async (command) => {
      dispatched.push(command.id);
      return {ran: command.id};
    },
  });
  return {router, dispatched};
}

test('an explicit commandId that is absent dispatches NOTHING', async () => {
  const {router, dispatched} = harness(['alpha', 'beta']);
  const result = await router.consumeIntent({kind: 'activate'}, {
    surfaceHandle: HANDLE, context: {commandId: 'gamma-does-not-exist'},
  });
  assert.equal(result, null);
  assert.deepEqual(dispatched, [],
    'a caller asked for an absent Command and another one RAN against its subject');
});

test('an explicit commandId dispatches EXACTLY that Command, whatever the registration order', async () => {
  // Order-dependence is precisely what the `?? commands[0]` fallback hid: asking
  // for the FIRST registered Command would have passed under both the correct and
  // the broken implementation.
  for (const order of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const {router, dispatched} = harness(order);
    const result = await router.consumeIntent({kind: 'activate'}, {
      surfaceHandle: HANDLE, context: {commandId: 'beta'},
    });
    assert.deepEqual(result, {ran: 'beta'});
    assert.deepEqual(dispatched, ['beta'], `registration order ${order.join(',')}`);
  }
});

test('with NO commandId the existing default is unchanged: the first applicable Command', async () => {
  // The repair must not change the unspecified-id policy, which was never the
  // defect.
  const {router, dispatched} = harness(['alpha', 'beta']);
  const result = await router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context: {}});
  assert.deepEqual(result, {ran: 'alpha'});
  assert.deepEqual(dispatched, ['alpha']);
});

test('an explicit commandId is honoured even when it is the ONLY applicable Command', async () => {
  const {router, dispatched} = harness(['alpha']);
  await router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context: {commandId: 'alpha'}});
  assert.deepEqual(dispatched, ['alpha']);
});

test('an explicit commandId against an EMPTY applicable set dispatches nothing', async () => {
  const {router, dispatched} = harness([]);
  const result = await router.consumeIntent({kind: 'activate'}, {
    surfaceHandle: HANDLE, context: {commandId: 'alpha'},
  });
  assert.equal(result, null);
  assert.deepEqual(dispatched, []);
});

test('a null commandId is treated as absent, not as a Command named null', async () => {
  const {router, dispatched} = harness(['alpha', 'beta']);
  await router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context: {commandId: null}});
  assert.deepEqual(dispatched, ['alpha'], 'an explicitly null id must fall back to the default policy');
});

test('the authority context names the Command that will actually run', async () => {
  // The authority demand is built from `command.id`. Under the old fallback a
  // caller could be authorized for the Command it NAMED while a different one
  // ran -- so this is not merely cosmetic.
  const seen = [];
  const commands = [{id: 'alpha'}, {id: 'beta'}];
  const router = createCommandRouter({
    compositor: {viewForSurfaceHandle: () => ({viewId: 'v', presentationDescriptor: {subject: SUBJECT}})},
    commandRegistry: {discover: () => ({commands})},
    authorityProvider: async (demand) => { seen.push(demand.commandId); return {}; },
    dispatch: async (command) => ({ran: command.id}),
  });
  await router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context: {commandId: 'beta'}});
  assert.deepEqual(seen, ['beta']);
});
