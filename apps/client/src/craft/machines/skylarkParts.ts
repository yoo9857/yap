/** Names of the actual part roots in the Blender export, in assembly order. */
export const SKYLARK_PARTS = {
  PART_Airframe: ["차체", "Airframe"],
  PART_Canopy: ["조종석", "Cockpit"],
  PART_Powerpack: ["엔진 팩", "Power pack"],
  PART_Mast: ["로터 마스트", "Rotor mast"],
  PART_MainRotor: ["메인 로터", "Main rotor"],
  PART_TailBoom: ["꼬리 붐", "Tail boom"],
  PART_TailRotor: ["꼬리 로터", "Tail rotor"],
  PART_Skid_L: ["왼쪽 스키드", "Left skid"],
  PART_Skid_R: ["오른쪽 스키드", "Right skid"],
  PART_Searchlight: ["탐조등", "Searchlight"],
} as const;

export type SkylarkPart = keyof typeof SKYLARK_PARTS;
export const SKYLARK_PART_ORDER = Object.keys(SKYLARK_PARTS) as SkylarkPart[];

export interface SkylarkConnection {
  host: SkylarkPart;
  socket: string;
  profile: string;
}

export interface SkylarkComponent {
  key: SkylarkPart;
  partId: string;
  connection: SkylarkConnection | null;
}

export interface SkylarkInspection {
  components: readonly SkylarkComponent[];
  selected: SkylarkPart | null;
  exploded: boolean;
}
