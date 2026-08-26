import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGE_TYPE,
  normalizeChange,
  observeChanges,
} from '../src/index.js';

// The lane contract (substrate ADR 0070 image-observation-binding/v1):
//   poll(afterCursor: string) -> {events: [{objectId, kind, cursor}], cursor}
// The cursor is an OPAQUE string token (obs-cursor/v1:...), never a number;
// events are metadata-only invalidations (identity + kind + per-event cursor;
// no record payload, no global revision). These fakes mint shaped opaque
// tokens; the real lane's tokens are encrypted and non-comparable.
const token = (name) => `obs-cursor/v1:fake-${name}`;
const obs = (objectId, cursorName, kind = 'object.put') => ({
  objectId,
  kind,
  cursor: token(cursorName),
});
const page = (events, cursorName) => ({events, cursor: token(cursorName)});

// Collect at most `n` items from an async iterable, then abort.
async function take(iterable, n) {
  const out = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

test('live-follow starts with an empty afterCursor and replays no backlog', async () => {
  const calls = [];
  const seen = await take(
    observeChanges({
      poll: async (afterCursor) => {
        calls.push(afterCursor);
        return calls.length === 1 ? page([], 'hw') : page([obs('d', 'd')], 'after-d');
      },
      intervalMs: 0,
    }),
    1,
  );

  assert.equal(calls[0], '', 'the first poll live-follows with an empty afterCursor');
  assert.deepEqual(seen.map((c) => c.objectId), ['d']);
});

test('the resume cursor is the result high-water token, never arithmetic', async () => {
  const calls = [];
  const batches = [
    page([obs('a', 'a'), obs('b', 'b')], 'after-b'),
    page([obs('c', 'c')], 'after-c'),
    page([], 'after-c'),
  ];
  let callsCount = 0;
  const seen = await take(
    observeChanges({
      poll: async (afterCursor) => {
        calls.push(afterCursor);
        return batches[Math.min(callsCount++, batches.length - 1)];
      },
      afterCursor: token('stored-resume'),
      intervalMs: 0,
    }),
    3,
  );

  // The next poll is fed the previous result's opaque cursor verbatim — not a
  // per-event cursor, and never a number derived from anything.
  assert.deepEqual(calls, [token('stored-resume'), token('after-b')]);
  assert.deepEqual(seen.map((c) => c.objectId), ['a', 'b', 'c']);
});

test('no duplicate yields across overlapping polls (a valid older cursor idempotently re-emits)', async () => {
  // The lane's rollback-safe resume means a consumer that resumed from an
  // older VALID token may see the same invalidation again; the consumer-level
  // contract is that invalidations are idempotent (re-read the object). The
  // loop itself adds no de-duplication or numeric filtering — that is owned
  // lane-side — it yields exactly what the lane returns, in lane order.
  const batches = [
    page([obs('a', 'a'), obs('b', 'b')], 'after-b'),
    page([obs('c', 'c')], 'after-c'),
  ];
  let calls = 0;
  const seen = await take(
    observeChanges({poll: async () => batches[Math.min(calls++, batches.length - 1)], afterCursor: token('c0'), intervalMs: 0}),
    3,
  );

  assert.deepEqual(seen.map((c) => c.objectId), ['a', 'b', 'c']);
});

test('the normalized Change is a metadata-only invalidation: identity + kind + cursor, NO record, NO revision', async () => {
  const seen = await take(
    observeChanges({
      poll: async (afterCursor) => (afterCursor === ''
        ? page([], 'hw')
        : page([obs('object-1', 'e1')], 'after-e1')),
      intervalMs: 0,
    }),
    1,
  );

  const change = seen[0];
  assert.equal(change.type, CHANGE_TYPE.RECORD_PUT);
  assert.equal(change.kind, 'object.put');
  assert.equal(change.objectId, 'object-1');
  assert.equal(change.cursor, token('e1'));
  // The restricted-feed contract: no payload and no ordering number, ever.
  assert.ok(!('record' in change), 'the Change must not carry a record payload');
  assert.ok(!('revision' in change), 'the Change must not carry a global revision');
  assert.deepEqual(Object.keys(change).sort(), ['cursor', 'kind', 'objectId', 'type']);
  // The cursor is an opaque string, not a number.
  assert.equal(typeof change.cursor, 'string');
  assert.ok(Number.isNaN(Number(change.cursor)), 'the cursor is not parseable as a number');
});

test('abort during sleep ends iteration with AbortError and stops polling', async () => {
  let polls = 0;
  const ac = new AbortController();
  const iterator = observeChanges({
    poll: async () => {
      polls += 1;
      return page([], `hw-${polls}`);
    },
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
  const iterator = observeChanges({poll: async () => page([obs('a', 'a')], 'hw'), intervalMs: 0, signal: ac.signal});

  await assert.rejects(async () => {
    for await (const _ of iterator) { /* unreachable */ }
  }, (error) => error.name === 'AbortError');
});

test('normalizeChange maps an obs-event and preserves kind; unknown kinds are not invented as record.put', () => {
  const change = normalizeChange({objectId: 'o', kind: 'object.put', cursor: token('x')});
  assert.equal(change.type, CHANGE_TYPE.RECORD_PUT);
  assert.equal(change.kind, 'object.put');
  assert.equal(change.objectId, 'o');
  assert.ok(!('record' in change) && !('revision' in change));

  // A future lane kind passes through as its own type (never silently folded
  // into record.put); v1 emits object.put only.
  const other = normalizeChange({objectId: 's', kind: 'shape.put', cursor: token('y')});
  assert.equal(other.type, 'shape.put');
  assert.equal(other.kind, 'shape.put');
});

test('normalizeChange rejects malformed events rather than inventing an invalidation', () => {
  assert.throws(() => normalizeChange(null), /must be an object/);
  assert.throws(() => normalizeChange({kind: 'object.put', cursor: token('x')}), /objectId/);
  assert.throws(() => normalizeChange({objectId: 'o', cursor: token('x')}), /kind/);
  assert.throws(() => normalizeChange({objectId: 'o', kind: 'object.put'}), /cursor/);
  assert.throws(() => normalizeChange({objectId: 'o', kind: 'object.put', cursor: 7}), /cursor/);
});

test('observeChanges validates its contract', () => {
  assert.throws(() => observeChanges({}), /requires a poll function/);
  assert.throws(() => observeChanges({poll: async () => page([], 'hw'), afterCursor: 0}), /afterCursor/);
  assert.throws(() => observeChanges({poll: async () => page([], 'hw'), afterCursor: 3}), /afterCursor/);
  assert.throws(() => observeChanges({poll: async () => page([], 'hw'), intervalMs: -1}), /intervalMs/);
});

test('a malformed lane result is loud, not silent', async () => {
  const noEvents = observeChanges({poll: async () => ({cursor: token('hw')}), intervalMs: 0});
  await assert.rejects(async () => {
    for await (const _ of noEvents) { /* unreachable */ }
  }, /events list/);

  const noCursor = observeChanges({poll: async () => ({events: []}), intervalMs: 0});
  await assert.rejects(async () => {
    for await (const _ of noCursor) { /* unreachable */ }
  }, /cursor string/);

  const numericCursor = observeChanges({poll: async () => ({events: [], cursor: 3}), intervalMs: 0});
  await assert.rejects(async () => {
    for await (const _ of numericCursor) { /* unreachable */ }
  }, /cursor string/);
});
