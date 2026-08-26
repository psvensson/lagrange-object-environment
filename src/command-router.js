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
    // never authorization. Selection among applicable commands is the router's
    // UI-invocation policy: an explicit context.commandId wins; otherwise the
    // minimal default is the first applicable command.
    const {commands} = commandRegistry.discover(subject, context);
    const command = commands.find((c) => c.id === context.commandId) ?? commands[0] ?? null;
    if (!command) {
      return null; // no applicable command
    }

    // Authorization happens AT DISPATCH: a fresh authority context from the
    // provider (the Session connection-locus seam), never minted/stored here.
    const authority = await authorityProvider({
      kind: 'semantic-interaction',
      intent: intentDescriptor,
      subject,
      commandId: command.id,
    });

    return dispatch(command, subject, {authority, context});
  }

  return Object.freeze({consumeIntent});
}

export {createCommandRouter};
