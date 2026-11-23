import {Session} from './model.js';
import {createCompositor, RENDERER_ADAPTER_METHODS} from './compositor.js';

// Custody belongs to this interaction owner, not Session.state or a host's
// convention. Weak identities neither retain clients nor map principals.
const claimedSessions = new WeakSet();
const claimedAdapters = new WeakSet();

class SessionThemeCancelledError extends Error {
  constructor() {
    super('Session Theme startup was cancelled by close');
    this.name = 'SessionThemeCancelledError';
  }
}

function failureResult(errors, message) {
  return errors.length === 1 ? errors[0]
    : new AggregateError(errors, message, {cause: errors[0]});
}

function callSynchronous(callback, label, value) {
  const result = callback(value);
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof result.then === 'function') {
    // Detection is not cancellation of arbitrary effects the invalid callback
    // already scheduled. Observe its eventual rejection, but never await it.
    Promise.resolve(result).catch(() => {});
    throw new TypeError(`${label} must be synchronous and must not return a thenable`);
  }
}

function observedRejection(error) {
  const result = Promise.reject(error);
  result.catch(() => {});
  return result;
}

/**
 * Own one browser/JavaScript Session's Theme follow and its teardown ordering.
 * ThemeResolver still owns every read and observation; Compositor still owns
 * every view. The private raw compositor cannot bypass this owner's close.
 */
