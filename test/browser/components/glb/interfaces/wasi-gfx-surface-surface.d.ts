/** @module Interface wasi-gfx:surface/surface@0.2.0 **/
export interface CreateDesc {
  height?: number,
  width?: number,
}
export interface FrameEvent {
  nothing: boolean,
}
export interface ResizeEvent {
  height: number,
  width: number,
}

export class Surface {
  constructor(desc: CreateDesc)
  height(): number;
  width(): number;
  onResize(): AsyncIterable<ResizeEvent>;
  onFrame(): AsyncIterable<FrameEvent>;
}
