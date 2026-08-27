// world root:component/root
import type * as LagrangeAssetsProvider from './interfaces/lagrange-assets-provider.js'; // lagrange:assets/provider@0.1.0
import type * as WasiGfxSurfaceSurfaceWebgpu from './interfaces/wasi-gfx-surface-surface-webgpu.js'; // wasi-gfx:surface/surface-webgpu@0.2.0
import type * as WasiGfxSurfaceSurface from './interfaces/wasi-gfx-surface-surface.js'; // wasi-gfx:surface/surface@0.2.0
import type * as WasiWebgpuWebgpu from './interfaces/wasi-webgpu-webgpu.js'; // wasi:webgpu/webgpu@0.3.0-rc.2
export interface ImportObject {
  print: {
    'default'(s: string): void,
  },
  'lagrange:assets/provider@0.1.0': typeof LagrangeAssetsProvider,
  'wasi-gfx:surface/surface-webgpu@0.2.0': typeof WasiGfxSurfaceSurfaceWebgpu,
  'wasi-gfx:surface/surface@0.2.0': typeof WasiGfxSurfaceSurface,
  'wasi:webgpu/webgpu@0.3.0-rc.2': typeof WasiWebgpuWebgpu,
}
export interface Root {
  start(): Promise<void>,
}

/**
* Instantiates this component with the provided imports and
* returns a map of all the exports of the component.
*
* This function is intended to be similar to the
* `WebAssembly.Instantiate` constructor. The second `imports`
* argument is the "import object" for wasm, except here it
* uses component-model-layer types instead of core wasm
* integers/numbers/etc.
*
* The first argument to this function, `getCoreModule`, is
* used to compile core wasm modules within the component.
* Components are composed of core wasm modules and this callback
* will be invoked per core wasm module. The caller of this
* function is responsible for reading the core wasm module
* identified by `path` and returning its compiled
* `WebAssembly.Module` object. This would use the
* `WebAssembly.Module` constructor on the web, for example.
*/
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance
): Root;
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module | Promise<WebAssembly.Module>,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance | Promise<WebAssembly.Instance>
): Root | Promise<Root>;

