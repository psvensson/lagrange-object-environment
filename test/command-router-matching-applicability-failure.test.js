import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandRouter, RequestedCommandUnavailableError} from '../src/command-router.js';
import {createCommandRegistry} from '../src/command-registry.js';
import {Command} from '../src/model.js';

// Bead 1yb. `z9b` made an unselectable EXPLICIT request loud instead of a silent
// null, and collapsed two causes into one error on purpose: "unregistered" and
// "successfully evaluated and inapplicable here" are not separable from this
// owner, because `discover(subject, context)` forwards the caller's context to
// `applies`, so `commandId` may legitimately influence applicability.
//
// That collapse covers ONLY that pair, and z9b's prose overstated it into "the
// cause is not cleanly available anyway". A THIRD case is diagnosable and was
// being thrown away: `CommandRegistry.discover` returns `{commands, failures}`,
// where a failure is `{commandId, error}` for a Command whose own `applies`
// THREW -- surfaced there rather than swallowed, by the registry's own contract.
// The router destructured `{commands}` alone, so a requested Command that
// CRASHED while deciding applicability -- a real programmer error ALREADY handed
// to this owner -- was reported identically to a typo'd id.
//
// The repair consumes information the router already has. It needs no
// `CommandRegistry.has(id)`, no lookup before discovery, no wrapper error and no
// `cause`: the matching failure's error is rethrown EXACTLY.
//
//     if an applicable Command X exists     -> authorize and dispatch X
//     else if failures has an entry for X   -> throw that entry.error, unchanged
//     else                                  -> RequestedCommandUnavailableError(X)
//
// "Unchanged" is a claim about the VALUE, not about a stack: JavaScript permits
// `throw 'boom'` / `throw null` / `throw undefined`, and CommandRegistry captures
// whatever was thrown without requiring `instanceof Error`. The rethrow is the
// same thrown value either way -- which preserves Error identity, stack and
// structured information WHEN an Error is what was thrown. The proofs below use
// real Errors, a legitimate concrete specimen of that contract; the general
// wording is deliberately no stronger than the contract, and no test hardens the
// non-Error case, which has no consumer pressure behind it.
//
// Ownership is the point: CommandRegistry owns applicability and the original
// programmer error; CommandRouter owns only WHICH discovery result belongs to the
// explicit request, and invents no message for something the registry knows.
//
// FALSIFIERS ACTUALLY RUN against this file plus the 4c4, z9b and input-binding
// files (32 tests). Reported from the observed result, not from what each
// perturbation was expected to do, and they are NOT disjoint:
//   ignore the matching failure.error       -> 3 RED: both identity proofs here
//                                              and the shell's end-to-end
//                                              onInputError-identity proof.
//   throw failures[0] regardless of the id  -> 1 RED: the no-LEAK proof. The
//                                              identity proofs still PASS, so
//                                              they are blind to this one --
//                                              which is why both are needed.
//   restore find(...) ?? commands[0]        -> 6 RED across 4c4, z9b and the
//                                              shell. It breaks every property
//                                              at once and is strictly the worst
//                                              case, not an independent axis.
//                                              It leaves THIS file's identity
//                                              proofs green, because with nothing
//                                              applicable there is no wrong
//                                              Command to fall back to.
//   strip commandId before discovery        -> 1 RED, and nothing in this file
//                                              notices: that proof lives in the
//                                              z9b file and must stay green, as
//                                              it is what shows this did not
//                                              become "look X up, then discover".
//   consider the failure BEFORE an
//   applicable match                        -> 1 RED: the order proof below.

const SUBJECT = {kind: 'ref', imageId: 'img', objectId: 'obj'};
const HANDLE = 'surface-1';

function harness({discover}) {
  const dispatched = [];
  const authorized = [];
  const router = createCommandRouter({
    compositor: {
      viewForSurfaceHandle: (h) => (h === HANDLE
        ? {viewId: 'v', presentationDescriptor: {subject: SUBJECT}}
        : null),
    },
    commandRegistry: {discover},
    authorityProvider: async (demand) => { authorized.push(demand.commandId); return {}; },
    dispatch: async (command) => { dispatched.push(command.id); return {ran: command.id}; },
  });
  return {router, dispatched, authorized};
}
const submit = (router, context) => router.consumeIntent({kind: 'activate'}, {surfaceHandle: HANDLE, context});
const rejection = (promise) => promise.then(
  () => { throw new Error('it returned instead of throwing'); },
  (e) => e,
);

// --- the load-bearing claim: EXACT error identity ----------------------------

test('a requested Command whose applies THREW rejects with that EXACT error', async () => {
  const sentinel = new TypeError('cannot read properties of undefined (reading "selector")');
  const h = harness({
    discover: () => ({commands: [], failures: [{commandId: 'replace-native-method', error: sentinel}]}),
  });

  const error = await rejection(submit(h.router, {commandId: 'replace-native-method'}));

  // Identity, not resemblance: the SAME object. For an Error -- what a crashing
  // `applies` throws in practice, and what this proof uses -- that is what keeps
  // the lower owner's stack and any structured information it already carries
  // intact. A wrapper or a `cause` would pass a name/message check and fail this.
  assert.equal(error, sentinel);
  assert.ok(!(error instanceof RequestedCommandUnavailableError), 'it is not an "unavailable" error at all');
  assert.deepEqual(h.dispatched, [], 'nothing may dispatch');
  assert.deepEqual(h.authorized, [], 'a refused request never reaches the authorityProvider');
});

