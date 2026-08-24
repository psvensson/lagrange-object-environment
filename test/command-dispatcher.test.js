import assert from 'node:assert/strict';
import test from 'node:test';

import {Command} from '../src/index.js';
import {
  CommandAuthorizationError,
  CommandConflictError,
  CommandExecutionError,
  CommandNotApplicableError,
  createCommandDispatcher,
} from '../src/command-dispatcher.js';

const rename = new Command({
  id: 'object/rename',
  title: 'Rename',
  appliesTo: (subject) => subject?.objectRef !== undefined,
  invoke: () => { throw new Error('invoke is the seam here'); },
});

const subject = {objectRef: 'object:42'};

function authorityError(message = 'not authorized: object/write on object:42') {
  const error = new Error(message);
  error.name = 'AuthorityError';
  error.operation = 'object/write';
  error.resource = 'object:42';
  return error;
}

function conflictError() {
  const error = new Error('object mutation conflict');
  error.name = 'ObjectMutationConflictError';
  return error;
}

test('authority is passed through per call and never retained', async () => {
  const seen = [];
  const dispatcher = createCommandDispatcher({
    image: async ({authority}) => {
      seen.push(authority);
      return 'ok';
    },
  });

  const first = {token: 'first'};
  const second = {token: 'second'};
  await dispatcher.dispatch({command: rename, subject, authority: first});
  await dispatcher.dispatch({command: rename, subject, authority: second});

  // A dispatcher that cached the first context would show it twice.
  assert.deepEqual(seen, [first, second]);
});

test('the dispatcher treats the authority context as opaque', async () => {
  let observed;
  const dispatcher = createCommandDispatcher({
    image: async ({authority}) => {
      observed = authority;
      return 'ok';
    },
  });

  const context = {grants: 'not-the-dispatchers-business'};
  await dispatcher.dispatch({command: rename, subject, authority: context});

  // Passed through by identity: not read, not re-wrapped, not validated.
  assert.equal(observed, context);
});

test('not-applicable surfaces without touching the image seam', async () => {
  let calls = 0;
  const dispatcher = createCommandDispatcher({
    image: async () => {
      calls += 1;
      return 'ok';
    },
  });

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject: {noRef: true}}),
    (error) => error instanceof CommandNotApplicableError && error.commandId === 'object/rename',
  );
  assert.equal(calls, 0);
});

test('authorization denial is typed and distinct from generic failure', async () => {
  const dispatcher = createCommandDispatcher({image: async () => { throw authorityError(); }});

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (error) => {
      assert.ok(error instanceof CommandAuthorizationError);
      assert.ok(!(error instanceof CommandConflictError));
      assert.ok(!(error instanceof CommandExecutionError));
      assert.equal(error.operation, 'object/write');
      return true;
    },
  );
});

test('revoked authority maps to the same authorization-denied type', async () => {
  const dispatcher = createCommandDispatcher({
    image: async () => { throw authorityError('authority revoked: object/write on object:42'); },
  });

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (error) => error instanceof CommandAuthorizationError,
  );
});

test('concurrency conflict is typed, surfaced, and never retried', async () => {
  let calls = 0;
  const dispatcher = createCommandDispatcher({
    image: async () => {
      calls += 1;
      throw conflictError();
    },
  });

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (error) => {
      assert.ok(error instanceof CommandConflictError);
      assert.ok(!(error instanceof CommandAuthorizationError));
      return true;
    },
  );
  // A silently-retrying dispatcher would have called the seam more than once.
  assert.equal(calls, 1);
});

test('underlying failure passes through without misclassification', async () => {
  const dispatcher = createCommandDispatcher({
    image: async () => { throw new TypeError('activation block not found: img/x'); },
  });

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (error) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.ok(!(error instanceof CommandAuthorizationError));
      assert.ok(!(error instanceof CommandConflictError));
      assert.match(error.message, /activation block not found/);
      return true;
    },
  );
});

test('the seam result is returned unmodified', async () => {
  const result = Object.freeze({updated: 'object:42', version: 3});
  const dispatcher = createCommandDispatcher({image: async () => result});

  const out = await dispatcher.dispatch({command: rename, subject, authority: {}});

  assert.equal(out, result);
});

test('concurrent dispatches keep their contexts separate', async () => {
  const seen = [];
  const dispatcher = createCommandDispatcher({
    image: async ({authority}) => {
      // Interleave: force both through a real async boundary.
      await new Promise((resolve) => setTimeout(resolve, authority.delay));
      seen.push(authority.tag);
      return authority.tag;
    },
  });

  const a = dispatcher.dispatch({command: rename, subject, authority: {tag: 'a', delay: 20}});
  const b = dispatcher.dispatch({command: rename, subject, authority: {tag: 'b', delay: 0}});
  const results = await Promise.all([a, b]);

  assert.deepEqual(results.sort(), ['a', 'b']);
  assert.equal(seen.length, 2);
});

test('error classification reads the error, not the call site', async () => {
  // A conflict-shaped error where one might expect denial must still classify
  // as conflict: the mapping follows the thrown error.
  const dispatcher = createCommandDispatcher({image: async () => { throw conflictError(); }});

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (error) => error instanceof CommandConflictError && !(error instanceof CommandAuthorizationError),
  );
});

test('a raw VersionConflictError classifies as conflict', async () => {
  // The unguarded ImageService.putObject path throws raw VersionConflictError;
  // if the adapter ever crosses it, misclassifying it as generic failure would
  // be a silent semantics change.
  const error = new Error('version conflict');
  error.name = 'VersionConflictError';
  const dispatcher = createCommandDispatcher({image: async () => { throw error; }});

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (classified) => classified instanceof CommandConflictError && !(classified instanceof CommandExecutionError),
  );
});

test('classification is idempotent for an already-typed error', async () => {
  // A seam that re-throws a dispatcher-typed error (e.g. a nested dispatcher)
  // classifies to the same type rather than collapsing to generic failure.
  const dispatcher = createCommandDispatcher({
    image: async () => { throw new CommandAuthorizationError('denied below'); },
  });

  await assert.rejects(
    dispatcher.dispatch({command: rename, subject, authority: {}}),
    (classified) => classified instanceof CommandAuthorizationError,
  );
});

test('dispatch validates its inputs eagerly', () => {
  assert.throws(() => createCommandDispatcher({}), /requires an image seam/);
  const dispatcher = createCommandDispatcher({image: async () => 'ok'});
  return assert.rejects(
    dispatcher.dispatch({command: {id: 'not-a-command'}, subject}),
    /requires a Command/,
  );
});
