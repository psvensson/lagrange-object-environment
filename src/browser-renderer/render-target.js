/**
 * Host-side render-target realizations for the wasi-gfx:surface/surface-webgpu
 * Context.
 *
 * A renderer should not fundamentally require a screen. The renderer Component
 * renders to the surface-webgpu Context's "current texture"; WHERE that texture
 * comes from is a host-side realization detail the Component never sees:
 *
 *   RenderTarget
 *     ├── CanvasRenderTarget  — a real on-screen <canvas> (GPUCanvasContext):
 *     │     interactive browser presentation. Pixels are composited by the
 *     │     browser; reading them back is environment-dependent (it crashes
 *     │     Chrome+SwiftShader under Xvfb/headless).
 *     │
 *     └── TextureRenderTarget — a host-owned GPUTexture (device.createTexture):
 *           headless rendering, tests, thumbnails, image/video export, and a
 *           natural future remote-rendering seam. Deterministic CPU read-back
 *           via copyTextureToBuffer, with no display/compositor dependency.
 *
 * The renderer Component is completely unaware which realization it received:
 * both expose the same narrow interface the surface-webgpu Context consumes
 * (configure / getCurrentTexture / present / unconfigure / setSize). Neither
 * the Presentation nor the Compositor knows which one exists — the choice is
 * made by the BrowserRendererAdapter's host wiring.
 *
 * This seam exists because of a real environment finding (recorded in Beads):
 * reading back an on-screen canvas's WebGPU texture crashes the GPU instance
 * under Xvfb/headless SwiftShader, while a plain device texture reads back
 * fine. The TextureRenderTarget gives CI a deterministic, hardware-independent
 * pixel proof through the EXACT same Component/WIT/shim path — not a separate
 * JS renderer.
 */

/**
 * CanvasRenderTarget: the production realization. Wraps a real <canvas>'s
 * GPUCanvasContext. The browser composites and presents; present() is a no-op
 * on the web (the canvas presents automatically after the frame).
 */
class CanvasRenderTarget {
  #canvas;
  #context = null;
  #device = null;
  #format = null;
  #pendingCapture = null;

  constructor(canvas) {
    this.#canvas = canvas;
  }

  get canvas() {
    return this.#canvas;
  }

  configure({device, format, usage, viewFormats}) {
    this.#device = device;
    this.#format = format;
    this.#context = this.#canvas.getContext('webgpu');
    if (!this.#context) {
      throw new Error('CanvasRenderTarget: the canvas has no WebGPU context (browser WebGPU unavailable)');
    }
    // OR in COPY_SRC so the optional host diagnostic read-back (readPixels) can
    // copy the canvas texture. Additive; the Component did not ask for it.
    this.#context.configure({
      device,
      format,
      usage: (usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC,
      ...(viewFormats ? {viewFormats} : {}),
    });
  }

  getCurrentTexture() {
    return this.#context.getCurrentTexture();
  }

  present() {
    // A WebGPU canvas's current texture is transient — valid only during the
    // frame — so the diagnostic read-back must capture it HERE, in the frame.
    const pending = this.#pendingCapture;
    if (pending && this.#device) {
      this.#pendingCapture = null;
      const texture = this.#context.getCurrentTexture();
      const width = Math.max(1, texture.width);
      const height = Math.max(1, texture.height);
      const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const buffer = this.#device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = this.#device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture}, {buffer, bytesPerRow}, [width, height, 1]);
      this.#device.queue.submit([encoder.finish()]);
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = new Uint8Array(buffer.getMappedRange()).slice();
        buffer.unmap();
        buffer.destroy();
        pending.resolve({data, width, height, bytesPerRow});
      }).catch(pending.reject);
    }
    // Otherwise no-op: the canvas presents automatically after the frame.
  }

  setSize(width, height) {
    this.#canvas.width = width;
    this.#canvas.height = height;
    // The canvas texture is re-acquired on the next getCurrentTexture(); no
    // explicit target recreation is needed for a canvas.
  }

  // Optional host DIAGNOSTIC (real-display only; NOT part of CI): capture the
  // next frame's canvas texture. Reading an on-screen canvas's WebGPU texture
  // crashes Chrome+SwiftShader under Xvfb/headless, so this is only usable on a
  // real display. The gating pixel proof uses TextureRenderTarget instead.
  readPixels() {
    if (!this.#device) return Promise.resolve(null);
    if (this.#pendingCapture) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#pendingCapture = {resolve, reject};
    });
  }

  unconfigure() {
    if (this.#context) this.#context.unconfigure();
  }
}

/**
 * TextureRenderTarget: the headless/test/export realization. Renders into a
 * host-owned GPUTexture with RENDER_ATTACHMENT | COPY_SRC so the frame can be
 * read back to the CPU deterministically (no compositor). Resize recreates the
 * texture; teardown destroys it. readPixels() captures the current frame.
 */
class TextureRenderTarget {
  #device = null;
  #format = null;
  #texture = null;
  #width = 0;
  #height = 0;

  // Width/height come from the owning Surface (the adapter's logical size).
  constructor(width = 0, height = 0) {
    this.#width = width;
    this.#height = height;
  }

  configure({device, format /* usage, viewFormats are host-decided here */}) {
    this.#device = device;
    this.#format = format;
    this.#recreate();
  }

  #recreate() {
    if (!this.#device || !this.#format) return;
    if (this.#texture) this.#texture.destroy();
    const width = Math.max(1, this.#width);
    const height = Math.max(1, this.#height);
    this.#texture = this.#device.createTexture({
      size: [width, height, 1],
      format: this.#format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  getCurrentTexture() {
    if (!this.#texture) this.#recreate();
    return this.#texture;
  }

  present() {
    // No display to present to; the frame is already complete in the texture.
  }

  setSize(width, height) {
    this.#width = width;
    this.#height = height;
    this.#recreate();
  }

  // Host-side inspection (NOT part of the WIT contract): read the current
  // frame back to CPU pixels. Deterministic under software/headless WebGPU.
  async readPixels() {
    if (!this.#device || !this.#texture) return null;
    const width = Math.max(1, this.#width);
    const height = Math.max(1, this.#height);
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = this.#device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture: this.#texture}, {buffer, bytesPerRow}, [width, height, 1]);
    this.#device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    return {data, width, height, bytesPerRow};
  }

  unconfigure() {
    if (this.#texture) {
      this.#texture.destroy();
      this.#texture = null;
    }
  }
}

export {CanvasRenderTarget, TextureRenderTarget};
export default {CanvasRenderTarget, TextureRenderTarget};
