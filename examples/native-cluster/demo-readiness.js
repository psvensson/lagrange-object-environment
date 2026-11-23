// Transport delegate of runDemoCohort. Lagrange's public probe owns the
// serving verdict; this module only bounds and validates that response.
import {performance} from 'node:perf_hooks';

export const READINESS_BODY_LIMIT = 65_536;

export async function probeDemoReadiness(node, {deadline, signal} = {}) {
  const port = node?.configuration?.node?.restApiPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('A declared local REST port is required for readiness');
  }
  const remaining = deadline - performance.now();
  if (!Number.isFinite(deadline) || !(remaining > 0)) {
    throw new Error('Demo readiness startup deadline');
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Demo readiness interrupted');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new Error('Demo readiness interrupted'));
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('Demo readiness request deadline')),
    Math.min(5000, remaining));
  let response, reader, complete = false;
  try {
    response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: {accept: 'application/json'}, signal: controller.signal,
    });
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength)
      || !Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > READINESS_BODY_LIMIT)) {
      throw new Error('Invalid or oversized readiness body length');
    }
    if (!response.body) throw new Error('Missing readiness response body');
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) { complete = true; break; }
      bytes += result.value.byteLength;
      if (bytes > READINESS_BODY_LIMIT) throw new Error('Oversized readiness response body');
      chunks.push(result.value);
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes)));
    } catch (cause) {
      throw new Error('Malformed readiness response body', {cause});
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ready !== 'boolean') {
      throw new Error('Readiness response must carry the canonical boolean ready field');
    }
    if (response.status === 200 && value.ready === true) return true;
    if (response.status === 503 && value.ready === false) return false;
    throw new Error(`Contradictory or unexpected readiness response (${response.status})`);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!complete) {
      controller.abort();
      // A body already errored by abort can reject cancellation with that same
      // failure. Observe its retirement without replacing the primary error.
      try {
        if (reader) await reader.cancel();
        else await response?.body?.cancel();
      } catch { /* The request/body failure remains primary. */ }
    }
    reader?.releaseLock();
  }
}
