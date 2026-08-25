/** @module Interface wasi:webgpu/webgpu@0.3.0-rc.2 **/
export function getGpu(): Gpu;
/**
 * # Variants
 * 
 * ## `"low-power"`
 * 
 * ## `"high-performance"`
 */
export type GpuPowerPreference = 'low-power' | 'high-performance';
export interface GpuRequestAdapterOptions {
  featureLevel?: string,
  powerPreference?: GpuPowerPreference,
  forceFallbackAdapter?: boolean,
  xrCompatible?: boolean,
}
/**
 * # Variants
 * 
 * ## `"r8unorm"`
 * 
 * ## `"r8snorm"`
 * 
 * ## `"r8uint"`
 * 
 * ## `"r8sint"`
 * 
 * ## `"r16unorm"`
 * 
 * ## `"r16snorm"`
 * 
 * ## `"r16uint"`
 * 
 * ## `"r16sint"`
 * 
 * ## `"r16float"`
 * 
 * ## `"rg8unorm"`
 * 
 * ## `"rg8snorm"`
 * 
 * ## `"rg8uint"`
 * 
 * ## `"rg8sint"`
 * 
 * ## `"r32uint"`
 * 
 * ## `"r32sint"`
 * 
 * ## `"r32float"`
 * 
 * ## `"rg16unorm"`
 * 
 * ## `"rg16snorm"`
 * 
 * ## `"rg16uint"`
 * 
 * ## `"rg16sint"`
 * 
 * ## `"rg16float"`
 * 
 * ## `"rgba8unorm"`
 * 
 * ## `"rgba8unorm-srgb"`
 * 
 * ## `"rgba8snorm"`
 * 
 * ## `"rgba8uint"`
 * 
 * ## `"rgba8sint"`
 * 
 * ## `"bgra8unorm"`
 * 
 * ## `"bgra8unorm-srgb"`
 * 
 * ## `"rgb9e5ufloat"`
 * 
 * ## `"rgb10a2uint"`
 * 
 * ## `"rgb10a2unorm"`
 * 
 * ## `"rg11b10ufloat"`
 * 
 * ## `"rg32uint"`
 * 
 * ## `"rg32sint"`
 * 
 * ## `"rg32float"`
 * 
 * ## `"rgba16unorm"`
 * 
 * ## `"rgba16snorm"`
 * 
 * ## `"rgba16uint"`
 * 
 * ## `"rgba16sint"`
 * 
 * ## `"rgba16float"`
 * 
 * ## `"rgba32uint"`
 * 
 * ## `"rgba32sint"`
 * 
 * ## `"rgba32float"`
 * 
 * ## `"stencil8"`
 * 
 * ## `"depth16unorm"`
 * 
 * ## `"depth24plus"`
 * 
 * ## `"depth24plus-stencil8"`
 * 
 * ## `"depth32float"`
 * 
 * ## `"depth32float-stencil8"`
 * 
 * ## `"bc1-rgba-unorm"`
 * 
 * ## `"bc1-rgba-unorm-srgb"`
 * 
 * ## `"bc2-rgba-unorm"`
 * 
 * ## `"bc2-rgba-unorm-srgb"`
 * 
 * ## `"bc3-rgba-unorm"`
 * 
 * ## `"bc3-rgba-unorm-srgb"`
 * 
 * ## `"bc4-r-unorm"`
 * 
 * ## `"bc4-r-snorm"`
 * 
 * ## `"bc5-rg-unorm"`
 * 
 * ## `"bc5-rg-snorm"`
 * 
 * ## `"bc6h-rgb-ufloat"`
 * 
 * ## `"bc6h-rgb-float"`
 * 
 * ## `"bc7-rgba-unorm"`
 * 
 * ## `"bc7-rgba-unorm-srgb"`
 * 
 * ## `"etc2-rgb8unorm"`
 * 
 * ## `"etc2-rgb8unorm-srgb"`
 * 
 * ## `"etc2-rgb8a1unorm"`
 * 
 * ## `"etc2-rgb8a1unorm-srgb"`
 * 
 * ## `"etc2-rgba8unorm"`
 * 
 * ## `"etc2-rgba8unorm-srgb"`
 * 
 * ## `"eac-r11unorm"`
 * 
 * ## `"eac-r11snorm"`
 * 
 * ## `"eac-rg11unorm"`
 * 
 * ## `"eac-rg11snorm"`
 * 
 * ## `"astc4x4-unorm"`
 * 
 * ## `"astc4x4-unorm-srgb"`
 * 
 * ## `"astc5x4-unorm"`
 * 
 * ## `"astc5x4-unorm-srgb"`
 * 
 * ## `"astc5x5-unorm"`
 * 
 * ## `"astc5x5-unorm-srgb"`
 * 
 * ## `"astc6x5-unorm"`
 * 
 * ## `"astc6x5-unorm-srgb"`
 * 
 * ## `"astc6x6-unorm"`
 * 
 * ## `"astc6x6-unorm-srgb"`
 * 
 * ## `"astc8x5-unorm"`
 * 
 * ## `"astc8x5-unorm-srgb"`
 * 
 * ## `"astc8x6-unorm"`
 * 
 * ## `"astc8x6-unorm-srgb"`
 * 
 * ## `"astc8x8-unorm"`
 * 
 * ## `"astc8x8-unorm-srgb"`
 * 
 * ## `"astc10x5-unorm"`
 * 
 * ## `"astc10x5-unorm-srgb"`
 * 
 * ## `"astc10x6-unorm"`
 * 
 * ## `"astc10x6-unorm-srgb"`
 * 
 * ## `"astc10x8-unorm"`
 * 
 * ## `"astc10x8-unorm-srgb"`
 * 
 * ## `"astc10x10-unorm"`
 * 
 * ## `"astc10x10-unorm-srgb"`
 * 
 * ## `"astc12x10-unorm"`
 * 
 * ## `"astc12x10-unorm-srgb"`
 * 
 * ## `"astc12x12-unorm"`
 * 
 * ## `"astc12x12-unorm-srgb"`
 */
