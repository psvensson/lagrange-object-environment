/**
 * Renderer error taxonomy (mirrors command-dispatcher.js). A RendererAdapter
 * reports failures to the Compositor as typed errors, never raw host
 * exceptions, so the Compositor can map them without crashing the Session.
 *
 * RendererResourceLostError: a concrete renderer resource (surface/device) was
 * lost — e.g. GPU device-lost. The affected view is marked lost; the Session
 * and other views survive. Recreation happens later, from durable intention,
 * on Session restore (ADR 0011 §4) — not automatically mid-Session.
 */
class RendererError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RendererError';
  }
}

class RendererResourceLostError extends RendererError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RendererResourceLostError';
  }
}

export {RendererError, RendererResourceLostError};
