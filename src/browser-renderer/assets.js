/**
 * The Lagrange-owned host factory for the `lagrange:assets/provider@0.1.0`
 * WIT import — the asset-transfer seam. Durable asset bytes cross the
 * host -> Component boundary AT RUNTIME, under authority, scoped per-attach.
 *
 * OWNERSHIP: this module is BrowserRendererAdapter host wiring — it builds an
 * INJECTED, attach-scoped byte source, NOT an asset store. The asset-bytes
 * AUTHORITY (resolving durable refs to bytes under object/read) is the
 * environment's authorized read lane (ImageClientAdapter, docs/ownership.md):
 * the adapter receives only an attach-scoped Map<presentationLocalName,
 * Uint8Array>, never refs, ids, or authority. Bytes are opaque here.
 *
 * ISOLATION (Bead lagrange-object-environment-0dm): the Component is
 * transpiled in jco INSTANTIATION mode — `instantiate(getCoreModule, imports)`
 * takes host imports PER INSTANCE. Per attach, the adapter builds a provider
 * with `createAssetProvider(allowlist)` and passes it as `imports['lagrange-assets']`
 * for that one Component instance. There is NO module-global provider, registry,
 * "current attach", or ambient byte store — Component A's `load` closure
 * contains only A's allowlist, so it cannot name-or-guess Component B's bytes.
 * Teardown simply drops the instance (and with it, the provider closure).
 */

/**
 * Build the `lagrange:assets/provider` host import for ONE attach, closing over
 * exactly that attach's allowlist (Map<presentationLocalName, Uint8Array>).
 *
 * The returned `load(name) -> result<list<u8>,string>` is the WIT import the
 * Component instance calls. It serves ONLY names in THIS attach's closed
 * allowlist — a guessed image/object id or another attach's name throws (the
 * WIT err arm). The jco trampoline copies the bytes into the Component's own
 * linear memory, so the Component receives its own list<u8>; the host treats
 * the bytes as opaque.
 *
 * @param {Map<string, Uint8Array>} allowlist the attach-scoped, authorized bytes
 * @returns {{load(name: string): Uint8Array}} the per-instance host import
 */
function createAssetProvider(allowlist) {
  const bytes = allowlist instanceof Map ? allowlist : new Map(Object.entries(allowlist ?? {}));
  return {
    load(name) {
      if (!bytes.has(name)) {
        throw new Error(`load: "${name}" is not in this attach's asset allowlist`);
      }
      return bytes.get(name);
    },
  };
}

export {createAssetProvider};
export default {createAssetProvider};
