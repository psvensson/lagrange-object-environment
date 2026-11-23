import {ENVIRONMENT_CATALOG_OBJECT_ID, ENVIRONMENT_LAYOUT} from './theme-layout.js';

// ThemeResolver owns the semantic vocabulary, never a fallback palette.
const TOKEN_TYPES = new Map([
  ['accent', 'color'], ['focus', 'color'], ['radius.normal', 'dimension'],
  ['selection.background', 'color'], ['selection.text', 'color'],
  ['spacing.compact', 'dimension'], ['spacing.normal', 'dimension'],
  ['surface.base', 'color'], ['surface.raised', 'color'],
  ['text.muted', 'color'], ['text.primary', 'color'],
  ['typography.code.family', 'fontFamily'], ['typography.code.size', 'fontSize'],
  ['typography.ui.family', 'fontFamily'], ['typography.ui.size', 'fontSize'],
]);

class ThemeResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThemeResolutionError';
  }
}

function requireTheme(condition, message) {
  if (!condition) throw new ThemeResolutionError(message);
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function localRef(value, imageId) {
  requireTheme(hasKeys(value, ['kind', 'imageId', 'objectId'])
    && value.kind === 'ref' && typeof value.imageId === 'string' && value.imageId.length > 0
    && value.imageId === imageId && typeof value.objectId === 'string' && value.objectId.length > 0,
  'Theme graph requires same-image unpinned refs');
  return Object.freeze({kind: 'ref', imageId: value.imageId, objectId: value.objectId});
}

function text(value) {
  requireTheme(hasKeys(value, ['kind', 'value']) && value.kind === 'text' && typeof value.value === 'string',
    'Theme field requires a text Value');
  return value.value;
}

function projection(record) {
  // The adapter discloses no Shape, kind, behavior or stored identity. Its token
  // is opaque and intentionally never interpreted or included in our output.
  requireTheme(hasKeys(record, ['slots', 'indexed', 'versionToken']) && Array.isArray(record.indexed),
    'Invalid authorized Theme read projection');
  return record;
}

function themeRecord(record, imageId) {
  const {slots, indexed} = projection(record);
  const format = text(slots?.format);
  const layout = format === ENVIRONMENT_LAYOUT.root.format ? ENVIRONMENT_LAYOUT.root
    : format === ENVIRONMENT_LAYOUT.derived.format ? ENVIRONMENT_LAYOUT.derived : null;
  requireTheme(layout && hasKeys(slots, layout.names), 'Invalid Theme format or slots');
  text(slots.name);
  const base = layout === ENVIRONMENT_LAYOUT.derived ? localRef(slots.baseTheme, imageId) : null;
  const refs = indexed.map(ref => localRef(ref, imageId));
  requireTheme(new Set(refs.map(ref => ref.objectId)).size === refs.length, 'Duplicate token ref in Theme');
  return {base, refs};
}

function scalarValue(value, type) {
  if (type === 'color') {
    const result = text(value);
    requireTheme(/^#[0-9a-f]{6}$/.test(result), 'Theme color requires lowercase opaque #rrggbb');
    return result;
  }
  if (type === 'fontFamily') {
    const result = text(value);
    requireTheme(result === 'monospace' || result === 'sans-serif', 'Unsupported Theme font family');
    return result;
  }
  requireTheme(hasKeys(value, ['kind', 'value']) && value.kind === 'integer'
    && typeof value.value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.value),
  'Theme dimension or font size requires a nonnegative canonical integer');
  const result = Number(value.value);
  requireTheme(Number.isSafeInteger(result) && (type !== 'fontSize' || result > 0),
    'Theme integer is outside its supported range');
  return result;
}

function tokenRecord(record) {
  const {slots, indexed} = projection(record);
  requireTheme(hasKeys(slots, ENVIRONMENT_LAYOUT.token.names) && indexed.length === 0,
    'Invalid DesignToken layout');
  requireTheme(text(slots.format) === ENVIRONMENT_LAYOUT.token.format, 'Invalid DesignToken format');
  const path = text(slots.path);
  const type = text(slots.type);
  requireTheme(TOKEN_TYPES.has(path) && TOKEN_TYPES.get(path) === type, 'Unknown token path or incompatible token type');
  return Object.freeze({path, type, value: scalarValue(slots.value, type)});
}

function createThemeResolver({readObject, observe, observePull} = {}) {
  if (typeof readObject !== 'function') throw new TypeError('ThemeResolver requires an authorized readObject');

  // One traversal owns BOTH semantic values and the private dependency set.
  // Shadowed token refs remain dependencies because they are still validated
  // and require independent authority. No second ancestry walker exists.
  function assertFollowActive(signal) {
    if (signal?.aborted) {
      const error = new Error('Theme read cancelled before issuing another operation');
      error.name = 'AbortError';
      throw error;
    }
  }

  async function resolveThemeWithDependencies({themeRef, authority, blockId, dependencies = new Set(), signal} = {}) {
    const selected = localRef(themeRef, themeRef?.imageId);
    const seen = new Set();
    const values = new Map();
    const read = async ref => {
      // Lower readObject calls may be uncancellable. Stop must prevent the
      // traversal from issuing NEW reads after a held one returns, rather than
      // only racing its finished result against the Session stop signal.
      assertFollowActive(signal);
      dependencies.add(ref.objectId);
      const result = await readObject({imageId: ref.imageId, objectId: ref.objectId, authority, blockId});
      assertFollowActive(signal);
      return result;
    };
    let current = selected;
    while (current !== null) {
      requireTheme(!seen.has(current.objectId), 'Theme inheritance cycle');
      seen.add(current.objectId);
      const {base, refs} = themeRecord(await read(current), selected.imageId);
      const paths = new Set();
      for (const ref of refs) {
        // Shadowed tokens also demand authorization and schema validation.
        const token = tokenRecord(await read(ref));
        requireTheme(!paths.has(token.path), 'Duplicate token path in Theme');
        paths.add(token.path);
        if (!values.has(token.path)) values.set(token.path, token);
      }
      current = base;
    }
    requireTheme(values.size === TOKEN_TYPES.size, 'Theme is missing required token paths');
    const tokens = Object.freeze([...values.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {resolved: Object.freeze({themeRef: selected, tokens}), dependencies};
  }

  async function resolve(options = {}) {
    return (await resolveThemeWithDependencies(options)).resolved;
  }

  // T3: select a provisioned image's REAL catalog default. This is an
  // authorized read of the one well-known object, not a code fallback, an
  // unguarded object lookup or a second settings store. Profiles are a
  // separate future input; no profile/default inference occurs here.
  async function resolveCatalogWithDependencies({imageId, authority, blockId, signal} = {}) {
    requireTheme(typeof imageId === 'string' && imageId.length > 0,
      'Catalog default resolution requires an imageId');
    const dependencies = new Set([ENVIRONMENT_CATALOG_OBJECT_ID]);
    assertFollowActive(signal);
    const catalog = projection(await readObject({
      imageId, objectId: ENVIRONMENT_CATALOG_OBJECT_ID, authority, blockId,
    }));
    assertFollowActive(signal);
    requireTheme(hasKeys(catalog.slots, ENVIRONMENT_LAYOUT.catalog.names),
      'Invalid EnvironmentCatalog slots');
    requireTheme(text(catalog.slots.format) === ENVIRONMENT_LAYOUT.catalog.format,
      'Invalid EnvironmentCatalog format');
    const selected = localRef(catalog.slots.defaultTheme, imageId);
    // Validate stock ref shapes without re-owning catalog domain policy.
    catalog.indexed.forEach(ref => localRef(ref, imageId));
    return resolveThemeWithDependencies({themeRef: selected, authority, blockId, dependencies, signal});
  }

  async function resolveCatalogDefault(options = {}) {
    return (await resolveCatalogWithDependencies(options)).resolved;
  }

  // T5 uses Images' existing authorized observation feed, not a new Theme
  // poller. The opaque cursor is anchored before the first read so changes
  // during initialization cannot be lost. Only metadata invalidations reach
  // this owner; all values come from fresh authorized reads.
  const FOLLOW_STOPPED = Symbol('Theme follow stopped');

  async function followResolved({imageId, readCurrent, authority, blockId,
    observationBlockId, onUpdate, onError, intervalMs, signal} = {}) {
    if (typeof observe !== 'function' || typeof observePull !== 'function') {
      throw new TypeError('Theme follow requires ImageClientAdapter observe and observePull');
    }
    requireTheme(typeof imageId === 'string' && imageId.length > 0, 'Theme follow requires imageId');
    requireTheme(typeof blockId === 'string' && blockId.length > 0, 'Theme follow requires read blockId');
    requireTheme(typeof observationBlockId === 'string' && observationBlockId.length > 0,
      'Theme follow requires observation blockId');
    if (typeof onUpdate !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Theme follow requires onUpdate and onError callbacks');
    }
    if (intervalMs !== undefined && (typeof intervalMs !== 'number'
        || !Number.isFinite(intervalMs) || intervalMs < 0)) {
      throw new TypeError('Theme follow intervalMs must be a finite nonnegative number');
    }

    const controller = new AbortController();
    let stoppedOnce = false;
    const externalAbort = () => stop();
    function stop() {
      if (stoppedOnce) return;
      stoppedOnce = true;
      controller.abort();
      signal?.removeEventListener?.('abort', externalAbort);
    }
    if (signal?.aborted) stop();
    else signal?.addEventListener?.('abort', externalAbort, {once: true});

    // Images reads/pulls cannot be cancelled after dispatch. Give EACH
    // operation a detachable abort listener: racing every operation against
    // one never-settled 'stopped' Promise accumulates unbounded reactions on
    // long-lived follows. The microtask checks cancellation a SECOND time,
    // immediately before invoking the lower operation or renderer callback.
    async function whileActive(startOperation) {
      if (controller.signal.aborted) return FOLLOW_STOPPED;
      let onAbort;
      const cancelled = new Promise(resolve => {
        onAbort = () => resolve(FOLLOW_STOPPED);
        controller.signal.addEventListener('abort', onAbort, {once: true});
        if (controller.signal.aborted) onAbort();
      });
      const task = Promise.resolve().then(() => (
        controller.signal.aborted ? FOLLOW_STOPPED : startOperation()
      ));
      // If stop wins, the lower operation may still settle later; it must be
      // terminally handled without publishing a stale result or rejection.
      task.catch(() => {});
      try {
        return await Promise.race([task, cancelled]);
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    }

    try {
      const anchored = await whileActive(() => observePull({
        imageId, afterCursor: '', authority, blockId: observationBlockId,
      }));
      if (anchored === FOLLOW_STOPPED) {
        return Object.freeze({stop, signal: controller.signal, done: Promise.resolve()});
      }
      requireTheme(anchored && Array.isArray(anchored.events) && anchored.events.length === 0
        && typeof anchored.cursor === 'string' && anchored.cursor.length > 0,
      'Theme observation did not establish a live-follow cursor');

      let current = await whileActive(() => readCurrent(controller.signal));
      if (current === FOLLOW_STOPPED) {
        return Object.freeze({stop, signal: controller.signal, done: Promise.resolve()});
      }
      const initialized = await whileActive(() => onUpdate(current.resolved, null));
      if (initialized === FOLLOW_STOPPED) {
        return Object.freeze({stop, signal: controller.signal, done: Promise.resolve()});
      }

      const worker = (async () => {
        let iterator;
        try {
          iterator = observe(imageId, {
            authority, blockId: observationBlockId, afterCursor: anchored.cursor,
            signal: controller.signal,
            ...(intervalMs === undefined ? {} : {intervalMs}),
          })[Symbol.asyncIterator]();
          for (;;) {
            const item = await whileActive(() => iterator.next());
            if (item === FOLLOW_STOPPED) return;
            if (item.done) throw new ThemeResolutionError('Theme observation ended unexpectedly');
            const change = item.value;
            // No numeric revision/cursor comparisons. This authorized feed
            // contains only per-object metadata, never a stored record.
            if (change?.kind !== 'object.put' || !current.dependencies.has(change.objectId)) continue;
            const next = await whileActive(() => readCurrent(controller.signal));
            if (next === FOLLOW_STOPPED) return;
            const applied = await whileActive(() => onUpdate(next.resolved, change));
            if (applied === FOLLOW_STOPPED) return;
            current = next; // advance the dependency set only after a successful render
          }
        } catch (error) {
          // Only an explicit stop is a clean cancellation. A lower layer may
          // independently throw AbortError while this follow is still active;
          // suppressing that error would silently strand the old Theme.
          if (!controller.signal.aborted) await onError(error);
        } finally {
          stop();
          // A stalled in-flight pull cannot postpone Session teardown.
          // Its eventual completion/rejection remains terminally handled.
          const closing = iterator?.return?.();
          closing?.catch?.(() => {});
        }
      })();
      worker.catch(() => {}); // callers can await done; never leak unhandled rejection
      return Object.freeze({stop, signal: controller.signal, done: worker});
    } catch (error) {
      // Check BEFORE stop(): stop itself aborts the internal signal. An
      // independently thrown lower AbortError during startup is a real error,
      // not proof the Session asked to cancel the follow.
      const wasStopped = controller.signal.aborted;
      stop();
      if (wasStopped) {
        return Object.freeze({stop, signal: controller.signal, done: Promise.resolve()});
      }
      throw error; // failed initial read/render is never silently swallowed
    }
  }

  function followTheme({themeRef, authority, blockId, observationBlockId,
    onUpdate, onError, intervalMs, signal} = {}) {
    const selected = localRef(themeRef, themeRef?.imageId);
    return followResolved({imageId: selected.imageId, authority, blockId,
      observationBlockId, onUpdate, onError, intervalMs, signal,
      readCurrent: signal => resolveThemeWithDependencies({themeRef: selected, authority, blockId, signal})});
  }

  function followCatalogDefault({imageId, authority, blockId, observationBlockId,
    onUpdate, onError, intervalMs, signal} = {}) {
    return followResolved({imageId, authority, blockId,
      observationBlockId, onUpdate, onError, intervalMs, signal,
      readCurrent: signal => resolveCatalogWithDependencies({imageId, authority, blockId, signal})});
  }

  return Object.freeze({resolve, resolveCatalogDefault, followTheme, followCatalogDefault});
}

export {createThemeResolver, ThemeResolutionError};
