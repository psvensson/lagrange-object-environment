/**
 * CommandRouter: the owner of "input/gesture/key/menu -> semantic command"
 * (docs/ownership.md). This is the FIRST implementation of that planned row.
 *
 * Its job (ADR 0011 §6): a renderer interaction produces a SEMANTIC INTENT
 * DESCRIPTOR (plain data, e.g. {kind:'activate'}) — never a raw pixel
 * coordinate and never a subject. The router:
 *   1. resolves the semantic SUBJECT from the Compositor's durable intent
 *      (viewForSurfaceHandle -> presentationDescriptor.subject) — the renderer
 *      only said "an interaction happened on this view"; it never names a
 *      subject;
 *   2. discovers a candidate Command from the CommandRegistry (applicability
 *      ONLY — discovery is never authorization);
 *   3. dispatches it through the ordinary CommandDispatcher with a PER-
 *      INVOCATION authority context from the injected authorityProvider (a
 *      fresh opaque context per dispatch, never minted/stored/cached here).
 *
 * Invariants: a reference is never authority; applicability != authorization;
 * the router never authorizes — it routes. The image op is a real authorized
 * mutation through image-mutation-binding/v1 (the only authorized write lane),
 * not an unguarded write.
 */

/**
 * An EXPLICITLY requested Command could not be selected for this subject
 * (Bead z9b).
 *
 * It carries ONLY the requested id. It deliberately does NOT say whether the
 * Command is unregistered or merely inapplicable here, and does not disclose the
 * registry's contents, any other Command's id, or anything about authority:
 *
 *   * the DISTINCTION is not needed to solve the consumer's problem, which is
 *     "the thing I asked for did not happen and I need to say so";
 *   * "unregistered" and "inapplicable here" are not separable from this owner:
 *     discovery legitimately depends on the caller's own context -- `discover`
 *     forwards it to `applies(subject, context)`, so `commandId` itself may
 *     influence applicability -- and answering it would need a lookup seam
 *     `CommandRegistry` does not have and should not grow, since it owns
 *     discovery and applicability, not lookup.
 *
 * NARROWLY: that inseparability covers ONLY that pair, and an earlier version of
 * this comment overstated it into a general impossibility. A THIRD case is
 * genuinely diagnosable, and since Bead 1yb it is no longer thrown away: a
 * requested Command whose own `applies` THREW is reported by rethrowing
 * `CommandRegistry`'s own failure error UNCHANGED, so this error is never
 * reached for it. That case is deliberately NOT folded into this class -- an
 * applicability crash is a programmer error owned by the Command, not an
 * "unavailable" answer, and pressing it in here (even as a `cause`) would widen
 * a contract whose whole value is how narrow it is.
 *
 * WHY LOUD RATHER THAN NULL. `consumeIntent` already answers null for three
 * unrelated reasons (the view is gone, it has no subject, nothing applies), and
 * a fourth would be the only one hiding a PROGRAMMER error -- a binding wired to
 * an id nothing answers would be permanently and silently inert. A consumer with
 * an error channel (an input binding's `onInputError`, an edit binding's
 * `onEditError`) can then show a failure instead of nothing happening, and does
 * not have to infer which of four causes produced a null.
 */
class RequestedCommandUnavailableError extends Error {
  constructor(commandId) {
    super(`the requested command ${JSON.stringify(commandId)} is not available for this subject`);
    this.name = 'RequestedCommandUnavailableError';
    this.commandId = commandId;
  }
}

