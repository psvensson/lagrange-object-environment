/**
 * The wasi:webgpu/webgpu@0.3.0-rc.2 host provider for the browser.
 *
 * Per the PR B dependency boundary, the ~2500-line wasi:webgpu WIT-resource
 * <-> navigator.gpu mapping is ECOSYSTEM glue that stays replaceable upstream
 * code, not Lagrange ownership code. So this module simply re-exports the
 * consumed, exactly-pinned @wasi-gfx/wasi-gfx-shim/webgpu host provider.
 *
 * Lagrange owns the RendererAdapter/Compositor lifecycle, the surface
 * (canvas/multi-view/resize), and the Session lifetime — see surface.js,
 * surface-webgpu.js, and browser-renderer-adapter.js. This dependency is only
 * the current implementation of one exact-version WIT host interface.
 *
 * Supported subset (PR B proves): requestAdapter, requestDevice, shader/
 * pipeline creation, command encoding, render pass, draw, queue submission,
 * and the surface texture/presentation path. PR B does NOT claim complete
 * wasi:webgpu support; Todo() stubs elsewhere in the shim are out of scope.
 */

export * from '@wasi-gfx/wasi-gfx-shim/webgpu';
export {default} from '@wasi-gfx/wasi-gfx-shim/webgpu';