test('the real CommandRegistry hands the router the real error, and the router relays it', async () => {
  // No hand-built failure entry: the registry produces it from a Command that
  // genuinely crashes, so this pins the two owners' contracts TOGETHER.
  const boom = new TypeError('applies() read a field of undefined');
  const registry = createCommandRegistry();
  registry.register(new Command({
    id: 'replace-native-method',
    title: 'Replace',
    appliesTo: () => { throw boom; },
    invoke: () => { throw new Error('invoke must never run'); },
  }));

  const discovered = registry.discover(SUBJECT, {commandId: 'replace-native-method'});
  assert.deepEqual(discovered.commands.map((c) => c.id), [], 'a crashing applies is not applicable');
  assert.deepEqual(discovered.failures.map((f) => f.commandId), ['replace-native-method']);
  assert.equal(discovered.failures[0].error, boom, 'the registry surfaces the original error');

  const h = harness({discover: (subject, context) => registry.discover(subject, context)});
  const error = await rejection(submit(h.router, {commandId: 'replace-native-method'}));

  assert.equal(error, boom, 'the router relays it unchanged -- same object, from registry to caller');
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.authorized, []);
});

// --- an unrelated failure must not poison, and must not leak -----------------

test('an unrelated Command failing applies does not poison a different, applicable request', async () => {
  const unrelated = new Error('alpha exploded deciding applicability');
  const h = harness({
    discover: () => ({commands: [{id: 'beta'}], failures: [{commandId: 'alpha', error: unrelated}]}),
  });

  const result = await submit(h.router, {commandId: 'beta'});

  assert.deepEqual(result, {ran: 'beta'}, 'beta dispatches normally');
  assert.deepEqual(h.dispatched, ['beta']);
  assert.deepEqual(h.authorized, ['beta'], 'authority is minted for the Command that actually ran');
});

test('an unrelated failure never leaks into the generic unavailable answer', async () => {
  const unrelated = new Error('alpha exploded deciding applicability');
  const h = harness({
    discover: () => ({commands: [{id: 'beta'}], failures: [{commandId: 'alpha', error: unrelated}]}),
  });

  const error = await rejection(submit(h.router, {commandId: 'gamma'}));

  assert.ok(error instanceof RequestedCommandUnavailableError, 'gamma is plainly unavailable');
  assert.equal(error.commandId, 'gamma');
  assert.notEqual(error, unrelated);
  // z9b's non-leak contract is unchanged by 1yb: only the requested id, and
  // nothing about any other Command -- including one that failed.
  assert.deepEqual(
    Object.getOwnPropertyNames(error).sort(),
    ['commandId', 'message', 'name', 'stack'].sort(),
    'the error still carries ONLY the requested id',
  );
  assert.ok(!error.message.includes('alpha'), 'no other Command id appears');
  assert.deepEqual(h.dispatched, [], 'nothing may dispatch');
  assert.deepEqual(h.authorized, [], 'a refused request mints no authority');
});

// --- the specified order: an applicable match wins over a failure entry ------

test('an applicable Command wins over a failure entry carrying the same id', async () => {
  // Only reachable when a discovery result carries BOTH for one id, i.e. under
  // duplicate Command ids. This pins the router's ORDER -- applicable first,
  // matching failure only when nothing applicable answers -- by following the
  // ordered discovery result mechanically. It decides NO id-uniqueness policy;
  // that is the registry's question, and this slice does not open it.
  const shadowed = new Error('the OTHER command with this id crashed');
  const h = harness({
    discover: () => ({commands: [{id: 'beta'}], failures: [{commandId: 'beta', error: shadowed}]}),
  });

  assert.deepEqual(await submit(h.router, {commandId: 'beta'}), {ran: 'beta'});
  assert.deepEqual(h.dispatched, ['beta']);
  assert.deepEqual(h.authorized, ['beta']);
});

// --- the default path is untouched ------------------------------------------

test('with NO explicit commandId, discovery failures keep their existing semantics', async () => {
  const unrelated = new Error('alpha exploded deciding applicability');
  const h = harness({
    discover: () => ({commands: [{id: 'beta'}], failures: [{commandId: 'alpha', error: unrelated}]}),
  });

  // Unchanged default policy: the first APPLICABLE Command. A failure entry is
  // not an applicable Command and does not become one, and 1yb deliberately does
  // not widen into "how should default invocation report applicability failures?"
  assert.deepEqual(await submit(h.router, {}), {ran: 'beta'});
  assert.deepEqual(h.dispatched, ['beta']);
});

test('with NO explicit commandId and nothing applicable, a failure is still a quiet null', async () => {
  const unrelated = new Error('alpha exploded deciding applicability');
  const h = harness({
    discover: () => ({commands: [], failures: [{commandId: 'alpha', error: unrelated}]}),
  });

  assert.equal(await submit(h.router, {}), null, 'the absent-id path stays quiet');
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.authorized, []);
});