function createCommandRouter({compositor, commandRegistry, dispatch, authorityProvider} = {}) {
  if (!compositor || typeof compositor.viewForSurfaceHandle !== 'function') {
    throw new TypeError('createCommandRouter requires a compositor with viewForSurfaceHandle(handle)');
  }
  if (!commandRegistry || typeof commandRegistry.discover !== 'function') {
    throw new TypeError('createCommandRouter requires a commandRegistry with discover(subject, context)');
  }
  // dispatch is the ImageClientAdapter's authorized dispatch seam:
  // dispatch(command, subject, {authority, context}) -> result. Invocation
  // crosses the image authorization boundary there, never here.
  if (typeof dispatch !== 'function') {
    throw new TypeError('createCommandRouter requires a dispatch(command, subject, {authority, context}) seam');
  }
  if (typeof authorityProvider !== 'function') {
    throw new TypeError('createCommandRouter requires an authorityProvider function (a fresh authority context per dispatch; the router never mints or stores one)');
  }

  /**
   * Consume a semantic intent on a renderer view and route it to a Command.
   *   intentDescriptor: plain data, e.g. {kind:'activate'} (from the renderer
   *     host's intent-resolution seam; carries no subject);
   *   surfaceHandle: the opaque renderer surface handle the interaction hit;
   *   context: extra dispatch context (plain data, e.g. {title, commandId}).
   * Returns the dispatch result, or null when the handle no longer resolves to
   * a live view / the view has no subject / no command applies.
   *
   * REJECTS when the caller named an explicit `context.commandId` that is not
   * among the applicable commands: with that Command's OWN applicability error,
   * unchanged, if it is the one that crashed while deciding (Bead 1yb), and
   * otherwise with `RequestedCommandUnavailableError` (Bead z9b). A caller on a
   * fire-and-forget renderer path must therefore have an error channel, or the
   * refusal is invisible to it.
   */
  async function consumeIntent(intentDescriptor, {surfaceHandle, context = {}} = {}) {
    const view = compositor.viewForSurfaceHandle(surfaceHandle);
    if (!view) {
      return null; // the view is gone (torn down); nothing to route
    }
    const subject = view.presentationDescriptor?.subject ?? null;
    if (!subject) {
      return null; // this view has no semantic subject to act on
    }

    // Applicability ONLY: discover candidate commands for this subject. This is
    // never authorization.
    // `failures` names every Command whose own `applies` THREW: the registry
    // isolates it, treats it as not applicable, and surfaces the error here
    // rather than swallowing it. Defaulted so a registry double that returns
    // only `{commands}` still means "nothing failed".
    const {commands, failures = []} = commandRegistry.discover(subject, context);

    // SELECTION POLICY. An explicit `context.commandId` is a STATEMENT OF INTENT,
    // not a hint: it dispatches exactly that Command, or NOTHING.
    //
    // This used to read `commands.find(...) ?? commands[0] ?? null`, which meant a
    // caller could ask for X and, if X was absent or inapplicable, silently get Y
    // executed against its subject.
    //
    // That is the whole defect and it is sufficient on its own. There was NO
    // authority divergence: the demand below is built from the SELECTED
    // `command.id`, so it always named the Command that actually ran.
    //
    // `undefined` AND `null` both count as ABSENT, and for an absent id the
    // previous default is unchanged: the first applicable Command. That path was
    // never the defect, and preserving it is why ownership row 65's requirement
    // (every edit binding declares its own commandId) is NOT retired by this
    // change -- EnvironmentShell still enforces it, and must.
    const requested = context.commandId;
    if (requested === undefined || requested === null) {
      const fallback = commands[0] ?? null;
      if (!fallback) return null; // nothing applies: an ordinary, quiet no-op
      return dispatchSelected(fallback);
    }

    // An explicitly requested Command that cannot be selected is LOUD (Bead z9b),
    // not a silent null. Discovery has ALREADY run above, with the caller's full
    // context unchanged -- selection happens strictly afterwards, so this never
    // becomes a "look X up first, discover second" model and never strips
    // `commandId` out of the context a Command's `applies` may legitimately read.
    const command = commands.find((c) => c.id === requested) ?? null;
    if (command) return dispatchSelected(command);

    // Bead 1yb. Before answering the generic "unavailable", check whether the
    // registry ALREADY told us why: a failure entry for the REQUESTED id means
    // that Command crashed while deciding its own applicability. That is a
    // programmer error owned by the Command and merely relayed here, so the
    // THROWN VALUE is rethrown exactly as it came -- no wrapper, no `cause`, no
    // new taxonomy -- which preserves Error identity, stack and any structured
    // information WHEN what was thrown is an Error. Stated as the value and not
    // as "the stack" on purpose: JavaScript permits `throw 'boom'` / `throw null`
    // / `throw undefined`, and `CommandRegistry` captures whatever was thrown
    // without requiring `instanceof Error`. A direct rethrow is right for those
    // too; a wrapper would have had to invent a policy for them.
    //
    // This owner decides only WHICH discovery result belongs to the explicit
    // request; it never invents a message for something `CommandRegistry`
    // already knows.
    //
    // ONLY the matching entry, never another Command's: an unrelated failure is
    // registry contents this error contract does not disclose, and it must not
    // poison a request that has nothing to do with it.
    //
    // An applicable match wins over a failure entry above, which is observable
    // only under duplicate Command ids -- the ordered discovery result is
    // followed mechanically there, and this slice decides no uniqueness policy.
    const failure = failures.find((f) => f.commandId === requested) ?? null;
    if (failure) throw failure.error;

    throw new RequestedCommandUnavailableError(requested);

    async function dispatchSelected(selected) {

      // Authorization happens AT DISPATCH: a fresh authority context from the
      // provider (the Session connection-locus seam), never minted/stored here.
      // Reached ONLY for a Command that was actually selected, so a refused
      // request never mints authority.
      const authority = await authorityProvider({
        kind: 'semantic-interaction',
        intent: intentDescriptor,
        subject,
        commandId: selected.id,
      });

      return dispatch(selected, subject, {authority, context});
    }
  }

  return Object.freeze({consumeIntent});
}

export {createCommandRouter, RequestedCommandUnavailableError};