export type GpuTextureFormat = 'r8unorm' | 'r8snorm' | 'r8uint' | 'r8sint' | 'r16unorm' | 'r16snorm' | 'r16uint' | 'r16sint' | 'r16float' | 'rg8unorm' | 'rg8snorm' | 'rg8uint' | 'rg8sint' | 'r32uint' | 'r32sint' | 'r32float' | 'rg16unorm' | 'rg16snorm' | 'rg16uint' | 'rg16sint' | 'rg16float' | 'rgba8unorm' | 'rgba8unorm-srgb' | 'rgba8snorm' | 'rgba8uint' | 'rgba8sint' | 'bgra8unorm' | 'bgra8unorm-srgb' | 'rgb9e5ufloat' | 'rgb10a2uint' | 'rgb10a2unorm' | 'rg11b10ufloat' | 'rg32uint' | 'rg32sint' | 'rg32float' | 'rgba16unorm' | 'rgba16snorm' | 'rgba16uint' | 'rgba16sint' | 'rgba16float' | 'rgba32uint' | 'rgba32sint' | 'rgba32float' | 'stencil8' | 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8' | 'bc1-rgba-unorm' | 'bc1-rgba-unorm-srgb' | 'bc2-rgba-unorm' | 'bc2-rgba-unorm-srgb' | 'bc3-rgba-unorm' | 'bc3-rgba-unorm-srgb' | 'bc4-r-unorm' | 'bc4-r-snorm' | 'bc5-rg-unorm' | 'bc5-rg-snorm' | 'bc6h-rgb-ufloat' | 'bc6h-rgb-float' | 'bc7-rgba-unorm' | 'bc7-rgba-unorm-srgb' | 'etc2-rgb8unorm' | 'etc2-rgb8unorm-srgb' | 'etc2-rgb8a1unorm' | 'etc2-rgb8a1unorm-srgb' | 'etc2-rgba8unorm' | 'etc2-rgba8unorm-srgb' | 'eac-r11unorm' | 'eac-r11snorm' | 'eac-rg11unorm' | 'eac-rg11snorm' | 'astc4x4-unorm' | 'astc4x4-unorm-srgb' | 'astc5x4-unorm' | 'astc5x4-unorm-srgb' | 'astc5x5-unorm' | 'astc5x5-unorm-srgb' | 'astc6x5-unorm' | 'astc6x5-unorm-srgb' | 'astc6x6-unorm' | 'astc6x6-unorm-srgb' | 'astc8x5-unorm' | 'astc8x5-unorm-srgb' | 'astc8x6-unorm' | 'astc8x6-unorm-srgb' | 'astc8x8-unorm' | 'astc8x8-unorm-srgb' | 'astc10x5-unorm' | 'astc10x5-unorm-srgb' | 'astc10x6-unorm' | 'astc10x6-unorm-srgb' | 'astc10x8-unorm' | 'astc10x8-unorm-srgb' | 'astc10x10-unorm' | 'astc10x10-unorm-srgb' | 'astc12x10-unorm' | 'astc12x10-unorm-srgb' | 'astc12x12-unorm' | 'astc12x12-unorm-srgb';
/**
 * # Variants
 * 
 * ## `"core-features-and-limits"`
 * 
 * ## `"depth-clip-control"`
 * 
 * ## `"depth32float-stencil8"`
 * 
 * ## `"texture-compression-bc"`
 * 
 * ## `"texture-compression-bc-sliced3d"`
 * 
 * ## `"texture-compression-etc2"`
 * 
 * ## `"texture-compression-astc"`
 * 
 * ## `"texture-compression-astc-sliced3d"`
 * 
 * ## `"timestamp-query"`
 * 
 * ## `"indirect-first-instance"`
 * 
 * ## `"shader-f16"`
 * 
 * ## `"rg11b10ufloat-renderable"`
 * 
 * ## `"bgra8unorm-storage"`
 * 
 * ## `"float32-filterable"`
 * 
 * ## `"float32-blendable"`
 * 
 * ## `"clip-distances"`
 * 
 * ## `"dual-source-blending"`
 * 
 * ## `"subgroups"`
 * 
 * ## `"texture-formats-tier1"`
 * 
 * ## `"texture-formats-tier2"`
 * 
 * ## `"primitive-index"`
 * 
 * ## `"texture-component-swizzle"`
 */