function createSessionThemeLifecycle({session, rendererAdapter, themeResolver, onThemeError} = {}) {
  if (!(session instanceof Session)) throw new TypeError('SessionThemeLifecycle requires a Session');
  if (!rendererAdapter || typeof rendererAdapter !== 'object'
      || typeof rendererAdapter.setResolvedTokens !== 'function') {
    throw new TypeError('SessionThemeLifecycle requires a synchronous renderer setResolvedTokens');
  }
  if (!themeResolver || typeof themeResolver.followTheme !== 'function'
      || typeof themeResolver.followCatalogDefault !== 'function') {
    throw new TypeError('SessionThemeLifecycle requires the ThemeResolver follow controls');
  }
  if (typeof onThemeError !== 'function') throw new TypeError('onThemeError must be a synchronous function');
  if (claimedSessions.has(session) || claimedAdapters.has(rendererAdapter)) {
    throw new TypeError('Session or renderer adapter already belongs to a Theme lifecycle');
  }
  // Logical destruction must fence admissions synchronously. Defer only the
  // concrete renderer teardown, inside this interaction owner's six-op port.
  // Other methods preserve the actual adapter as receiver and add no await.
  const rendererPort = Object.fromEntries(RENDERER_ADAPTER_METHODS.map(method => {
    const operation = rendererAdapter[method];
    // Do not let our barrier disguise a missing/nonfunction actual operation:
    // the canonical Compositor constructor still validates all six methods.
    if (typeof operation !== 'function') return [method, operation];
    if (method !== 'destroyAll') return [method, operation.bind(rendererAdapter)];
    return [method, async function destroyRendererAfterFollow() {
      // rawCompositor.destroy has ALREADY closed admissions before this can
      // invoke abort listeners or wait for any pending follow work.
      controller.abort();
      if (retirement) await retirement;
      else settleFollow();
      // Retirement records follow failures without throwing them through the
      // renderer's error boundary. Only actual renderer failures cross here.
      await operation.call(rendererAdapter);
    }];
  }));
  const rawCompositor = createCompositor({rendererAdapter: rendererPort});
  const setResolvedTokens = rendererAdapter.setResolvedTokens.bind(rendererAdapter);
  claimedSessions.add(session);
  claimedAdapters.add(rendererAdapter);

  const controller = new AbortController();
  let started = false;
  let initialized = false;
  let retirement = null;
  let closePromise = null;
  let failureErrors = null;
  let followFailure;
  let followSettled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});

  // This callback is always synchronous, including when the host reporter
  // throws or calls close. Record the original BEFORE any reentrant host code.
  function fail(error) {
    if (failureErrors) return;
    failureErrors = [error];
    controller.abort();
    try {
      callSynchronous(setResolvedTokens, 'setResolvedTokens', null);
    } catch (withdrawalError) {
      failureErrors.push(withdrawalError);
    }
    try {
      callSynchronous(onThemeError, 'onThemeError',
        failureResult(failureErrors, 'Theme failure and style withdrawal failed'));
    } catch (reporterError) {
      failureErrors.push(reporterError);
    }
    followFailure = failureResult(failureErrors, 'Session Theme following failed');
  }

  function settleFollow() {
    if (followSettled) return;
    followSettled = true;
    if (failureErrors) rejectDone(followFailure);
    else resolveDone();
  }

  function onUpdate(resolved) {
    if (closePromise || failureErrors) return;
    try {
      callSynchronous(setResolvedTokens, 'setResolvedTokens', resolved.tokens);
      if (!closePromise && !failureErrors) initialized = true;
    } catch (error) {
      fail(error);
    }
  }

  function dispatchFollow(options) {
    if (closePromise) return null;
    const {selection, authority, blockId, observationBlockId, intervalMs} = options ?? {};
    const common = {authority, blockId, observationBlockId,
      signal: controller.signal, onUpdate, onError: fail,
      ...(intervalMs === undefined ? {} : {intervalMs})};
    if (selection && !Array.isArray(selection) && Object.hasOwn(selection, 'kind')
        && Object.keys(selection).length === 2) {
      if (selection.kind === 'catalog-default' && Object.hasOwn(selection, 'imageId')) {
        return themeResolver.followCatalogDefault({...common, imageId: selection.imageId});
      }
      if (selection.kind === 'explicit' && Object.hasOwn(selection, 'themeRef')) {
        return themeResolver.followTheme({...common, themeRef: selection.themeRef});
      }
    }
    throw new TypeError('Theme selection must be catalog-default/imageId or explicit/themeRef');
  }

  function start(options = {}) {
    if (started || closePromise) {
      return observedRejection(new TypeError('Session Theme lifecycle can only be started once before close'));
    }
    started = true;
    // Store the bootstrap/retirement promises before invoking injected code.
    // Close waits on these, NEVER on the public start result (which may reject
    // cancellation or report a failure while retirement is still finishing).
    const bootstrap = Promise.resolve().then(() => dispatchFollow(options));
    bootstrap.catch(() => {});
    retirement = bootstrap.then(following => following?.done, error => { fail(error); })
      .then(() => {
        if (!closePromise && !failureErrors) fail(new Error('Theme follow ended unexpectedly'));
        settleFollow();
      }, error => {
        // A cleanup/worker failure is still observable, even during close.
        // Preserve a prior Theme/reporting error rather than replacing it.
        if (failureErrors) {
          failureErrors.push(error);
          followFailure = failureResult(failureErrors, 'Session Theme following failed');
        } else fail(error);
        settleFollow();
      });
    retirement.catch(() => {});

    const result = bootstrap.then(following => {
      // A reporter-triggered close is cleanup AFTER the recorded failure; it
      // must not relabel that failure as caller-requested cancellation.
      if (failureErrors) throw followFailure;
      if (closePromise) throw new SessionThemeCancelledError();
      if (!initialized || following?.signal?.aborted) {
        fail(new Error('Theme follow did not establish an active initial style'));
        throw followFailure;
      }
    }, error => {
      fail(error);
      throw followFailure;
    });
    result.catch(() => {});
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    // A synchronous reporter may call close without returning/awaiting it.
    // Observe rejection immediately while returning the original Promise.
    closePromise.catch(() => {});
    // Call immediately, not from a later continuation: Compositor is the sole
    // admission owner and must reject same-turn post-close view requests.
    const closing = rawCompositor.destroy().then(() => {
      if (failureErrors) throw followFailure;
    }, teardownError => {
      // Compositor retains the existing typed renderer-error mapping.
      throw failureResult([...(failureErrors ?? []), teardownError], 'Session Theme teardown failed');
    });
    // Compositor has fenced admissions, but an already-admitted renderer
    // operation may keep its drain pending. Stop following now, independently
    // of that drain. The delegate's abort is idempotent and preserves its
    // immediate timing when there was no pending composition operation.
    controller.abort();
    closing.then(resolveClose, rejectClose);
    return closePromise;
  }

  const compositor = Object.freeze({...rawCompositor, destroy: close});
  return Object.freeze({compositor, start, done, close});
}

export {createSessionThemeLifecycle, SessionThemeCancelledError};
