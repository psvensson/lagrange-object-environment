/**
 * The Lagrange-owned wasi-gfx:surface/surface-webgpu@0.2.0 host provider.
 *
 * Bridges a Lagrange Surface to the WebGPU WIT resources supplied by the
 * consumed @wasi-gfx/wasi-gfx-shim/webgpu host provider. This is the seam where
 * OUR surface ownership meets the shim's wasi:webgpu resource mapping.
 *
 * The Context delegates the actual "current texture" to a host-side
 * RenderTarget (render-target.js) — a CanvasRenderTarget for on-screen browser
 * presentation or a TextureRenderTarget for headless/test/export rendering. The
 * renderer Component is unaware which realization it received: configure /
 * getCurrentTexture / present / unconfigure behave identically against either.
 * Neither the Presentation nor the Compositor knows which one exists.
 *
 * It reuses the shim's exported building blocks (inner, GpuTexture, converters)
 * — consuming the webgpu export, not copying the mapping.
 */

import {
  inner,
  GpuTexture,
  convertTextureFormatWasiToWeb,
  convertTextureUsageWasiToWeb,
} from '@wasi-gfx/wasi-gfx-shim/webgpu';
import {CanvasRenderTarget} from './render-target.js';

class Context {
  #target;
  #device = null;
  #configured = null;

  constructor(surface) {
    // The Surface decides the realization: it carries a host-supplied
    // renderTarget (set by the owning adapter), defaulting to a canvas target
    // over the Surface's own canvas. The Component never sees this choice.
    this.#target = surface.renderTarget ?? new CanvasRenderTarget(surface.canvas);
    // Host-side bookkeeping: record this Context on its Surface so the owning
    // adapter can reach the render target (and its read-back, when present)
    // for exactly this view — keyed by Surface, so multi-view never crosses.
    if (surface) surface.context = this;
  }

  // configuration: {device (a shim GpuDevice), format, usage?, viewFormats?,
  // colorSpace?, toneMapping?, alphaMode?}. PR B supports the implemented
  // subset; optional colorSpace/toneMapping/alphaMode are not yet mapped.
  configure(configuration) {
    this.#device = configuration.device[inner];
    this.#configured = {
      device: this.#device,
      format: convertTextureFormatWasiToWeb(configuration.format),
      ...(configuration.usage ? {usage: convertTextureUsageWasiToWeb(configuration.usage)} : {}),
      ...(configuration.viewFormats
        ? {viewFormats: Array.from(configuration.viewFormats).map(convertTextureFormatWasiToWeb)}
        : {}),
    };
    this.#target.configure(this.#configured);
  }

  unconfigure() {
    this.#target.unconfigure();
  }

  getCurrentTexture() {
    return new GpuTexture(this.#target.getCurrentTexture());
  }

  present() {
    this.#target.present();
  }

  // Host-side: the render target behind this Context (e.g. so the owning
  // adapter can resize it or read its pixels when it is a TextureRenderTarget).
  get renderTarget() {
    return this.#target;
  }
}

export {Context};
export default {Context};
