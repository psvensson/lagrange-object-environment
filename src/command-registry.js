import {Command} from './model.js';

/**
 * CommandRegistry: the single owner of command DISCOVERY (ADR 0004,
 * docs/ownership.md). A Command is one discoverable/applicable operation on a
 * semantic subject; this registry answers "which commands apply to this
 * subject in this context?"
 *
 * DISCOVERABLE/APPLICABLE != AUTHORIZED (ADR 0004). This registry filters on
 * applicability ONLY and never consults the authority system: a command that
 * is applicable but not authorized is still returned, so a consumer can show
 * the operations that conceptually exist (enabled or visibly-will-deny).
 * Authorization happens later, at invocation, through CommandDispatcher and
 * the image boundary (ADR 0010) — never here. A returned Command is
 * {id, title, appliesTo, invoke}; it carries no authority and confers none.
 *
 * The contract is deliberately small and renderer-independent. Commands and
 * discovery are SYNCHRONOUS (Command.applies is synchronous). Ordering is
 * registration order; there is NO priority field — the registry owns only a
 * deterministic ordered list, and choosing among applicable commands is the
 * consumer's concern.
 */

function requireCommand(command) {
  if (!(command instanceof Command)) {
    throw new TypeError('the command registry registers Command instances (src/model.js)');
  }
  return command;
}

function createCommandRegistry() {
  const commands = [];

  function register(command) {
    commands.push(requireCommand(command));
    return command;
  }

  /**
   * discover(subject, context) -> {commands, failures}
   *
   * Returns the registered Commands applicable to the subject, in registration
   * order (Command.applies). A command whose appliesTo THROWS cannot decide
   * its applicability, so it is treated as not applicable, isolated from the
   * others (their discovery is not aborted), and surfaced in `failures` rather
   * than swallowed. Authorization is never consulted.
   *
   * Returns {commands: Command[], failures: [{commandId, error}]}.
   */
  function discover(subject, context = {}) {
    const applicable = [];
    const failures = [];
    for (const command of commands) {
      let applies;
      try {
        applies = command.applies(subject, context);
      } catch (error) {
        failures.push(Object.freeze({commandId: command.id, error}));
        continue;
      }
      if (applies) applicable.push(command);
    }
    return Object.freeze({
      commands: Object.freeze(applicable),
      failures: Object.freeze(failures),
    });
  }

  return Object.freeze({register, discover});
}

export {createCommandRegistry};