export type GpuFeatureName = 'core-features-and-limits' | 'depth-clip-control' | 'depth32float-stencil8' | 'texture-compression-bc' | 'texture-compression-bc-sliced3d' | 'texture-compression-etc2' | 'texture-compression-astc' | 'texture-compression-astc-sliced3d' | 'timestamp-query' | 'indirect-first-instance' | 'shader-f16' | 'rg11b10ufloat-renderable' | 'bgra8unorm-storage' | 'float32-filterable' | 'float32-blendable' | 'clip-distances' | 'dual-source-blending' | 'subgroups' | 'texture-formats-tier1' | 'texture-formats-tier2' | 'primitive-index' | 'texture-component-swizzle';
export interface GpuQueueDescriptor {
  label?: string,
}
export interface GpuDeviceDescriptor {
  requiredFeatures?: Array<GpuFeatureName>,
  requiredLimits?: RecordOptionGpuSize64,
  defaultQueue?: GpuQueueDescriptor,
  label?: string,
}
export type RequestDeviceErrorKind = RequestDeviceErrorKindTypeError | RequestDeviceErrorKindOperationError;
export interface RequestDeviceErrorKindTypeError {
  tag: 'type-error',
}
export interface RequestDeviceErrorKindOperationError {
  tag: 'operation-error',
}
export interface RequestDeviceError {
  kind: RequestDeviceErrorKind,
  message: string,
}
export type UnmapErrorKind = UnmapErrorKindAbortError;
export interface UnmapErrorKindAbortError {
  tag: 'abort-error',
}
export interface UnmapError {
  kind: UnmapErrorKind,
  message: string,
}
export type GpuSize64 = bigint;
export type GetMappedRangeErrorKind = GetMappedRangeErrorKindOperationError | GetMappedRangeErrorKindRangeError | GetMappedRangeErrorKindTypeError;
export interface GetMappedRangeErrorKindOperationError {
  tag: 'operation-error',
}
export interface GetMappedRangeErrorKindRangeError {
  tag: 'range-error',
}
export interface GetMappedRangeErrorKindTypeError {
  tag: 'type-error',
}
export interface GetMappedRangeError {
  kind: GetMappedRangeErrorKind,
  message: string,
}
export type GpuIntegerCoordinate = number;
export interface GpuColor {
  r: number,
  g: number,
  b: number,
  a: number,
}
/**
 * # Variants
 * 
 * ## `"load"`
 * 
 * ## `"clear"`
 */
export type GpuLoadOp = 'load' | 'clear';
/**
 * # Variants
 * 
 * ## `"store"`
 * 
 * ## `"discard"`
 */
