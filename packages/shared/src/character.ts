import { z } from "zod";
export const CHARACTER_IDS = ["mascot", "tt"] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];
export const characterIdSchema = z.enum(CHARACTER_IDS);
export const FACE_IDS = ["neutral", "blink", "smile", "happy", "laugh", "wink", "love", "excited", "smug", "curious", "oh", "worried", "sad", "cry", "angry", "hurt", "dizzy", "tired", "sleep", "dead"] as const;
export type FaceId = (typeof FACE_IDS)[number];
export const EMOTE_IDS = ["none", ...FACE_IDS, "talk", "wave", "cheer", "sit", "lie", "stand"] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];
export const emoteIdSchema = z.enum(EMOTE_IDS);
export interface EmoteDef {
    id: EmoteId;
    ko: string;
    en: string;
    icon: string;
    face: FaceId;
    seconds: number;
    clip?: string;
    faceClip?: string;
    posture?: "stand" | "sit" | "lie";
}
export const EMOTES: readonly EmoteDef[] = [
    { id: "wave", ko: "손 흔들기", en: "Wave", icon: "👋", face: "happy", seconds: 2.4, clip: "Wave", faceClip: "smile" },
    { id: "cheer", ko: "신나게", en: "Cheer", icon: "🙌", face: "happy", seconds: 1.6, clip: "Cheer", faceClip: "laugh" },
    { id: "smile", ko: "미소", en: "Smile", icon: "🙂", face: "smile", seconds: 3.2, faceClip: "smile" },
    { id: "laugh", ko: "활짝 웃기", en: "Laugh", icon: "😆", face: "laugh", seconds: 2.4, faceClip: "laugh" },
    {id:"talk",ko:"말하기",en:"Talk",icon:"🗣️",face:"neutral",seconds:3.2,faceClip:"talk"},
    { id: "wink", ko: "윙크", en: "Wink", icon: "😉", face: "wink", seconds: 2.4, faceClip: "wink" },
    { id: "love", ko: "좋아해", en: "Love", icon: "😍", face: "love", seconds: 3.6 },
    { id: "excited", ko: "반짝반짝", en: "Excited", icon: "🤩", face: "excited", seconds: 3.6 },
    { id: "curious", ko: "궁금해", en: "Curious", icon: "🤔", face: "curious", seconds: 3.6 },
    { id: "oh", ko: "깜짝", en: "Surprised", icon: "😮", face: "oh", seconds: 2.4, faceClip: "surprise" },
    { id: "smug", ko: "장난스럽게", en: "Cheeky", icon: "😏", face: "smug", seconds: 3.6 },
    { id: "worried", ko: "걱정돼", en: "Worried", icon: "😟", face: "worried", seconds: 3.6 },
    { id: "sad", ko: "시무룩", en: "Sad", icon: "🙁", face: "sad", seconds: 3.6 },
    { id: "cry", ko: "울먹울먹", en: "Tears", icon: "😢", face: "cry", seconds: 3.6 },
    { id: "angry", ko: "뾰로통", en: "Grumpy", icon: "😠", face: "angry", seconds: 3.6 },
    { id: "hurt", ko: "아야", en: "Ouch", icon: "😣", face: "hurt", seconds: 2.4, faceClip: "hurt" },
    { id: "dizzy", ko: "빙글빙글", en: "Dizzy", icon: "😵‍💫", face: "dizzy", seconds: 3.6 },
    { id: "tired", ko: "졸려", en: "Sleepy", icon: "🥱", face: "tired", seconds: 3.6 },
    { id: "sleep", ko: "스르르", en: "Doze", icon: "😴", face: "sleep", seconds: 4, faceClip: "sleepy" },
    { id: "happy", ko: "방긋", en: "Happy", icon: "😊", face: "happy", seconds: 3.6 },
    { id: "blink", ko: "눈 감기", en: "Close eyes", icon: "😌", face: "blink", seconds: 2 },
    { id: "dead", ko: "기절한 척", en: "Play faint", icon: "😵", face: "dead", seconds: 3.6 },
    { id: "neutral", ko: "기본 표정", en: "Neutral", icon: "😐", face: "neutral", seconds: 1 },
    { id: "sit", ko: "앉기", en: "Sit", icon: "🪑", face: "smile", seconds: 0, posture: "sit" },
    { id: "lie", ko: "눕기", en: "Lie down", icon: "🛏️", face: "sleep", seconds: 0, posture: "lie", faceClip: "sleepy" },
    { id: "stand", ko: "일어나기", en: "Stand up", icon: "🧍", face: "neutral", seconds: 0, posture: "stand" },
];
export const emoteDef = (id: EmoteId): EmoteDef | undefined => EMOTES.find(e => e.id === id);
export const heldItemSchema=z.enum(["pickaxe-basic"]);
export const toolOptionSchema=z.enum(["balanced","light-grip","stone-focus","precise-tip"]);
export type EquippedItemId=z.infer<typeof heldItemSchema>;
export type ToolOptionId=z.infer<typeof toolOptionSchema>;
export interface CharacterPresentation {
    character: CharacterId;
    emote: EmoteId;
    emoteSeq: number;
    action?: CharacterAction;
    actionSeq?: number;
    actionLoop?: boolean;
    swimming?: boolean;
    heldItem?: EquippedItemId | null;
    toolOption?: ToolOptionId;
    toolPhase?: number;
}


export type CharacterPosture = "stand" | "sit" | "lie" | "crawl";
export interface PostureTransition { clip: string; seconds: number; clearance: number }
const postureEdges: Partial<Record<`${CharacterPosture}:${CharacterPosture}`, PostureTransition>> = {
  "stand:sit": {clip:"SitDown",seconds:.65,clearance:1.8}, "sit:stand": {clip:"SitToStand",seconds:.65,clearance:1.8},
  "stand:lie": {clip:"LieDown",seconds:.9,clearance:1.8}, "lie:stand": {clip:"StandUp",seconds:.8,clearance:1.8},
  "stand:crawl": {clip:"CrawlEnter",seconds:.65,clearance:1.8}, "crawl:stand": {clip:"CrawlExit",seconds:.65,clearance:1.8},
  "lie:crawl": {clip:"LieToCrawl",seconds:1.3,clearance:1.55}, "crawl:lie": {clip:"CrawlToLie",seconds:1.2,clearance:1.55},
  "sit:lie": {clip:"SitToLie",seconds:.8,clearance:1.45}, "lie:sit": {clip:"LieToSit",seconds:.8,clearance:1.45},
  "sit:crawl": {clip:"SitToCrawl",seconds:.7,clearance:1.45}, "crawl:sit": {clip:"CrawlToSit",seconds:.7,clearance:1.45},
};
export function postureTransition(from: CharacterPosture, to: CharacterPosture): PostureTransition | undefined { return postureEdges[`${from}:${to}`]; }
export const characterActionSchema = z.enum(["none","interact","place","hit"]);
export type CharacterAction = z.infer<typeof characterActionSchema>;

