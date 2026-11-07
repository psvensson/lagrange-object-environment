import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {isIP} from 'node:net';
import {
  imageReadErrorResponse, imageReadFailure, imageReadSuccess,
  parseImageReadRequest, positiveInteger,
} from '../../src/image-read-connection.js';

const PATH = '/v1/read';
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function send(response, envelope, timeoutMs, socket, onSocketClose) {
  if (socket.destroyed || response.destroyed || response.writableEnded) return;
  let body = JSON.stringify(envelope.body);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    envelope = imageReadErrorResponse('FAILED');
    body = JSON.stringify(envelope.body);
  }
  await new Promise((resolve) => {
    let stopWatching = () => {};
    // end() is not delivery completion. A peer can stop reading after sending
    // a complete request; neither requestTimeout nor keepAliveTimeout bounds it.
    const timer = setTimeout(() => {
      socket.destroy();
      response.destroy();
      // A pipelined response may not yet own a socket; destroy() need not emit
      // close there. Its response obligation still ends at this deadline.
      finished();
    }, timeoutMs);
    function finished() {
      clearTimeout(timer);
      response.off('finish', finished);
      response.off('close', finished);
      response.off('error', failed);
      stopWatching();
      resolve();
    }
    function failed() { response.destroy(); finished(); }
    response.once('finish', finished);
    response.once('close', finished);
    response.once('error', failed);
    stopWatching = onSocketClose(socket, finished);
    try {
      response.writeHead(envelope.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch { failed(); }
  });
}

function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    function finish(error, value) {
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    }
    function data(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        finish(imageReadFailure('BAD_REQUEST'));
        request.resume();
      } else chunks.push(chunk);
    }
    function end() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(imageReadFailure('BAD_REQUEST')); }
    }
    function fail() { finish(imageReadFailure('BAD_REQUEST')); }
    function abort() {
      finish(signal.reason);
      request.resume();
    }
    request.on('data', data);
    request.once('end', end);
    request.once('error', fail);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
  });
  return Promise.race([work, aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

// Runtime ownership and identity/authority policy belong to the trusted
// deployment. This host never installs data, issues grants or follows a ref.
async function createImageReadService({
  adapter, imageId, objectReadBlockId, authenticateRequest, authorityForIdentity,
  tls = null, operationTimeoutMs = 10_000, responseTimeoutMs = 2_000, drainTimeoutMs = 2_000, maxPending = 16,
} = {}) {
  if (!adapter || typeof adapter.readProject !== 'function' || typeof adapter.bindObjectRead !== 'function') {
    throw new TypeError('Read service requires the real image adapter');
  }
  if (typeof imageId !== 'string' || !imageId || typeof objectReadBlockId !== 'string' || !objectReadBlockId) {
    throw new TypeError('Read service requires an image and installed object-read binding');
  }
  if (typeof authenticateRequest !== 'function' || typeof authorityForIdentity !== 'function') {
    throw new TypeError('Read service requires trusted identity and authority providers');
  }
  for (const [name, value] of Object.entries({operationTimeoutMs, responseTimeoutMs, drainTimeoutMs, maxPending})) {
    positiveInteger(value, name);
  }
  const objectReader = await adapter.bindObjectRead({imageId, blockId: objectReadBlockId});
  const pending = new Set();
  const responses = new Set();
  const sockets = new Map();
  let closing = false;
  let closePromise;
  let startPromise;
  const server = tls ? httpsServer(tls) : httpServer();
  server.headersTimeout = 5_000;
  server.requestTimeout = operationTimeoutMs;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  function registerSocket(socket) {
    if (sockets.has(socket)) return;
    const listeners = new Set();
    sockets.set(socket, listeners);
    socket.once('close', () => {
      sockets.delete(socket);
      for (const listener of [...listeners]) listener();
      listeners.clear();
    });
  }
  server.on('connection', registerSocket);
  // HTTPS request.socket is the TLSSocket, distinct from the pre-handshake
  // net.Socket. Retain both: TLS request lifetime and pre-handshake drain.
  if (tls) server.on('secureConnection', registerSocket);
  // One actual listener per TCP connection, including pipelined requests.
  // Completed obligations unregister immediately; no EventEmitter listener
  // warning or permanent per-request socket listener accumulates under load.
  function onSocketClose(socket, listener) {
    const listeners = sockets.get(socket);
    if (!listeners || socket.destroyed) { listener(); return () => {}; }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function handle(request, response) {
    const socket = request.socket;
    const sendResponse = (envelope) => send(response, envelope, responseTimeoutMs, socket, onSocketClose);
    if (closing) { request.resume(); await sendResponse(imageReadErrorResponse('CLOSED')); return; }
    if (request.method !== 'POST' || request.url !== PATH
        || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      request.resume();
      await sendResponse(imageReadErrorResponse('BAD_REQUEST'));
      return;
    }
    const controller = new AbortController();
    responses.add(controller);
    const disconnected = () => {
      if (!response.writableFinished) controller.abort(imageReadFailure('CLOSED'));
    };
    response.once('close', disconnected);
    // Pipelined responses waiting behind another response have no socket yet
    // and need not emit close. The captured request socket owns their lifetime.
    const stopWatching = onSocketClose(socket, disconnected);
    const timer = setTimeout(() => controller.abort(imageReadFailure('TIMEOUT')), operationTimeoutMs);
    try {
      const input = parseImageReadRequest(await readBody(request, controller.signal), imageId);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (closing) throw imageReadFailure('CLOSED');
      if (pending.size >= maxPending) {
        await sendResponse(imageReadErrorResponse('BUSY'));
        return;
      }
      const checkLive = () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      const work = Promise.resolve().then(async () => {
        checkLive();
        let identity;
        try { identity = await authenticateRequest(request, {signal: controller.signal}); }
        catch { return imageReadErrorResponse('AUTHENTICATION'); }
        checkLive();
        if (identity === null || identity === undefined) return imageReadErrorResponse('AUTHENTICATION');
        // Identity is not permission. The provider selects an actual context
        // for THIS request; no ambient or serialized authority is retained.
        const authority = await authorityForIdentity(identity, {signal: controller.signal});
        checkLive();
        const result = input.operation === 'project'
          ? await adapter.readProject({imageId, projectId: input.projectId, authority})
          : await objectReader.read({objectId: input.objectId, authority});
        checkLive();
        return imageReadSuccess(result);
      });
      pending.add(work);
      // Keep capacity occupied until uncancellable work really settles.
      work.then(() => pending.delete(work), () => pending.delete(work));
      await sendResponse(await abortable(work, controller.signal));
    } catch (error) {
      const code = error?.code === 'IMAGE_READ_BAD_REQUEST' ? 'BAD_REQUEST'
        : controller.signal.aborted
          ? controller.signal.reason?.code === 'IMAGE_READ_TIMEOUT' ? 'TIMEOUT' : 'CLOSED'
          : error?.name === 'AuthorityError' ? 'DENIED'
            : error?.code === 'OBJECT_NOT_FOUND' ? 'NOT_FOUND' : 'FAILED';
      await sendResponse(imageReadErrorResponse(code));
    } finally {
      clearTimeout(timer);
      response.off('close', disconnected);
      stopWatching();
      responses.delete(controller);
    }
  }
  // Never let an unexpected response/serialization failure escape EventEmitter.
  server.on('request', (request, response) => {
    handle(request, response).catch(async () => {
      try {
        if (!response.headersSent) await send(response, imageReadErrorResponse('FAILED'), responseTimeoutMs, request.socket, onSocketClose);
        else response.destroy();
      } catch { response.destroy(); }
    });
  });

  return Object.freeze({
    async listen({host = '127.0.0.1', port = 0} = {}) {
      if (closing || startPromise) throw new TypeError('Read service cannot listen in its current state');
      if (!isIP(host)) throw new TypeError('Read service bind host must be an IP address');
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
      if (!tls && host !== '127.0.0.1' && host !== '::1') {
        throw new TypeError('Plaintext read service is limited to loopback; configure TLS for remote access');
      }
      startPromise = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      await startPromise;
      if (closing) {
        await closePromise;
        throw imageReadFailure('CLOSED');
      }
      const address = server.address();
      return Object.freeze({host: address.address, port: address.port, secure: Boolean(tls)});
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of responses) controller.abort(imageReadFailure('CLOSED'));
      closePromise = (async () => {
        const stopped = (async () => {
          try { await startPromise; } catch {}
          await new Promise((resolve) => {
            if (!server.listening) resolve();
            else server.close(resolve);
          });
        })();
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), drainTimeoutMs);
        });
        try {
          const drained = await Promise.race([
            Promise.all([stopped, Promise.allSettled([...pending])]).then(() => true),
            deadline,
          ]);
          if (!drained) {
            for (const socket of sockets.keys()) socket.destroy();
            await stopped;
            if (pending.size) {
              const error = new Error('Read service closed transport with backend work still pending.');
              error.name = 'ImageReadServiceDrainError';
              throw error;
            }
          }
        } finally { clearTimeout(timer); }
      })();
      return closePromise;
    },
    get pendingOperations() { return pending.size; },
    get pendingResponses() { return responses.size; },
  });
}

export {createImageReadService};
