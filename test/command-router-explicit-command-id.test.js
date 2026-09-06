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
  // HONEST SCOPE, corrected after review: this does NOT discriminate the repair.
  // `find(c => c.id === 'beta')` succeeds in both orders under the OLD selection
  // too, so this passes either way. It guards a DIFFERENT wrong implementation --
  // one that ignores `commandId` and always takes commands[0] -- which is worth
  // pinning but is not the defect this bead is about. The discriminator is the
  // absent-id test above; it is the only test here that goes red when the
  // `?? commands[0]` fallback is restored.
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
  // A DELIBERATE tension worth naming: a caller that computed an id and got null
  // arguably said "I could not determine a Command", which by this bead's own
  // principle argues for dispatching nothing. It is treated as absent because
  // that is the pre-existing behaviour and this slice changes ONLY the explicit-id
  // branch -- and because the absent-id default is relied on by the inspector's
  // own entry points. Recorded rather than silently blessed.
  const {router, dispatched} = harness(['alpha', 'beta']);
  await router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context: {commandId: null}});
  assert.deepEqual(dispatched, ['alpha'], 'an explicitly null id must fall back to the default policy');
});

test('the authority context names the Command that will actually run', async () => {
  // NOT a defence against the old fallback: the demand has ALWAYS been built from
  // the SELECTED `command.id`, so it always named the Command that ran. An earlier
  // version of this comment claimed the opposite -- that a caller could be
  // authorized for the Command it NAMED while a different one ran -- and a review
  // proved that backwards by execution. What this pins is the ordinary invariant
  // that selection happens BEFORE authorization and the two cannot disagree.
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
