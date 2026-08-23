/**
 * Live image observation as a pull-based change feed, per ADR 0009.
 *
 * The substrate (Lagrange Images) offers exactly one public read seam for
 * change: `history(imageId, { afterRevision })`, a pull API over a
 * revision-ordered event stream that is committed atomically with state.
 * There is no push/subscribe. This module is the environment-side
 * normalization of that seam, owned by the `ImageClientAdapter`.
 *
 * It is deliberately free of any live-image dependency: the pull function is
 * injected, so the contract is testable against the documented event shape.
 * The adapter supplies the real `history` call; nothing here invents push,
 * and consumers must not assume real-time delivery.
 */

const CHANGE_TYPE = Object.freeze({
  RECORD_PUT: 'record.put',
  IMAGE_ROOT_SET: 'image.root-set',
  IMAGE_CREATED: 'image.created',
});

// The exact record-bearing put vocabulary of the substrate (ADR 0009). Anything
// else ending in ".put" is an unknown event type and must reject, not be
// silently normalized to record.put with a null record.
const RECORD_PUT_KINDS = new Set([
  'object.put',
  'shape.put',
  'code-artifact.put',
  'lexical-environment.put',
  'block.put',
]);

const RECORD_KEY = Object.freeze({
  'object.put': 'object',
  'shape.put': 'shape',
  'code-artifact.put': 'artifact',
  'lexical-environment.put': 'environment',
  'block.put': 'block',
});

/**
 * Map a raw substrate history event to the normalized Change contract.
 * Pure: no information is added and nothing unstored is invented.
 */
function normalizeChange(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('history event must be an object');
  }
  if (typeof event.revision !== 'number' || !Number.isSafeInteger(event.revision) || event.revision < 1) {
    throw new TypeError('history event must carry a positive integer revision');
  }
  const kind = event.type;
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('history event must carry a type');
  }

  if (kind === CHANGE_TYPE.IMAGE_CREATED) {
    return {revision: event.revision, type: CHANGE_TYPE.IMAGE_CREATED, kind, record: event.image ?? null, at: event.at ?? null};
  }
  if (kind === CHANGE_TYPE.IMAGE_ROOT_SET) {
    return {revision: event.revision, type: CHANGE_TYPE.IMAGE_ROOT_SET, kind, record: null, at: event.at ?? null};
  }
  if (RECORD_PUT_KINDS.has(kind)) {
    const record = event[RECORD_KEY[kind]];
    if (record === undefined || record === null) {
      throw new TypeError(`history event ${kind} is missing its record payload`);
    }
    return {revision: event.revision, type: CHANGE_TYPE.RECORD_PUT, kind, record, at: event.at ?? null};
  }
  throw new TypeError(`unknown history event type: ${kind}`);
}

/**
 * Observe an image as an async iterable of normalized Changes over an
 * injected pull seam.
 *
 *   source(afterRevision) -> Promise<rawEvent[]>
 *
 * Options:
 *   afterRevision  start after this revision (catch-up). If omitted, starts
 *                  from the current end of the stream (live follow): the
 *                  first poll establishes the high-water mark and yields only
 *                  later revisions.
 *   signal         AbortSignal; aborting ends iteration.
 *   poll           async (afterRevision) => rawEvent[] — one pull of history.
 *   intervalMs     delay between pulls when no new events arrive.
 *
 * Yields normalized Changes in strictly increasing revision order.
 */
function observeChanges({poll, afterRevision = undefined, signal = undefined, intervalMs = 50} = {}) {
  // Validate eagerly: an async generator body does not run until first
  // iteration, so argument errors must be raised here, at call time.
  if (typeof poll !== 'function') {
    throw new TypeError('observeChanges requires a poll function');
  }
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
    throw new TypeError('afterRevision must be a non-negative safe integer');
  }
  if (typeof intervalMs !== 'number' || !(intervalMs >= 0)) {
    throw new TypeError('intervalMs must be a non-negative number');
  }
  return observeChangesIter({poll, afterRevision, signal, intervalMs});
}

async function* observeChangesIter({poll, afterRevision, signal, intervalMs}) {
  let cursor = afterRevision;
  // Live-follow mode: establish the current high-water mark first so a
  // consumer that never asked for history does not replay the backlog.
  // Malformed events must not silently lower the mark: every substrate event
  // carries a revision, so treat a missing one as loud corruption.
  if (cursor === undefined) {
    const initial = await poll(0);
    throwIfAborted(signal);
    cursor = initial.reduce((max, e) => {
      if (typeof e?.revision !== 'number') {
        throw new TypeError('history event must carry a revision');
      }
      return Math.max(max, e.revision);
    }, 0);
  }

  for (;;) {
    throwIfAborted(signal);
    const batch = await poll(cursor);
    throwIfAborted(signal);
    const fresh = batch
      .filter((e) => (e?.revision ?? 0) > cursor)
      .sort((a, b) => a.revision - b.revision);
    for (const event of fresh) {
      cursor = event.revision;
      yield normalizeChange(event);
    }
    if (fresh.length === 0) {
      await sleep(intervalMs, signal);
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('observation aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('observation aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('observation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    signal?.addEventListener?.('abort', onAbort, {once: true});
  });
}

export {
  CHANGE_TYPE,
  normalizeChange,
  observeChanges,
};
