import {Session} from './model.js';

class SessionThemeStartupCancelledError extends Error {
  constructor() {
    super('Session Theme startup was cancelled by Session closure');
    this.name = 'SessionThemeStartupCancelledError';
  }
}

/**
 * The ONE Session-to-Theme-follow-to-renderer interaction owner (T6).
 *
 * ThemeResolver owns all authorized object reads, dependency selection and
 * observation. Compositor owns all logical views and renderer destruction.
 * This composition ONLY orders the existing browser-host operations and
 * owns their transient lifetime. It never stores authority, tokens or CSS in
 * Session.state, and never invents a Theme, Profile or grant.
 */
function createSessionThemeLifecycle({
  session, compositor, themeResolver, setResolvedTokens, onThemeError,
} = {}) {
  if (!(session instanceof Session)) {
    throw new TypeError('Session Theme lifecycle requires a Session');
  }
  if (!compositor || typeof compositor.destroy !== 'function') {
    throw new TypeError('Session Theme lifecycle requires its Compositor');
  }
  if (!themeResolver || typeof themeResolver.followCatalogDefault !== 'function'
      || typeof themeResolver.followTheme !== 'function') {
    throw new TypeError('Session Theme lifecycle requires the existing ThemeResolver');
  }
  if (typeof setResolvedTokens !== 'function' || typeof onThemeError !== 'function') {
    throw new TypeError('Session Theme lifecycle requires host style and error callbacks');
  }

  // Only the JavaScript browser host is currently admitted. A native JS→GTK
  // style bridge is NOT part of the six-operation RendererAdapter port.
  // The supplied setter MUST be synchronous (and on the owning host thread).
  function invokeSync(fn, value, name) {
    const result = fn(value);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof result.then === 'function') {
      // An async callback could complete after teardown or await close() from
      // ThemeResolver.onError. Observe its rejection but NEVER await it here.
      Promise.resolve(result).catch(() => {});
      throw new TypeError(`${name} must return synchronously`);
    }
  }

  const controller = new AbortController();
  let state = 'new';
  let initialApplied = false;
  let errorReported = false;
  let reportingFailure = null;
  let follower = null;
  let completion = Promise.resolve();
  let startPromise = null;
  let closePromise = null;

  function fail(error) {
    if (controller.signal.aborted || errorReported) return;
    errorReported = true;
    state = 'failed';
    let reportedError = error;
    try {
      invokeSync(setResolvedTokens, null, 'host Theme withdrawal');
    } catch (withdrawalError) {
      reportedError = new AggregateError([error, withdrawalError],
        'Theme failed and withdrawal could not be completed');
    }
    try {
      invokeSync(onThemeError, reportedError, 'host Theme error callback');
    } catch (callbackError) {
      reportingFailure = new AggregateError([reportedError, callbackError],
        'Session Theme failure could not be reported synchronously');
      throw reportingFailure;
    }
  }

  function start({selection, authority, blockId, observationBlockId, intervalMs} = {}) {
    if (state !== 'new') {
      throw new Error('Session Theme lifecycle can be started exactly once');
    }
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
        || !['catalog-default', 'explicit'].includes(selection.kind)) {
      throw new TypeError('Session Theme start requires an explicit tagged selection');
    }
    if (selection.kind === 'catalog-default') {
      if (Object.keys(selection).sort().join(',') !== 'imageId,kind'
          || typeof selection.imageId !== 'string' || selection.imageId.length === 0) {
        throw new TypeError('catalog-default selection requires exactly imageId');
      }
    } else if (Object.keys(selection).sort().join(',') !== 'kind,themeRef') {
      throw new TypeError('explicit Theme selection requires exactly themeRef');
    }
    if (authority === null || authority === undefined) {
      throw new TypeError('Session Theme start requires supplied read authority');
    }

    state = 'starting';
    const callbacks = {
      authority, blockId, observationBlockId, signal: controller.signal,
      ...(intervalMs === undefined ? {} : {intervalMs}),
      onUpdate({tokens}) {
        if (controller.signal.aborted) return;
        invokeSync(setResolvedTokens, tokens, 'host Theme style callback');
        initialApplied = true;
      },
      onError(error) {
        if (!controller.signal.aborted) fail(error);
      },
    };

    const task = (async () => {
      try {
        const live = selection.kind === 'catalog-default'
          ? await themeResolver.followCatalogDefault({...callbacks, imageId: selection.imageId})
          : await themeResolver.followTheme({...callbacks, themeRef: selection.themeRef});
        follower = live;
        // Observing done is mandatory even if a host forgets to close. A
        // reporter failure is kept as a terminal receipt, not leaked.
        completion = Promise.resolve(live.done).catch(error => {
          if (!controller.signal.aborted && !errorReported) {
            try { fail(error); } catch { /* failure stored below */ }
          }
          if (!reportingFailure) reportingFailure = error;
        });
        if (controller.signal.aborted) {
          live.stop();
          throw new SessionThemeStartupCancelledError();
        }
        if (!initialApplied || live.signal?.aborted || errorReported) {
          throw reportingFailure ?? new Error('Session Theme follow ended before active startup');
        }
        state = 'active';
        return Object.freeze({status: 'active'});
      } catch (error) {
        // Startup failures must not strand a follow even when it returned a
        // handle but failed to present a valid first Theme.
        follower?.stop();
        if (controller.signal.aborted) throw new SessionThemeStartupCancelledError();
        if (!errorReported) {
          try { fail(error); } catch (failure) { throw failure; }
        }
        throw reportingFailure ?? error;
      }
    })();
    startPromise = task;
    task.catch(() => {}); // lifecycle owns terminal handling during close
    return task;
  }

  function close() {
    if (closePromise) return closePromise;
    // Stop FIRST, before any await or renderer teardown. No later onUpdate or
    // onError is allowed to mutate a closed Session's browser tools.
    state = 'closing';
    controller.abort();
    follower?.stop();
    const task = (async () => {
      let failure = null;
      try {
        if (startPromise) await startPromise.catch(() => {});
        follower?.stop();
        await completion;
      } catch (error) {
        failure = error;
      }
      try {
        await compositor.destroy(); // Compositor is the ONLY destroy owner
      } catch (error) {
        failure = failure ? new AggregateError([failure, error],
          'Theme follow and renderer teardown both failed') : error;
      } finally {
        state = 'closed';
      }
      if (reportingFailure) {
        failure = failure ? new AggregateError([reportingFailure, failure],
          'Theme reporting and teardown both failed') : reportingFailure;
      }
      if (failure) throw failure;
    })();
    closePromise = task;
    task.catch(() => {}); // repeated callers still receive the same rejection
    return task;
  }

  return Object.freeze({
    start, close,
    status: () => state,
  });
}

export {createSessionThemeLifecycle, SessionThemeStartupCancelledError};