export type GpuStoreOp = 'store' | 'discard';
export interface GpuRenderPassColorAttachment {
  view: GpuTextureView,
  depthSlice?: GpuIntegerCoordinate,
  resolveTarget?: GpuTextureView,
  clearValue?: GpuColor,
  loadOp: GpuLoadOp,
  storeOp: GpuStoreOp,
}
export type GpuStencilValue = number;
export interface GpuRenderPassDepthStencilAttachment {
  view: GpuTextureView,
  depthClearValue?: number,
  depthLoadOp?: GpuLoadOp,
  depthStoreOp?: GpuStoreOp,
  depthReadOnly?: boolean,
  stencilClearValue?: GpuStencilValue,
  stencilLoadOp?: GpuLoadOp,
  stencilStoreOp?: GpuStoreOp,
  stencilReadOnly?: boolean,
}
export type GpuSize32 = number;
export interface GpuRenderPassTimestampWrites {
  querySet: GpuQuerySet,
  beginningOfPassWriteIndex?: GpuSize32,
  endOfPassWriteIndex?: GpuSize32,
}
export interface GpuRenderPassDescriptor {
  colorAttachments: Array<GpuRenderPassColorAttachment | undefined>,
  depthStencilAttachment?: GpuRenderPassDepthStencilAttachment,
  occlusionQuerySet?: GpuQuerySet,
  timestampWrites?: GpuRenderPassTimestampWrites,
  maxDrawCount?: GpuSize64,
  label?: string,
}
export interface GpuCommandBufferDescriptor {
  label?: string,
}
export interface GpuBufferUsage {
  mapRead?: boolean,
  mapWrite?: boolean,
  copySrc?: boolean,
  copyDst?: boolean,
  index?: boolean,
  vertex?: boolean,
  uniform?: boolean,
  storage?: boolean,
  indirect?: boolean,
  queryResolve?: boolean,
}
export interface GpuBufferDescriptor {
  size: GpuSize64,
  usage: GpuBufferUsage,
  mappedAtCreation?: boolean,
  label?: string,
}
export interface GpuExtent3D {
  width: GpuIntegerCoordinate,
  height?: GpuIntegerCoordinate,
  depthOrArrayLayers?: GpuIntegerCoordinate,
}
/**
 * # Variants
 * 
 * ## `"d1"`
 * 
 * ## `"d2"`
 * 
 * ## `"d3"`
 */
export type GpuTextureDimension = 'd1' | 'd2' | 'd3';
export interface GpuTextureUsage {
  copySrc?: boolean,
  copyDst?: boolean,
  textureBinding?: boolean,
  storageBinding?: boolean,
  renderAttachment?: boolean,
  transientAttachment?: boolean,
}
/**
 * # Variants
 * 
 * ## `"d1"`
 * 
 * ## `"d2"`
 * 
 * ## `"d2-array"`
 * 
 * ## `"cube"`
 * 
 * ## `"cube-array"`
 * 
 * ## `"d3"`
 */
export type GpuTextureViewDimension = 'd1' | 'd2' | 'd2-array' | 'cube' | 'cube-array' | 'd3';
export interface GpuTextureDescriptor {
  size: GpuExtent3D,
  mipLevelCount?: GpuIntegerCoordinate,
  sampleCount?: GpuSize32,
  dimension?: GpuTextureDimension,
  format: GpuTextureFormat,
  usage: GpuTextureUsage,
  viewFormats?: Array<GpuTextureFormat>,
  textureBindingViewDimension?: GpuTextureViewDimension,
  label?: string,
}
export type GpuIndex32 = number;
export interface GpuShaderStage {
  vertex?: boolean,
  fragment?: boolean,
  compute?: boolean,
}
/**
 * # Variants
 * 
 * ## `"uniform"`
 * 
 * ## `"storage"`
 * 
 * ## `"read-only-storage"`
 */
export type GpuBufferBindingType = 'uniform' | 'storage' | 'read-only-storage';
export interface GpuBufferBindingLayout {
  type?: GpuBufferBindingType,
  hasDynamicOffset?: boolean,
  minBindingSize?: GpuSize64,
}
/**
 * # Variants
 * 
 * ## `"filtering"`
 * 
 * ## `"non-filtering"`
 * 
 * ## `"comparison"`
 */
export type GpuSamplerBindingType = 'filtering' | 'non-filtering' | 'comparison';
export interface GpuSamplerBindingLayout {
  type?: GpuSamplerBindingType,
}
/**
 * # Variants
 * 
 * ## `"float"`
 * 
 * ## `"unfilterable-float"`
 * 
 * ## `"depth"`
 * 
 * ## `"sint"`
 * 
 * ## `"uint"`
 */
