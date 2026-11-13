import * as THREE from "three";
import type { FireSchool } from "@robo/shared";
import { t } from "../../ui/i18n.js";
import { quizArtReady } from "./quizRules.js";

/**
 * The quiz board in our classroom (someone playing alone): a notice board on the wall the
 * children face when they arrive, beside the door — look at it and press E, and the quiz opens.
 * (On the result card alone the quiz was too hard to find: owner 2026-11-13.)
 *
 * Where it hangs is read off the school (the classroom's door wall, on the blank stretch west of
 * the door), not placed by hand. It is drawn only: nothing collides with it. The face is ONE
 * canvas — the quiz's own colours and pictures (public/ui/quiz) pinned on cork — redrawn when the
 * font and the pictures have arrived.
 */
const W = 3, H = 1.8, DEPTH = 0.08;
/** The board's middle, above the floor. */
const MID = 1.5;
const TEX_W = 1024, TEX_H = 614;
const FONT = '"Jua", "Pretendard", "Noto Sans KR", system-ui, sans-serif';

export interface QuizBoardPlace {
  /** The face's middle (absolute). */
  at: [number, number, number];
  /** What a look ray must cross to aim at it: [minX, minY, minZ, maxX, maxY, maxZ]. */
  box: [number, number, number, number, number, number];
  /** Feet position in front of it, and the yaw that looks at it. */
  stand: [number, number, number];
  yaw: number;
}

