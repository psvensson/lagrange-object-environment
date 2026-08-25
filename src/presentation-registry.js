import {Presentation} from './model.js';

/**
 * PresentationRegistry: the single owner of presentation DISCOVERY (ADR 0004,
 * docs/ownership.md). A Presentation is one semantic subject shown in one
 * context; this registry answers "which providers can present this subject in
 * this context?" and returns the candidate Presentations.
 *
 * The contract is deliberately small and renderer-independent: no renderer
 * concepts, no priorities, no menus/windows, no component lifecycle. A
 * provider answers whether/how it can present a subject; the registry
 * discovers; the Presentation remains the semantic result.
 *
 * Providers and discovery are SYNCHRONOUS: presentability must be decidable
 * from the already-materialized subject and context. A consumer that needs the
 * image to decide (e.g. discovering that a ref is unavailable) reads first —
 * via ImageClientAdapter — and encodes the outcome into the subject (e.g.
 * {kind: 'unavailable-ref', reason}) before discovering. Revisit only if a
 * real provider cannot decide without an image read that cannot be hoisted.
 *
 * Ordering is registration order; there is NO priority field. The registry
 * owns only a deterministic ordered list — choosing one-versus-all is the
 * consumer's/Compositor's concern, not a registry policy. Fallback/catch-all
 * providers register last; providers that are disjoint by subject kind (e.g.
 * an unavailable-ref provider that returns null for normal subjects) never
 * race.
 *
 * Discovery never consults the authority system and never renders.
 */

function requireProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('a presentation provider must be an object');
  }
  if (typeof provider.id !== 'string' || provider.id.length === 0) {
    throw new TypeError('a presentation provider requires a non-empty id');
  }
  if (typeof provider.present !== 'function') {
    throw new TypeError(`presentation provider ${provider.id} requires a present(subject, context) function`);
  }
  return provider;
}

function createPresentationRegistry() {
  const providers = [];

  function register(provider) {
    providers.push(requireProvider(provider));
    return provider;
  }

  /**
   * discover(subject, context) -> {presentations, failures}
   *
   * Calls each provider's present(subject, context) in registration order and
   * collects the Presentations. A provider returning null contributes nothing.
   * A provider returning a non-Presentation is a programming error and throws
   * (fail-fast). A provider that THROWS is isolated from the others — it does
   * not abort their discovery — and its failure is surfaced in `failures`
   * rather than swallowed, so one bad extension neither poisons the set nor
   * vanishes silently.
   *
   * Returns {presentations: Presentation[], failures: [{providerId, error}]}.
   */
  function discover(subject, context = {}) {
    const presentations = [];
    const failures = [];
    for (const provider of providers) {
      let result;
      try {
        result = provider.present(subject, context);
      } catch (error) {
        failures.push(Object.freeze({providerId: provider.id, error}));
        continue;
      }
      if (result === null || result === undefined) continue;
      if (!(result instanceof Presentation)) {
        throw new TypeError(
          `presentation provider ${provider.id} returned a non-Presentation; the registry yields Presentations only`,
        );
      }
      presentations.push(result);
    }
    return Object.freeze({
      presentations: Object.freeze(presentations),
      failures: Object.freeze(failures),
    });
  }

  return Object.freeze({register, discover});
}

export {createPresentationRegistry};