export type GpuTextureSampleType = 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';
export interface GpuTextureBindingLayout {
  sampleType?: GpuTextureSampleType,
  viewDimension?: GpuTextureViewDimension,
  multisampled?: boolean,
}
/**
 * # Variants
 * 
 * ## `"write-only"`
 * 
 * ## `"read-only"`
 * 
 * ## `"read-write"`
 */
export type GpuStorageTextureAccess = 'write-only' | 'read-only' | 'read-write';
export interface GpuStorageTextureBindingLayout {
  access?: GpuStorageTextureAccess,
  format: GpuTextureFormat,
  viewDimension?: GpuTextureViewDimension,
}
export interface GpuBindGroupLayoutEntry {
  binding: GpuIndex32,
  visibility: GpuShaderStage,
  buffer?: GpuBufferBindingLayout,
  sampler?: GpuSamplerBindingLayout,
  texture?: GpuTextureBindingLayout,
  storageTexture?: GpuStorageTextureBindingLayout,
}
export interface GpuBindGroupLayoutDescriptor {
  entries: Array<GpuBindGroupLayoutEntry>,
  label?: string,
}
export interface GpuPipelineLayoutDescriptor {
  bindGroupLayouts: Array<GpuBindGroupLayout | undefined>,
  immediateSize?: GpuSize32,
  label?: string,
}
export interface GpuBufferBinding {
  buffer: GpuBuffer,
  offset?: GpuSize64,
  size?: GpuSize64,
}
export type GpuBindingResource = GpuBindingResourceGpuBuffer | GpuBindingResourceGpuBufferBinding | GpuBindingResourceGpuSampler | GpuBindingResourceGpuTexture | GpuBindingResourceGpuTextureView;
export interface GpuBindingResourceGpuBuffer {
  tag: 'gpu-buffer',
  val: GpuBuffer,
}
export interface GpuBindingResourceGpuBufferBinding {
  tag: 'gpu-buffer-binding',
  val: GpuBufferBinding,
}
export interface GpuBindingResourceGpuSampler {
  tag: 'gpu-sampler',
  val: GpuSampler,
}
export interface GpuBindingResourceGpuTexture {
  tag: 'gpu-texture',
  val: GpuTexture,
}
export interface GpuBindingResourceGpuTextureView {
  tag: 'gpu-texture-view',
  val: GpuTextureView,
}
export interface GpuBindGroupEntry {
  binding: GpuIndex32,
  resource: GpuBindingResource,
}
export interface GpuBindGroupDescriptor {
  layout: GpuBindGroupLayout,
  entries: Array<GpuBindGroupEntry>,
  label?: string,
}
export type GpuLayoutMode = GpuLayoutModeSpecific | GpuLayoutModeAuto;
export interface GpuLayoutModeSpecific {
  tag: 'specific',
  val: GpuPipelineLayout,
}
export interface GpuLayoutModeAuto {
  tag: 'auto',
}
export interface GpuShaderModuleCompilationHint {
  entryPoint: string,
  layout?: GpuLayoutMode,
}
export interface GpuShaderModuleDescriptor {
  code: string,
  compilationHints?: Array<GpuShaderModuleCompilationHint>,
  label?: string,
}
/**
 * # Variants
 * 
 * ## `"vertex"`
 * 
 * ## `"instance"`
 */
