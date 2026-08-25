/**
 * The Lagrange-owned host provider for the `lagrange:assets/provider@0.1.0`
 * WIT import. This is the asset-transfer seam: durable GLB bytes cross the
 * host -> Component boundary AT RUNTIME (upstream wasi-gfx examples bake assets
 * in at build time; this loads them per-attach).
 *
 * OWNERSHIP: this module is BrowserRendererAdapter host wiring — an INJECTED
 * byte source, NOT an asset store. The adapter registers bytes per-attach
 * (inside attachPresentation, before the Component starts) via
 * `registerAssetSource`, and the Component pulls them by name through
 * `loadGlb`. The asset-bytes AUTHORITY (which subsystem owns the durable bytes
 * and decides what gets registered) is a separate concern — Bead
 * lagrange-object-environment-0dm. This module holds no durable state of its
 * own: it is a per-attach conduit, cleared on Session teardown so a cold
 * Component provably re-receives its bytes.
 *
 * The Component's transpiled binding imports `loadGlb` (named export) and calls
 * it; a thrown error becomes the WIT `err(string)` arm.
 */

// The per-Session byte source, injected by the adapter. A Map<name, Uint8Array>
// supplied per attachPresentation; cleared on destroyAll. Never an ambient,
// page-level store — the adapter owns its lifecycle.
let assetSource = null;

// Host wiring (called by BrowserRendererAdapter): install the byte source for
// the NEXT Component attach. `source` is a Map<string, Uint8Array> (or an
// object with get(name)). Pass null to clear.
function registerAssetSource(source) {
  assetSource = source;
}

// Clear the byte source (Session teardown). After this, loadGlb fails until
// the adapter registers a fresh source — proving a cold Component re-receives
// its bytes rather than reading ambient page state.
function clearAssetSource() {
  assetSource = null;
}

// The WIT import the Component calls: load-glb(name) -> result<list<u8>,string>.
// Returns the registered bytes; the jco trampoline copies them into the
// Component's own linear memory, so the Component receives its own list<u8>.
// Throws (becoming the err arm) when the name is unknown.
function loadGlb(name) {
  const bytes = assetSource && typeof assetSource.get === 'function'
    ? assetSource.get(name)
    : undefined;
  if (!bytes) {
    throw new Error(`load-glb: unknown or unavailable asset "${name}" (no byte source registered for this attach)`);
  }
  return bytes;
}

export {loadGlb, registerAssetSource, clearAssetSource};
export default {loadGlb, registerAssetSource, clearAssetSource};
