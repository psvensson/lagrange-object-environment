// Native host binding only. The endpoint and credential never enter JavaScript.
// ImageReadConnection owns the protocol; this module carries opaque envelopes
// and maps its AbortSignal onto an actual native request lifetime.
export function createNativeReadRequest() {
  return async function request(envelope, {signal}) {
    if (signal.aborted) throw signal.reason;
    const id = globalThis.__nativeReadIdentity();
    if (!id) throw new Error('Native request identity exhausted');
    const pending = globalThis.__nativeReadRequest(id, JSON.stringify(envelope));
    const cancel = () => globalThis.__nativeReadCancel(id);
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
    try {
      const result = JSON.parse(await pending);
      if (signal.aborted) throw signal.reason;
      if (result.failed) throw new Error('Native image transport failed.');
      return result;
    } finally { signal.removeEventListener('abort', cancel); }
  };
}