export type GpuVertexStepMode = 'vertex' | 'instance';
/**
 * # Variants
 * 
 * ## `"uint8"`
 * 
 * ## `"uint8x2"`
 * 
 * ## `"uint8x4"`
 * 
 * ## `"sint8"`
 * 
 * ## `"sint8x2"`
 * 
 * ## `"sint8x4"`
 * 
 * ## `"unorm8"`
 * 
 * ## `"unorm8x2"`
 * 
 * ## `"unorm8x4"`
 * 
 * ## `"snorm8"`
 * 
 * ## `"snorm8x2"`
 * 
 * ## `"snorm8x4"`
 * 
 * ## `"uint16"`
 * 
 * ## `"uint16x2"`
 * 
 * ## `"uint16x4"`
 * 
 * ## `"sint16"`
 * 
 * ## `"sint16x2"`
 * 
 * ## `"sint16x4"`
 * 
 * ## `"unorm16"`
 * 
 * ## `"unorm16x2"`
 * 
 * ## `"unorm16x4"`
 * 
 * ## `"snorm16"`
 * 
 * ## `"snorm16x2"`
 * 
 * ## `"snorm16x4"`
 * 
 * ## `"float16"`
 * 
 * ## `"float16x2"`
 * 
 * ## `"float16x4"`
 * 
 * ## `"float32"`
 * 
 * ## `"float32x2"`
 * 
 * ## `"float32x3"`
 * 
 * ## `"float32x4"`
 * 
 * ## `"uint32"`
 * 
 * ## `"uint32x2"`
 * 
 * ## `"uint32x3"`
 * 
 * ## `"uint32x4"`
 * 
 * ## `"sint32"`
 * 
 * ## `"sint32x2"`
 * 
 * ## `"sint32x3"`
 * 
 * ## `"sint32x4"`
 * 
 * ## `"unorm1010102"`
 * 
 * ## `"unorm8x4-bgra"`
 */
export type GpuVertexFormat = 'uint8' | 'uint8x2' | 'uint8x4' | 'sint8' | 'sint8x2' | 'sint8x4' | 'unorm8' | 'unorm8x2' | 'unorm8x4' | 'snorm8' | 'snorm8x2' | 'snorm8x4' | 'uint16' | 'uint16x2' | 'uint16x4' | 'sint16' | 'sint16x2' | 'sint16x4' | 'unorm16' | 'unorm16x2' | 'unorm16x4' | 'snorm16' | 'snorm16x2' | 'snorm16x4' | 'float16' | 'float16x2' | 'float16x4' | 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4' | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4' | 'unorm1010102' | 'unorm8x4-bgra';
export interface GpuVertexAttribute {
  format: GpuVertexFormat,
  offset: GpuSize64,
  shaderLocation: GpuIndex32,
}
export interface GpuVertexBufferLayout {
  arrayStride: GpuSize64,
  stepMode?: GpuVertexStepMode,
  attributes: Array<GpuVertexAttribute>,
}
export interface GpuVertexState {
  buffers?: Array<GpuVertexBufferLayout | undefined>,
  module: GpuShaderModule,
  entryPoint?: string,
  constants?: RecordGpuPipelineConstantValue,
}
/**
 * # Variants
 * 
 * ## `"point-list"`
 * 
 * ## `"line-list"`
 * 
 * ## `"line-strip"`
 * 
 * ## `"triangle-list"`
 * 
 * ## `"triangle-strip"`
 */
export type GpuPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
/**
 * # Variants
 * 
 * ## `"uint16"`
 * 
 * ## `"uint32"`
 */
export type GpuIndexFormat = 'uint16' | 'uint32';
/**
 * # Variants
 * 
 * ## `"ccw"`
 * 
 * ## `"cw"`
 */
export type GpuFrontFace = 'ccw' | 'cw';
/**
 * # Variants
 * 
 * ## `"none"`
 * 
 * ## `"front"`
 * 
 * ## `"back"`
 */
export type GpuCullMode = 'none' | 'front' | 'back';
export interface GpuPrimitiveState {
  topology?: GpuPrimitiveTopology,
  stripIndexFormat?: GpuIndexFormat,
  frontFace?: GpuFrontFace,
  cullMode?: GpuCullMode,
  unclippedDepth?: boolean,
}
/**
 * # Variants
 * 
 * ## `"never"`
 * 
 * ## `"less"`
 * 
 * ## `"equal"`
 * 
 * ## `"less-equal"`
 * 
 * ## `"greater"`
 * 
 * ## `"not-equal"`
 * 
 * ## `"greater-equal"`
 * 
 * ## `"always"`
 */
export type GpuCompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
/**
 * # Variants
 * 
 * ## `"keep"`
 * 
 * ## `"zero"`
 * 
 * ## `"replace"`
 * 
 * ## `"invert"`
 * 
 * ## `"increment-clamp"`
 * 
 * ## `"decrement-clamp"`
 * 
 * ## `"increment-wrap"`
 * 
 * ## `"decrement-wrap"`
 */
