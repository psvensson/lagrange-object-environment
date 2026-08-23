import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGE_TYPE,
  normalizeChange,
  observeChanges,
} from '../src/index.js';

const put = (revision, objectId) => ({
  type: 'object.put',
  at: '2026-08-23T00:00:00.000Z',
  objectId,
  objectVersion: revision,
  object: {kind: 'object', id: objectId},
  revision,
});

// Collect at most `n` items from an async iterable, then abort.
async function take(iterable, n, {signal} = {}) {
  const out = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

test('catch-up replays missed events in revision order', async () => {
  const backlog = [put(1, 'a'), put(2, 'b'), put(3, 'c')];
  const seen = await take(
    observeChanges({poll: async () => backlog, afterRevision: 1, intervalMs: 0}),
    2,
  );

  assert.deepEqual(seen.map((c) => c.revision), [2, 3]);
  assert.deepEqual(seen.map((c) => c.record.id), ['b', 'c']);
});

test('live-follow never replays the backlog', async () => {
  const backlog = [put(1, 'a'), put(2, 'b'), put(3, 'c')];
  let calls = 0;
  const ac = new AbortController();
  const iterator = observeChanges({poll: async () => {
    calls += 1;
    // First poll establishes the high-water mark; later polls deliver r4.
    return calls === 1 ? backlog : [...backlog, put(4, 'd')];
  }, intervalMs: 0, signal: ac.signal});

  const first = (await take(iterator, 1))[0];

  assert.equal(first.revision, 4);
  assert.equal(first.record.id, 'd');
});

test('no duplicate yields across overlapping polls', async () => {
  const batches = [
    [put(2, 'b'), put(3, 'c')],
    [put(2, 'b'), put(3, 'c'), put(4, 'd')],
  ];
  let calls = 0;
  const seen = await take(
    observeChanges({poll: async () => batches[Math.min(calls++, batches.length - 1)], afterRevision: 1, intervalMs: 0}),
    3,
  );

  assert.deepEqual(seen.map((c) => c.revision), [2, 3, 4]);
});

test('out-of-order substrate batches are normalized to revision order', async () => {
  const batch = [put(5, 'e'), put(3, 'c'), put(4, 'd')];
  const seen = await take(
    observeChanges({poll: async () => batch, afterRevision: 2, intervalMs: 0}),
    3,
  );

  assert.deepEqual(seen.map((c) => c.revision), [3, 4, 5]);
});

test('the resume cursor advances past the last yielded revision', async () => {
  const calls = [];
  const batches = [[put(1, 'a'), put(2, 'b')], [put(3, 'c')], []];
  let callsCount = 0;
  const ac = new AbortController();
  const iterator = observeChanges({
    poll: async (afterRevision) => {
      calls.push(afterRevision);
      return batches[Math.min(callsCount++, batches.length - 1)];
    },
    afterRevision: 0,
    intervalMs: 0,
    signal: ac.signal,
  });

  // Three yields arrive from polls called with afterRevision 0 then 2; the
  // loop has not yet polled with cursor 3 when `take` stops after the 3rd yield.
  await take(iterator, 3);

  assert.deepEqual(calls, [0, 2]);
});

test('abort during sleep ends iteration with AbortError and stops polling', async () => {
  let polls = 0;
  const ac = new AbortController();
  const iterator = observeChanges({
    poll: async () => {
      polls += 1;
      return [];
    },
    afterRevision: 0,
    intervalMs: 10,
    signal: ac.signal,
  });

  const outcome = (async () => {
    try {
      for await (const _ of iterator) { /* never yields */ }
      return 'completed';
    } catch (error) {
      return error.name;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 35));
  ac.abort();
  assert.equal(await outcome, 'AbortError');
  const pollsAtAbort = polls;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(polls, pollsAtAbort);
});

test('abort before the first poll ends iteration immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  const iterator = observeChanges({poll: async () => [put(1, 'a')], afterRevision: 0, intervalMs: 0, signal: ac.signal});

  await assert.rejects(async () => {
    for await (const _ of iterator) { /* unreachable */ }
  }, (error) => error.name === 'AbortError');
});

test('normalizeChange maps each substrate put kind and preserves kind', () => {
  const cases = [
    [{type: 'object.put', revision: 1, object: {id: 'o'}}, 'o'],
    [{type: 'shape.put', revision: 2, shape: {id: 's'}}, 's'],
    [{type: 'code-artifact.put', revision: 3, artifact: {id: 'a'}}, 'a'],
    [{type: 'lexical-environment.put', revision: 4, environment: {id: 'e'}}, 'e'],
    [{type: 'block.put', revision: 5, block: {id: 'b'}}, 'b'],
  ];
  for (const [event, id] of cases) {
    const change = normalizeChange(event);
    assert.equal(change.type, CHANGE_TYPE.RECORD_PUT);
    assert.equal(change.kind, event.type);
    assert.equal(change.record.id, id);
    assert.equal(change.revision, event.revision);
  }

  const root = normalizeChange({type: 'image.root-set', revision: 6, rootObjectId: 'r'});
  assert.equal(root.type, CHANGE_TYPE.IMAGE_ROOT_SET);
  assert.equal(root.record, null);

  const created = normalizeChange({type: 'image.created', revision: 7, image: {id: 'img'}});
  assert.equal(created.type, CHANGE_TYPE.IMAGE_CREATED);
  assert.equal(created.record.id, 'img');
});

test('an unknown event type rejects rather than being silently dropped', async () => {
  const iterator = observeChanges({
    poll: async () => [{type: 'frobnicated.put', revision: 9}],
    afterRevision: 0,
    intervalMs: 0,
  });

  await assert.rejects(async () => {
    for await (const _ of iterator) { /* unreachable */ }
  }, /unknown history event type/);
});

test('revision validation rejects malformed revisions', () => {
  for (const revision of [0, 1.5, 2 ** 53, undefined, '3']) {
    assert.throws(() => normalizeChange({type: 'object.put', revision, object: {id: 'x'}}), /revision/);
  }
});

test('observeChanges validates its contract', () => {
  assert.throws(() => observeChanges({}), /requires a poll function/);
  assert.throws(() => observeChanges({poll: async () => [], afterRevision: -1}), /afterRevision/);
  assert.throws(() => observeChanges({poll: async () => [], afterRevision: 1.5}), /afterRevision/);
  assert.throws(() => observeChanges({poll: async () => [], afterRevision: 0, intervalMs: -1}), /intervalMs/);
});

test('a malformed event in live-follow high-water mark is loud, not silent', async () => {
  const iterator = observeChanges({
    poll: async () => [{type: 'object.put', object: {id: 'x'}}], // no revision
    intervalMs: 0,
  });

  await assert.rejects(async () => {
    for await (const _ of iterator) { /* unreachable */ }
  }, /must carry a revision/);
});
