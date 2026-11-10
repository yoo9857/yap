/**
 * Power-plant FRAME pieces (뼈대): the structure a plant is built from, bottom to top — foundation,
 * tower segments, nacelle — each an item fitted into its own socket of the blueprint, like the parts.
 * Pure data; the 3D models are Blender GLBs (assets/items/frames) with code-built stand-ins.
 */
export type { FrameKey } from "@robo/shared";
import type { FrameKey } from "@robo/shared";

export interface FrameDef {
  key: FrameKey;
  name: string;
  ko: string;
  icon: string;
  /** What this piece does in the structure (bag detail, fit toast). */
  note: string;
  noteEn: string;
}

const icon = (key: FrameKey) => `/items/frames/${key}.webp`;

export const FRAMES: Readonly<Record<FrameKey, FrameDef>> = {
  "frame-foundation": {
    key: "frame-foundation",
    name: "Foundation pad",
    ko: "기초 블록",
    icon: icon("frame-foundation"),
    note: "땅 위에 넓게 깔아 무게를 고르게 나눠요. 넓을수록 바람에 덜 흔들려요.",
    noteEn: "Spread wide on the ground to share the weight. The wider, the steadier in the wind.",
  },
  "frame-foundation-center": {
    key: "frame-foundation-center",
    name: "Tower anchor",
    ko: "기초 중심",
    icon: icon("frame-foundation-center"),
    note: "탑을 볼트로 붙잡는 중심이에요. 바람이 탑을 밀어도 뽑히지 않게 해요.",
    noteEn: "The bolted ring that holds the tower down when the wind pushes on it.",
  },
  "frame-tower-base": {
    key: "frame-tower-base",
    name: "Tower base",
    ko: "탑 아랫마디",
    icon: icon("frame-tower-base"),
    note: "탑의 맨 아래 마디예요. 점검하는 사람이 들어가는 문이 있어요.",
    noteEn: "The bottom tower section, with a door for the maintenance crew.",
  },
  "frame-tower": {
    key: "frame-tower",
    name: "Tower section",
    ko: "탑 마디",
    icon: icon("frame-tower"),
    note: "높이 올릴수록 바람이 세고 고르게 불어요. 그래서 풍력 발전기는 키가 커요.",
    noteEn: "Higher up the wind is stronger and steadier — that is why turbines are tall.",
  },
  "frame-tower-top": {
    key: "frame-tower-top",
    name: "Tower top",
    ko: "탑 윗마디",
    icon: icon("frame-tower-top"),
    note: "꼭대기의 회전판이 머리(나셀)를 바람 쪽으로 돌려 줘요.",
    noteEn: "Its turntable swings the head (nacelle) round to face the wind.",
  },
  "frame-nacelle-tail": {
    key: "frame-nacelle-tail",
    name: "Nacelle housing",
    ko: "나셀 몸통",
    icon: icon("frame-nacelle-tail"),
    note: "발전기를 비와 바람에서 지켜 주는 머리 덮개예요. 위의 풍향계가 바람 방향을 재요.",
    noteEn: "The head's cover that keeps the generator dry; the vane on top reads the wind.",
  },
  "frame-hub": {
    key: "frame-hub",
    name: "Rotor hub",
    ko: "허브",
    icon: icon("frame-hub"),
    note: "날개가 붙는 앞쪽 뭉치예요. 날개가 돌면 허브와 축이 함께 돌아요.",
    noteEn: "Where the blades bolt on: when they turn, the hub and shaft turn with them.",
  },
};

export const FRAME_KEYS = Object.keys(FRAMES) as FrameKey[];

export function isFrameKey(key: string): key is FrameKey {
  return Object.prototype.hasOwnProperty.call(FRAMES, key);
}

/** The most of one frame piece a bag holds. */
export const FRAME_MAX_STACK = 99;