export type GpuStencilOperation = 'keep' | 'zero' | 'replace' | 'invert' | 'increment-clamp' | 'decrement-clamp' | 'increment-wrap' | 'decrement-wrap';
export interface GpuStencilFaceState {
  compare?: GpuCompareFunction,
  failOp?: GpuStencilOperation,
  depthFailOp?: GpuStencilOperation,
  passOp?: GpuStencilOperation,
}
export type GpuDepthBias = number;
export interface GpuDepthStencilState {
  format: GpuTextureFormat,
  depthWriteEnabled?: boolean,
  depthCompare?: GpuCompareFunction,
  stencilFront?: GpuStencilFaceState,
  stencilBack?: GpuStencilFaceState,
  stencilReadMask?: GpuStencilValue,
  stencilWriteMask?: GpuStencilValue,
  depthBias?: GpuDepthBias,
  depthBiasSlopeScale?: number,
  depthBiasClamp?: number,
}
export type GpuSampleMask = number;
export interface GpuMultisampleState {
  count?: GpuSize32,
  mask?: GpuSampleMask,
  alphaToCoverageEnabled?: boolean,
}
/**
 * # Variants
 * 
 * ## `"add"`
 * 
 * ## `"subtract"`
 * 
 * ## `"reverse-subtract"`
 * 
 * ## `"min"`
 * 
 * ## `"max"`
 */
export type GpuBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
/**
 * # Variants
 * 
 * ## `"zero"`
 * 
 * ## `"one"`
 * 
 * ## `"src"`
 * 
 * ## `"one-minus-src"`
 * 
 * ## `"src-alpha"`
 * 
 * ## `"one-minus-src-alpha"`
 * 
 * ## `"dst"`
 * 
 * ## `"one-minus-dst"`
 * 
 * ## `"dst-alpha"`
 * 
 * ## `"one-minus-dst-alpha"`
 * 
 * ## `"src-alpha-saturated"`
 * 
 * ## `"constant"`
 * 
 * ## `"one-minus-constant"`
 * 
 * ## `"src1"`
 * 
 * ## `"one-minus-src1"`
 * 
 * ## `"src1-alpha"`
 * 
 * ## `"one-minus-src1-alpha"`
 */
export type GpuBlendFactor = 'zero' | 'one' | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha' | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated' | 'constant' | 'one-minus-constant' | 'src1' | 'one-minus-src1' | 'src1-alpha' | 'one-minus-src1-alpha';
export interface GpuBlendComponent {
  operation?: GpuBlendOperation,
  srcFactor?: GpuBlendFactor,
  dstFactor?: GpuBlendFactor,
}
export interface GpuBlendState {
  color: GpuBlendComponent,
  alpha: GpuBlendComponent,
}
export interface GpuColorWrite {
  red?: boolean,
  green?: boolean,
  blue?: boolean,
  alpha?: boolean,
  all?: boolean,
}
export interface GpuColorTargetState {
  format: GpuTextureFormat,
  blend?: GpuBlendState,
  writeMask?: GpuColorWrite,
}
export interface GpuFragmentState {
  targets: Array<GpuColorTargetState | undefined>,
  module: GpuShaderModule,
  entryPoint?: string,
  constants?: RecordGpuPipelineConstantValue,
}
export interface GpuRenderPipelineDescriptor {
  vertex: GpuVertexState,
  primitive?: GpuPrimitiveState,
  depthStencil?: GpuDepthStencilState,
  multisample?: GpuMultisampleState,
  fragment?: GpuFragmentState,
  layout: GpuLayoutMode,
  label?: string,
}
export interface GpuCommandEncoderDescriptor {
  label?: string,
}
export type WriteBufferErrorKind = WriteBufferErrorKindOperationError;
export interface WriteBufferErrorKindOperationError {
  tag: 'operation-error',
}
export interface WriteBufferError {
  kind: WriteBufferErrorKind,
  message: string,
}
export type GpuBufferDynamicOffset = number;
export type SetBindGroupErrorKind = SetBindGroupErrorKindRangeError;
export interface SetBindGroupErrorKindRangeError {
  tag: 'range-error',
}
export interface SetBindGroupError {
  kind: SetBindGroupErrorKind,
  message: string,
}
export type GpuSignedOffset32 = number;
/**
 * # Variants
 * 
 * ## `"all"`
 * 
 * ## `"stencil-only"`
 * 
 * ## `"depth-only"`
 */