/** Where the board hangs: the classroom's door wall (its +z side), on the blank stretch west of the door. */
export function quizBoardPlace(school: FireSchool): QuizBoardPlace {
  const [x0, , , , , wallZ] = school.classroom, floor = school.spawns[0]![1];
  const doorX = school.classroomDoor[0];
  // midway between the room's west wall and the door, never nearer the door than its frame
  const x = Math.min((x0 + doorX) / 2, doorX - 1.2 - W / 2);
  const y = floor + MID;
  return {
    at: [x, y, wallZ - DEPTH],
    box: [x - W / 2, floor + 0.35, wallZ - 0.3, x + W / 2, y + H / 2 + 0.3, wallZ + 0.05], // (down to a small robot's level look: its eyes are under the board)
    stand: [x, floor, wallZ - 1.7],
    yaw: 0, // the view looks along (sin yaw, cos yaw): +z, at the door wall
  };
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The board's face: cork, a title, three pictures pinned up, the stars, and what to press. */
function paint(g: CanvasRenderingContext2D, pictures: (HTMLImageElement | null)[], star: HTMLImageElement | null, touch: boolean): void {
  // cork, with its speckle (drawn from a fixed sequence: the same board every time)
  g.fillStyle = "#dcae72";
  g.fillRect(0, 0, TEX_W, TEX_H);
  let seed = 7;
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rand() < 0.5 ? "rgba(150, 100, 45, 0.16)" : "rgba(255, 232, 190, 0.2)";
    g.beginPath();
    g.arc(rand() * TEX_W, rand() * TEX_H, 1.5 + rand() * 3.5, 0, Math.PI * 2);
    g.fill();
  }
  // the title: a yellow brick plate
  g.fillStyle = "#d99a00";
  rounded(g, 192, 34, 640, 108, 30); g.fill();
  g.fillStyle = "#ffd21c";
  rounded(g, 192, 26, 640, 108, 30); g.fill();
  g.fillStyle = "rgba(255, 255, 255, 0.45)";
  rounded(g, 204, 32, 616, 16, 8); g.fill();
  g.fillStyle = "#2b3f7a";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `66px ${FONT}`;
  g.fillText(t("화재 안전 퀴즈", "Fire safety quiz"), TEX_W / 2, 86);
  // three pictures on paper cards, each a little askew, with a pin
  const cards = [[176, -0.05, "#3d8bf0"], [512, 0.03, "#ff5a6e"], [848, -0.02, "#5cc455"]] as const;
  cards.forEach(([cx, tilt, pin], i) => {
    g.save();
    g.translate(cx, 318);
    g.rotate(tilt);
    g.fillStyle = "rgba(90, 55, 15, 0.28)";
    rounded(g, -126, -118, 252, 252, 22); g.fill();
    g.fillStyle = "#fffaf0";
    rounded(g, -130, -126, 252, 252, 22); g.fill();
    g.fillStyle = "#dcebff";
    rounded(g, -116, -112, 224, 224, 16); g.fill();
    const img = pictures[i];
    if (img) g.drawImage(img, -108, -106, 208, 208);
    g.fillStyle = "rgba(0, 0, 0, 0.2)";
    g.beginPath(); g.arc(-2, -118, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = pin;
    g.beginPath(); g.arc(-4, -122, 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255, 255, 255, 0.6)";
    g.beginPath(); g.arc(-8, -127, 5, 0, Math.PI * 2); g.fill();
    g.restore();
  });
  // what to do: a green button, with five stars beside it
  g.fillStyle = "#379a3c";
  rounded(g, 232, 494, 400, 92, 46); g.fill();
  g.fillStyle = "#5cc455";
  rounded(g, 232, 484, 400, 92, 46); g.fill();
  g.fillStyle = "rgba(255, 255, 255, 0.4)";
  rounded(g, 256, 490, 352, 12, 6); g.fill();
  g.fillStyle = "#fff";
  g.font = `50px ${FONT}`;
  g.fillText(touch ? t("눌러서 퀴즈 풀기", "Tap to play") : t("E  퀴즈 풀기", "E  Play the quiz"), 432, 532);
  for (let i = 0; i < 3; i++) {
    const x = 668 + i * 62;
    if (star) g.drawImage(star, x, 498, 60, 60);
    else { g.fillStyle = "#ffd21c"; g.beginPath(); g.arc(x + 30, 528, 24, 0, Math.PI * 2); g.fill(); }
  }
}

export class QuizBoard {
  readonly root = new THREE.Group();
  readonly place: QuizBoardPlace;
  private readonly texture: THREE.CanvasTexture;
  private readonly owned: { dispose(): void }[] = [];
  private disposed = false;

  constructor(school: FireSchool, touch: boolean) {
    this.place = quizBoardPlace(school);
    const [x, y, z] = this.place.at;
    this.root.position.set(x, y, z);
    this.root.rotation.y = Math.PI; // the face looks into the room (-z)

    const canvas = document.createElement("canvas");
    canvas.width = TEX_W; canvas.height = TEX_H;
    const g = canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const names = ["act-alarm", "pass-aim", "act-low"].filter((n) => quizArtReady(n));
    const pictures: (HTMLImageElement | null)[] = [null, null, null];
    let star: HTMLImageElement | null = null;
    const draw = (): void => {
      if (this.disposed) return;
      paint(g, pictures, star, touch);
      this.texture.needsUpdate = true;
    };
    draw();
    const load = (name: string, into: (img: HTMLImageElement) => void): void => {
      const img = new Image();
      img.onload = () => { into(img); draw(); };
      img.src = `/ui/quiz/${name}.webp`;
    };
    names.forEach((name, i) => load(name, (img) => { pictures[i] = img; }));
    if (quizArtReady("ui-star")) load("ui-star", (img) => { star = img; });
    void document.fonts?.load(`66px "Jua"`).then(draw, () => {});

    const wood = new THREE.MeshLambertMaterial({ color: 0xb9793a });
    const brick = new THREE.MeshLambertMaterial({ color: 0xffd21c });
    const face = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, px: number, py: number, pz: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(px, py, pz);
      mesh.raycast = () => {};
      this.root.add(mesh);
      this.owned.push(geo);
      return mesh;
    };
    // the frame (a slab the face sits on), the face, and a brick with studs along the top
    add(new THREE.BoxGeometry(W, H, DEPTH), wood, 0, 0, 0);
    add(new THREE.PlaneGeometry(W - 0.14, H - 0.14), face, 0, 0, DEPTH / 2 + 0.004);
    add(new THREE.BoxGeometry(W + 0.1, 0.16, DEPTH + 0.08), brick, 0, H / 2 + 0.08, 0.02);
    const stud = new THREE.CylinderGeometry(0.075, 0.075, 0.06, 14);
    this.owned.push(stud);
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(stud, brick);
      mesh.position.set(-W / 2 + 0.3 + (i * (W - 0.6)) / 5, H / 2 + 0.19, 0.02);
      mesh.raycast = () => {};
      this.root.add(mesh);
    }
    this.owned.push(wood, brick, face, this.texture);
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
