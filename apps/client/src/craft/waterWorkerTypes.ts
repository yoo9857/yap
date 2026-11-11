export type WaterWorkerRequest = { t: "cancel"; id: number } | {
  t: "build"; id: number; cells: Uint8Array; outside: Uint8Array | null;
  /** Shaped blocks holding water in the chunks being built: flat [cell index, profile mark]*
   *  (shapeProfile / WATER_HELD). Sparse: a second whole-grid copy per build was 1.4 MB of garbage. */
  profile: Int32Array;
  jobs: { id: number; x: number; z: number; minY: number; maxY: number }[];
  /** Finite water: the flowing ids are amounts, drawn that high (fluid.ts drawWaterByAmount). */
  finite: boolean;
};
export interface WaterWorkerResult {
  id: number; minY: number; maxY: number;
  attributes: Record<string, { array: Float32Array; itemSize: number }> | null;
  index: Uint16Array | Uint32Array | null;
  sphere: [number, number, number, number] | null;
}
export type WaterWorkerResponse = { t: "ready"; id: number; results: WaterWorkerResult[]; ms: number } |
  { t: "failed"; id: number; reason: string };
