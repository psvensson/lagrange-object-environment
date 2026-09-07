import {Command} from './model.js';

/**
 * Command invocation with authority pass-through, per ADR 0010.
 *
 * The `CommandDispatcher` owns the Command -> image-operation interaction:
 * it resolves a Command + subject, invokes it, and maps the outcome into a
 * typed error taxonomy. It delegates the actual image crossing (and the
 * authority that crosses with it) to the injected image seam — the seam the
 * `ImageClientAdapter` implements.
 *
 * Invariants enforced here:
 *  - authority is pass-through: the dispatcher never mints, stores, caches,
 *    attenuates, widens, inspects or branches on the authority context. It is
 *    handed to the seam exactly as received, on every call.
 *  - authorization is not decided here: applicability (environment-side) is
 *    checked before the seam is called; denial surfaces as a distinct typed
 *    error, not a policy the dispatcher invented.
 *  - conflicts are surfaced, never silently retried; the caller's argument bag
 *    (`context`) — including any opaque version token — is forwarded to the
 *    seam unchanged.
 *
 * The module is pure: the image seam is injected, so the contract is testable
 * without a live image, mirroring the ADR 0009 observation core.
 */

class CommandNotApplicableError extends Error {
  constructor(commandId) {
    super(`command ${commandId} does not apply to the subject`);
    this.name = 'CommandNotApplicableError';
    this.commandId = commandId;
  }
}

class CommandAuthorizationError extends Error {
  constructor(message, {operation, resource, cause} = {}) {
    super(message ?? 'command invocation was not authorized');
    this.name = 'CommandAuthorizationError';
    if (operation !== undefined) this.operation = operation;
    if (resource !== undefined) this.resource = resource;
    if (cause !== undefined) this.cause = cause;
  }
}

class CommandConflictError extends Error {
  constructor(message, {cause} = {}) {
    super(message ?? 'command invocation conflicted with a concurrent change');
    this.name = 'CommandConflictError';
    if (cause !== undefined) this.cause = cause;
    // Deliberately no backend version numbers: the substrate's authorized lane
    // translates and hides them (ADR 0010), so there is nothing honest to add.
  }
}

class CommandExecutionError extends Error {
  constructor(message, {cause} = {}) {
    super(message ?? 'command invocation failed');
    this.name = 'CommandExecutionError';
    if (cause !== undefined) this.cause = cause;
  }
}

// Classification is name-based: matching lagrange-images error *classes* with
// instanceof would require a runtime dependency on the substrate, which the
// renderer-independence rule forbids. The accepted edge is that a non-substrate
// thrower using a colliding `name` (e.g. a foreign 'AuthorityError') is
// classified by that name; substrate error names are stable, owned below.
function isAuthorityError(error) {
  return Boolean(error && (error.name === 'AuthorityError' || error instanceof CommandAuthorizationError));
}

// A CONFLICT is a LOST UPDATE: the caller's observed state was overtaken, so its
// write was refused and someone else's is current. `SmalltalkStaleMethodPositionError`
// (Images #218, Bead eij.3) is exactly that for a native method position, and it
// joins the two generic object-lane conflicts here rather than at the adapter,
// because this module is the Environment's Command error owner.
//
// `SmalltalkMethodReplacementContentionError` is DELIBERATELY ABSENT and must stay
// absent. Images is explicit that it is TRANSIENT and NOT staleness: the observed
// position did not move and was not advanced. Mapping it here would turn a
// retryable contention into a false "someone else changed this" report -- a lie
// about what happened to the user's work. It stays a CommandExecutionError until a
// consumer exists that would actually act on a transient/retry outcome; inventing
// that outcome now would be an unfalsifiable taxonomy.
//
// WHAT A CONSUMER DOES WITH IT, stated to match the policy E3 actually implements
// rather than the one an earlier draft of this comment described. That draft said
// "the honest response is to retry from a fresh authorized read", which reads as
// an automatic reread and contradicts NativeSmalltalkBrowser: because the observed
// position did NOT move, the descriptor on screen is still exactly what Images
// would answer, so the display is LEFT ALONE and the failure is reported as an
// ordinary execution failure. Retrying is then the user's decision, taken against
// a display that is already current -- not a reread this owner or the browser
// performs on their behalf. Only a CONFLICT, where the position did move, earns an
// authoritative reread.
function isConflictError(error) {
  return Boolean(
    error &&
    (error.name === 'ObjectMutationConflictError'
      || error.name === 'VersionConflictError'
      || error.name === 'SmalltalkStaleMethodPositionError'
      || error instanceof CommandConflictError),
  );
}

/**
 * Classify an error thrown by the image seam into the dispatcher's typed
 * taxonomy. Reads the error, not the call site.
 */
function classifyInvocationError(error) {
  if (isAuthorityError(error)) {
    return new CommandAuthorizationError(error.message, {
      operation: error.operation,
      resource: error.resource,
      cause: error,
    });
  }
  if (isConflictError(error)) {
    return new CommandConflictError(error.message, {cause: error});
  }
  return new CommandExecutionError(error?.message ?? 'command invocation failed', {cause: error});
}

/**
 * Create a CommandDispatcher over an injected image seam.
 *
 *   invoke({ command, subject, authority, context, image })
 *
 * - command:   a Command (src/model.js).
 * - subject:   the semantic subject the command runs on.
 * - authority: an opaque per-call authority context. Passed through untouched;
 *              never retained beyond this call.
 * - context:   optional argument bag forwarded to the seam untouched (it may
 *              carry an opaque version token for optimistic concurrency).
 * - image:     the injected seam: async ({command, subject, authority, context})
 *              => result. This is the ImageClientAdapter's contract. Invoking
 *              the Command (calling command.invoke) is the SEAM's
 *              responsibility, not the dispatcher's — invocation must cross the
 *              image authorization boundary (ADR 0004), which only the seam reaches.
 */
function createCommandDispatcher({image} = {}) {
  if (typeof image !== 'function') {
    throw new TypeError('createCommandDispatcher requires an image seam function');
  }

  async function dispatch({command, subject, authority = null, context = {}} = {}) {
    if (!(command instanceof Command)) {
      throw new TypeError('dispatch requires a Command');
    }
    // Applicability is environment-side and is checked before the seam is
    // touched; a not-applicable command never crosses the image boundary.
    if (!command.applies(subject, context)) {
      throw new CommandNotApplicableError(command.id);
    }
    try {
      return await image({command, subject, authority, context});
    } catch (error) {
      throw classifyInvocationError(error);
    }
  }

  return Object.freeze({dispatch});
}

export {
  CommandAuthorizationError,
  CommandConflictError,
  CommandExecutionError,
  CommandNotApplicableError,
  classifyInvocationError,
  createCommandDispatcher,
};
