/**
 * Live image observation as a pull-based INVALIDATION feed over the authorized
 * observation lane (substrate ADR 0070 `image-observation-binding/v1`).
 *
 * SUPERSESSION (named in substrate ADR 0070): for the authorized feed this
 * module supersedes env ADR 0009's "a Change carries the full stored record
 * and the global revision." The lane's feed is METADATA-ONLY — each event is
 * `{objectId, kind, cursor}` (the changed object's identity + kind + an opaque
 * per-event cursor) — so the normalized Change is an invalidation that carries
 * NO record payload and NO global revision. Consumers that need current state
 * re-read the object through the authorized readObject lane (substrate ADR
 * 0068); the feed is a signal, never a second read path.
 *
 * THE CURSOR is the load-bearing property. The lane returns an OPAQUE,
 * integrity-protected, encrypted STRING token (`obs-cursor/v1:...`) — never a
 * number. The consumer cannot parse it, compare two cursors, or gap-analyze
 * invisible writes; it can only pass it back. The loop therefore does NO
 * numeric revision bookkeeping: the lane already filters (per-object
 * object/read), orders, strips the global revision, and advances an opaque
 * high-water mark. An empty afterCursor ('') means live-follow from the
 * current end; any other token resumes after its position (an older VALID
 * token is an idempotent resume, per the lane).
 *
 * It is deliberately free of any live-image dependency: the pull function is
 * injected, so the contract is testable against the documented lane result
 * shape `{events: [{objectId, kind, cursor}], cursor}`. The adapter supplies
 * the real authorized-lane call; nothing here invents push, and consumers
 * must not assume real-time delivery.
 */

const CHANGE_TYPE = Object.freeze({
  RECORD_PUT: 'record.put',
});

/**
 * Map one lane obs-event to the normalized Change: an INVALIDATION carrying
 * identity + kind + the lane's opaque cursor — and nothing else.
 *
 * The shape is exactly `{type, kind, objectId, cursor}`: NO `record` (no
 * payload ever crosses the authorized feed) and NO `revision` (the global
 * revision is stripped lane-side; copying any ordering number back onto the
 * Change would re-open the gap-analysis channel ADR 0070 closes). Pure: no
 * information is added and nothing unstored is invented.
 */
function normalizeChange(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('observation event must be an object');
  }
  const kind = event.kind;
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('observation event must carry a kind');
  }
  if (typeof event.objectId !== 'string' || event.objectId.length === 0) {
    throw new TypeError('observation event must carry an objectId');
  }
  if (typeof event.cursor !== 'string') {
    throw new TypeError('observation event must carry an opaque cursor string');
  }
  // The v1 lane emits object.put invalidations only; normalize to the one
  // record-put Change type, keeping the raw kind for consumers that filter.
  return Object.freeze({
    type: kind === 'object.put' ? CHANGE_TYPE.RECORD_PUT : kind,
    kind,
    objectId: event.objectId,
    cursor: event.cursor,
  });
}

function assertLaneResult(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('observation lane result must be an object');
  }
  if (!Array.isArray(result.events)) {
    throw new TypeError('observation lane result must carry an events list');
  }
  if (typeof result.cursor !== 'string') {
    throw new TypeError('observation lane result must carry an opaque cursor string');
  }
  return result;
}

/**
 * Observe an image as an async iterable of normalized invalidation Changes
 * over an injected pull seam on the authorized observation lane.
 *
 *   poll(afterCursor: string) -> Promise<{events: [{objectId, kind, cursor}], cursor: string}>
 *
 * Options:
 *   afterCursor  the lane's opaque resume token. OMITTED (or '') means
 *                live-follow from the current end (the lane establishes the
 *                high-water mark itself and replays no backlog). A token from
 *                an earlier run resumes after its position; a VALID older
 *                token idempotently re-emits earlier visible invalidations.
 *   signal       AbortSignal; aborting ends iteration.
 *   poll         async (afterCursor) => {events, cursor} — one lane pull.
 *   intervalMs   delay between pulls when no new events arrive.
 *
 * Yields each event in the lane's own order; the cursor fed to the next poll
 * is the result-level high-water token, NOT any per-event cursor (the events
 * are a strict subsequence of one scan, so the high-water mark is never
 * behind a yielded event). There is deliberately no numeric comparison,
 * filtering or sorting here: ordering, per-authority filtering and cursor
 * opacity are owned lane-side.
 */
function observeChanges({poll, afterCursor = undefined, signal = undefined, intervalMs = 50} = {}) {
  // Validate eagerly: an async generator body does not run until first
  // iteration, so argument errors must be raised here, at call time.
  if (typeof poll !== 'function') {
    throw new TypeError('observeChanges requires a poll function');
  }
  if (afterCursor !== undefined && typeof afterCursor !== 'string') {
    throw new TypeError('afterCursor must be an opaque cursor string');
  }
  if (typeof intervalMs !== 'number' || !(intervalMs >= 0)) {
    throw new TypeError('intervalMs must be a non-negative number');
  }
  return observeChangesIter({poll, afterCursor, signal, intervalMs});
}

async function* observeChangesIter({poll, afterCursor, signal, intervalMs}) {
  // Omitted or '' = live-follow from the current end; the lane treats the
  // empty after-cursor as "start at the current high-water mark."
  let cursor = afterCursor ?? '';
  for (;;) {
    throwIfAborted(signal);
    const result = assertLaneResult(await poll(cursor));
    throwIfAborted(signal);
    for (const event of result.events) {
      yield normalizeChange(event);
    }
    // The lane's high-water token drives the next poll — never arithmetic.
    cursor = result.cursor;
    if (result.events.length === 0) {
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
