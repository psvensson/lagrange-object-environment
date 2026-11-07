// The read-service protocol carries semantic results, never authority.
const IMAGE_READ_PROTOCOL = 'environment-image-read/v1';
const safeErrors = new WeakSet();
const failures = Object.freeze({
  BAD_REQUEST: [400, 'ImageReadProtocolError', 'Invalid image read request.'],
  AUTHENTICATION: [401, 'ImageAuthenticationError', 'Authentication failed.'],
  DENIED: [403, 'AuthorityError', 'Not authorized to read this subject.'],
  NOT_FOUND: [404, 'ObjectReadNotFoundError', 'Object not found.'],
  FAILED: [502, 'ImageReadServiceError', 'Image read failed.'],
  BUSY: [503, 'ImageReadBusyError', 'Image read service is busy.'],
  TIMEOUT: [504, 'ImageReadTimeoutError', 'Image read timed out.'],
  CLOSED: [503, 'AbortError', 'Image read connection closed.'],
  UNAVAILABLE: [502, 'ImageReadConnectionError', 'Cannot reach the image read service.'],
  INVALID_RESPONSE: [502, 'ImageReadProtocolError', 'Invalid image read response.'],
});

function imageReadFailure(code) {
  const entry = failures[code];
  if (!entry || !Object.hasOwn(failures, code)) throw new TypeError('Unknown image read failure');
  const error = new Error(entry[2]);
  error.name = entry[1];
  error.code = code === 'NOT_FOUND' ? 'OBJECT_NOT_FOUND' : 'IMAGE_READ_' + code;
  safeErrors.add(error);
  return error;
}

function imageReadErrorResponse(code) {
  if (!Object.hasOwn(failures, code)) throw new TypeError('Unknown image read failure');
  return {status: failures[code][0], body: {protocol: IMAGE_READ_PROTOCOL, ok: false, error: code}};
}

function exactKeys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
}

function parseImageReadRequest(value, imageId) {
  const identity = value?.operation === 'project' ? 'projectId'
    : value?.operation === 'object' ? 'objectId' : null;
  if (!identity || !exactKeys(value, ['protocol', 'operation', 'imageId', identity])
      || value.protocol !== IMAGE_READ_PROTOCOL
      || typeof value.imageId !== 'string' || value.imageId.length === 0
      || typeof value[identity] !== 'string' || value[identity].length === 0
      || (imageId !== undefined && value.imageId !== imageId)) {
    throw imageReadFailure('BAD_REQUEST');
  }
  return Object.freeze({...value});
}

function imageReadSuccess(result) {
  return {status: 200, body: {protocol: IMAGE_READ_PROTOCOL, ok: true, result}};
}

function parseImageReadResponse(response) {
  if (typeof response?.body !== 'string' || response.body.length > 4 * 1024 * 1024) {
    throw imageReadFailure('INVALID_RESPONSE');
  }
  let body;
  try { body = JSON.parse(response?.body); } catch { throw imageReadFailure('INVALID_RESPONSE'); }
  if (body?.protocol !== IMAGE_READ_PROTOCOL) throw imageReadFailure('INVALID_RESPONSE');
  if (body.ok === true && response.status === 200 && exactKeys(body, ['protocol', 'ok', 'result'])) {
    return body.result;
  }
  if (body.ok === false && exactKeys(body, ['protocol', 'ok', 'error'])
      && typeof body.error === 'string' && Object.hasOwn(failures, body.error)
      && failures[body.error][0] === response.status) {
    throw imageReadFailure(body.error);
  }
  throw imageReadFailure('INVALID_RESPONSE');
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(name + ' must be a positive integer within the timer range');
  }
  return value;
}

function createImageReadConnection({request, timeoutMs = 10_000, maxPending = 16} = {}) {
  if (typeof request !== 'function') throw new TypeError('Image read connection requires a transport');
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxPending, 'maxPending');
  const pending = new Set();
  let closed = false;

  async function read(operation, args) {
    if (closed) throw imageReadFailure('CLOSED');
    if (pending.size >= maxPending) throw imageReadFailure('BUSY');
    const identity = operation === 'project' ? 'projectId' : 'objectId';
    if (!exactKeys(args, ['imageId', identity])) throw imageReadFailure('BAD_REQUEST');
    const envelope = parseImageReadRequest({...args, protocol: IMAGE_READ_PROTOCOL, operation});
    const controller = new AbortController();
    pending.add(controller);
    const transport = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return request(envelope, {signal: controller.signal});
    });
    // A transport that ignores abort still occupies capacity until it settles.
    // Both handlers are terminal: a late failure cannot become unhandled.
    transport.then(() => pending.delete(controller), () => pending.delete(controller));
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    const timer = setTimeout(() => controller.abort(imageReadFailure('TIMEOUT')), timeoutMs);
    try {
      const response = await Promise.race([transport, interrupted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (closed) throw imageReadFailure('CLOSED');
      return parseImageReadResponse(response);
    } catch (error) {
      throw safeErrors.has(error) ? error : imageReadFailure('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  return Object.freeze({
    readProject: (args) => read('project', args),
    readObject: (args) => read('object', args),
    close() {
      if (closed) return;
      closed = true;
      for (const controller of pending) controller.abort(imageReadFailure('CLOSED'));
    },
    get pendingRequests() { return pending.size; },
  });
}

export {
  IMAGE_READ_PROTOCOL, createImageReadConnection, imageReadFailure,
  imageReadErrorResponse, imageReadSuccess, parseImageReadRequest, positiveInteger,
};
