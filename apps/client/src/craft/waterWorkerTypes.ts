export type WaterWorkerRequest = { t: "cancel"; id: number } | {
  t: "build"; id: number; cells: Uint8Array; outside: Uint8Array | null;
  jobs: { id: number; x: number; z: number; minY: number; maxY: number }[];
};
export interface WaterWorkerResult {
  id: number; minY: number; maxY: number;
  attributes: Record<string, { array: Float32Array; itemSize: number }> | null;
  index: Uint16Array | Uint32Array | null;
  sphere: [number, number, number, number] | null;
}
export type WaterWorkerResponse = { t: "ready"; id: number; results: WaterWorkerResult[]; ms: number } |
  { t: "failed"; id: number; reason: string };