export type GpuTextureAspect = 'all' | 'stencil-only' | 'depth-only';
export interface GpuTextureViewDescriptor {
  format?: GpuTextureFormat,
  dimension?: GpuTextureViewDimension,
  usage?: GpuTextureUsage,
  aspect?: GpuTextureAspect,
  baseMipLevel?: GpuIntegerCoordinate,
  mipLevelCount?: GpuIntegerCoordinate,
  baseArrayLayer?: GpuIntegerCoordinate,
  arrayLayerCount?: GpuIntegerCoordinate,
  swizzle?: string,
  label?: string,
}
/**
 * # Variants
 * 
 * ## `"srgb"`
 * 
 * ## `"display-p3"`
 */
export type PredefinedColorSpace = 'srgb' | 'display-p3';
/**
 * # Variants
 * 
 * ## `"standard"`
 * 
 * ## `"extended"`
 */
export type GpuCanvasToneMappingMode = 'standard' | 'extended';
export interface GpuCanvasToneMapping {
  mode?: GpuCanvasToneMappingMode,
}
/**
 * # Variants
 * 
 * ## `"opaque"`
 * 
 * ## `"premultiplied"`
 */
export type GpuCanvasAlphaMode = 'opaque' | 'premultiplied';

export class Gpu {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  requestAdapter(options: GpuRequestAdapterOptions | undefined): Promise<GpuAdapter | undefined>;
  getPreferredCanvasFormat(): GpuTextureFormat;
}

export class GpuAdapter {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  requestDevice(descriptor: GpuDeviceDescriptor | undefined): Promise<GpuDevice>;
}

export class GpuBindGroup {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuBindGroupLayout {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuBuffer {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  unmap(): void;
  getMappedRangeSetWithCopy(data: Uint8Array, offset: GpuSize64 | undefined, size: GpuSize64 | undefined): void;
}

export class GpuCommandBuffer {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuCommandEncoder {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  beginRenderPass(descriptor: GpuRenderPassDescriptor): GpuRenderPassEncoder;
  finish(descriptor: GpuCommandBufferDescriptor | undefined): GpuCommandBuffer;
}

export class GpuDevice {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  queue(): GpuQueue;
  createBuffer(descriptor: GpuBufferDescriptor): GpuBuffer;
  createTexture(descriptor: GpuTextureDescriptor): GpuTexture;
  createBindGroupLayout(descriptor: GpuBindGroupLayoutDescriptor): GpuBindGroupLayout;
  createPipelineLayout(descriptor: GpuPipelineLayoutDescriptor): GpuPipelineLayout;
  createBindGroup(descriptor: GpuBindGroupDescriptor): GpuBindGroup;
  createShaderModule(descriptor: GpuShaderModuleDescriptor): GpuShaderModule;
  createRenderPipeline(descriptor: GpuRenderPipelineDescriptor): GpuRenderPipeline;
  createCommandEncoder(descriptor: GpuCommandEncoderDescriptor | undefined): GpuCommandEncoder;
}

export class GpuPipelineLayout {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuQuerySet {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuQueue {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  submit(commandBuffers: Array<GpuCommandBuffer>): void;
  writeBufferWithCopy(buffer: GpuBuffer, bufferOffset: GpuSize64, data: Uint8Array, dataOffset: GpuSize64 | undefined, size: GpuSize64 | undefined): void;
}

export class GpuRenderPassEncoder {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  end(): void;
  setBindGroup(index: GpuIndex32, bindGroup: GpuBindGroup | undefined, dynamicOffsetsData: Uint32Array | undefined, dynamicOffsetsDataStart: GpuSize64 | undefined, dynamicOffsetsDataLength: GpuSize32 | undefined): void;
  setPipeline(pipeline: GpuRenderPipeline): void;
  setIndexBuffer(buffer: GpuBuffer, indexFormat: GpuIndexFormat, offset: GpuSize64 | undefined, size: GpuSize64 | undefined): void;
  setVertexBuffer(slot: GpuIndex32, buffer: GpuBuffer | undefined, offset: GpuSize64 | undefined, size: GpuSize64 | undefined): void;
  drawIndexed(indexCount: GpuSize32, instanceCount: GpuSize32 | undefined, firstIndex: GpuSize32 | undefined, baseVertex: GpuSignedOffset32 | undefined, firstInstance: GpuSize32 | undefined): void;
}

export class GpuRenderPipeline {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuSampler {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuShaderModule {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class GpuTexture {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  createView(descriptor: GpuTextureViewDescriptor | undefined): GpuTextureView;
}

export class GpuTextureView {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class RecordGpuPipelineConstantValue {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class RecordOptionGpuSize64 {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}
