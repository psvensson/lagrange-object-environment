/**
 * THROWAWAY 64j-A bridge client (Node side). NOT a public API. NOT the Linux
 * client architecture. This is the smallest credible embedding that lets the
 * UNMODIFIED src/ environment core drive the REAL Rust LinuxRendererAdapter,
 * to falsify the SEMANTIC host-portability claim (ADR 0013). It does NOT prove
 * option A's in-process implementation (a Node subprocess is a peer process,
 * not an embedded runtime — that is Bead 3zb).
 *
 * FENCES (user-mandated): only plain-data newline-JSON crosses; NO semantic
 * logic here (no key->ref/key->slot/command/authority/version-token/observation
 * — those stay in the real JS core); the six RendererAdapter ops are exactly
 * six; no durable state/identity originates here. Delete this when 3zb lands.
 *
 * PROTOCOL (op-correlated, strict FIFO, single-in-flight per adapter):
 *   -> Rust: {id, op, args:[data-representable]}        (one of the SIX ops)
 *   <- Rust: {id, ok: result} | {id, err: string}       (per-op ack)
 *   <- Rust: {event: 'intent', surfaceHandle, intent}   (GTK -> JS, see onIntent)
 */

import {createInterface} from 'node:readline';

const SIX_OPS = Object.freeze([
  'createSurface',
  'attachPresentation',
  'detachPresentation',
  'resize',
  'destroySurface',
  'destroyAll',
]);

/**
 * Create a RendererAdapter-shaped object whose six ops are RPC calls to the
 * Rust host. The real JS Compositor consumes this EXACTLY like any other
 * adapter (async ops returning Promises). Op-correlation: each op gets a unique
 * id; the matching ack resolves its Promise. Single-in-flight is enforced by
 * serializing ops through one queue (a presentOn's detach->attach ordering is
 * preserved because the JS Compositor awaits each op before issuing the next,
 * and this adapter never pipelines).
 */
function createBridgeAdapter({send, onResponse, onEvent}) {
  let nextId = 0;
  const pending = new Map(); // id -> {resolve, reject}
  const intentHandlers = [];

  // The host pushes {id, ok|err} acks and {event:'intent', ...} events.
  onResponse((msg) => {
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if ('err' in msg) reject(new Error(msg.err));
      else resolve(msg.ok);
    } else if (msg.event === 'intent') {
      for (const fn of intentHandlers) fn(msg.intent, msg.surfaceHandle);
    }
  });

  function call(op, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      send({id, op, args});
    });
  }

  const adapter = {
    createSurface: (viewDescriptor) => call('createSurface', [viewDescriptor]),
    attachPresentation: (handle, presentationDescriptor) => call('attachPresentation', [handle, presentationDescriptor]),
    detachPresentation: (handle) => call('detachPresentation', [handle]),
    resize: (handle, width, height) => call('resize', [handle, width, height]),
    destroySurface: (handle) => call('destroySurface', [handle]),
    destroyAll: () => call('destroyAll', []),
    // Host-side intent seam (the analogue of the browser adapter's onIntent;
    // NOT a contract op). The shell's bindIntents subscribes here.
    onIntent: (fn) => {
      intentHandlers.push(fn);
      return () => {
        const i = intentHandlers.indexOf(fn);
        if (i >= 0) intentHandlers.splice(i, 1);
      };
    },
  };
  return adapter;
}

/**
 * Run the worker's I/O loop over stdin/stdout. `onReady(adapter, api)` is where
 * the real environment-core session is built (S2/S3); S0 uses a self-test.
 */
function runBridgeWorker(onReady) {
  const rl = createInterface({input: process.stdin, terminal: false});
  const responseHandlers = [];
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours / malformed; ignore (plain-data only)
    }
    for (const fn of responseHandlers) fn(msg);
  });
  const adapter = createBridgeAdapter({
    send,
    onResponse: (fn) => responseHandlers.push(fn),
    onEvent: () => {},
  });
  return onReady(adapter, {send});
}

export {createBridgeAdapter, runBridgeWorker, SIX_OPS};
export default {createBridgeAdapter, runBridgeWorker, SIX_OPS};
