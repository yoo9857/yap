import * as THREE from "three";
import {FireExtinguisher} from "./fireExtinguisher.js";
import type { FireStationKind } from "@robo/shared";
import { bodyMat, box } from "../../player/blockParts.js";

/**
 * The fire drill's props, built from code like the rest of the cast (blockParts): the alarm box,
 * the wall phone, the extinguisher, exit signs, the waste bin and the gathering flag. Each is built
 * facing +z with its origin at the middle of its cell's floor and its back to the wall at -z; the
 * caller turns it by `rot` quarter turns (the furniture convention) and places it.
 */

const disposables: { dispose(): void }[] = [];
const cyl = new Map<string, THREE.CylinderGeometry>();
function cylinder(r: number, h: number, top = r): THREE.CylinderGeometry {
  const key = `${r},${h},${top}`;
  let g = cyl.get(key);
  if (!g) { g = new THREE.CylinderGeometry(top, r, h, 18); cyl.set(key, g); }
  return g;
}
const SPHERE = new THREE.SphereGeometry(0.5, 16, 12);

function add(p: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  p.add(mesh);
  return mesh;
}

/** Text on a coloured plate (signs above the props): one small canvas per distinct sign. */
const signs = new Map<string, THREE.MeshBasicMaterial>();
function signMaterial(text: string, bg: string, fg: string, w = 256, h = 96): THREE.MeshBasicMaterial {
  const key = `${text}|${bg}|${fg}|${w}x${h}`;
  let m = signs.get(key);
  if (m) return m;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(0, 0, w, h, 18); g.fill();
  g.fillStyle = fg;
  g.textAlign = "center"; g.textBaseline = "middle";
  let size = Math.round(h * 0.52);
  g.font = `900 ${size}px "Pretendard", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif`;
  while (g.measureText(text).width > w * 0.9 && size > 12) { size -= 2; g.font = g.font.replace(/\d+px/, `${size}px`); }
  g.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
  signs.set(key, m);
  disposables.push(tex, m);
  return m;
}
const PLATE = new THREE.PlaneGeometry(1, 1);
function plate(p: THREE.Object3D, text: string, bg: string, fg: string, w: number, h: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(PLATE, signMaterial(text, bg, fg, 256, Math.round((256 * h) / w)));
  mesh.scale.set(w, h, 1);
  mesh.position.set(x, y, z);
  p.add(mesh);
  return mesh;
}

/** A lamp that can be lit (the alarm's): its own material, so one alarm blinking lights no other. */
function lamp(color: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.15 });
  disposables.push(m);
  return m;
}

export interface FireProp {
  root: THREE.Group;
  /** The alarm's lamp (lit and blinking once pressed). */
  lamp?: THREE.MeshStandardMaterial;
}

const RED = 0xd8312b, DARK = 0x2a2c33, WHITE = 0xf4f4f0, GREY = 0x9aa0a8, GREEN = 0x1f9d55;

const extinguishers = new Map<THREE.Group,FireExtinguisher>();
export function extinguisherModel(): THREE.Group {
 const model=new FireExtinguisher();extinguishers.set(model.root,model);return model.root;
}
export function extinguisherInstance(root:THREE.Group):FireExtinguisher|undefined{return extinguishers.get(root);}
export function firePropsReady():Promise<void>{return Promise.all([...extinguishers.values()].map(m=>m.ready)).then(()=>{});}

export function stationProp(kind: FireStationKind): FireProp {
  const root = new THREE.Group();
  switch (kind) {
    case "alarm": {
      add(root, box(0.46, 0.46, 0.1, 0.2), bodyMat(RED), 0, 0.5, -0.44);
      const button = add(root, cylinder(0.1, 0.05), bodyMat(DARK), 0, 0.46, -0.37);
      button.rotation.x = Math.PI / 2;
      const ring = add(root, cylinder(0.13, 0.03), bodyMat(WHITE), 0, 0.46, -0.385);
      ring.rotation.x = Math.PI / 2;
      const light = lamp(0xff3b30);
      const bulb = add(root, SPHERE, light, 0, 0.98, -0.4);
      bulb.scale.set(0.2, 0.2, 0.16);
      const bell = add(root, cylinder(0.11, 0.06), bodyMat(RED), 0, 0.98, -0.45);
      bell.rotation.x = Math.PI / 2;
      plate(root, "화재경보기", "#d8312b", "#ffffff", 0.5, 0.14, 0, 0.19, -0.385);
      return { root, lamp: light };
    }
    case "phone": {
      add(root, box(0.36, 0.52, 0.1, 0.2), bodyMat(WHITE), 0, 0.5, -0.44);
      add(root, box(0.1, 0.44, 0.1, 0.4), bodyMat(DARK), -0.1, 0.5, -0.37); // handset
      for (let i = 0; i < 9; i++) add(root, box(0.04, 0.04, 0.02, 0.3), bodyMat(GREY), 0.03 + (i % 3) * 0.055, 0.5 - Math.floor(i / 3) * 0.06, -0.385);
      plate(root, "119", "#d8312b", "#ffffff", 0.2, 0.1, 0.085, 0.66, -0.385);
      plate(root, "신고 전화", "#ffffff", "#2a2c33", 0.42, 0.13, 0, 0.14, -0.385);
      return { root };
    }
    case "extinguisher": {
      const body = extinguisherModel();
      body.position.set(0, 0.06, -0.3);
      body.name = "extinguisher";
      root.add(body);
      add(root, box(0.44, 0.06, 0.36, 0.3), bodyMat(DARK), 0, 0.03, -0.3); // its stand
      add(root, box(0.045, 1.30, 0.045), bodyMat(GREY), 0, 0.70, -0.485);
      plate(root, "소화기", "#d8312b", "#ffffff", 0.52, 0.2, 0, 1.45, -0.485);
      return { root };
    }
    case "sign":
      exitSign(root, 0, 0.5, -0.44);
      return { root };
    case "towel": {
      // the sink and the rack are furniture; this is the wet towel waiting on the basin's edge
      const towel = add(root, box(0.34, 0.07, 0.24, 0.4), bodyMat(0x7fd0f2), 0, -0.06, -0.08);
      towel.rotation.y = 0.2;
      add(root, box(0.045, 1.34, 0.045), bodyMat(GREY), 0, 0.56, -0.485);
      plate(root, "젖은 수건", "#2f86d8", "#ffffff", 0.56, 0.17, 0, 1.25, -0.485);
      return { root };
    }
  }
}

/** The green running-figure exit sign, lit: centre at (x, y, z), facing +z (`both`: and -z, for
 *  one that hangs in the middle of a corridor). */
export function exitSign(p: THREE.Object3D, x: number, y: number, z: number, both = false, mount?: {kind:"ceiling"|"post";y:number}): void {
  if(mount){
    const edge=mount.kind==="ceiling"?y+.18:y-.18, h=Math.abs(mount.y-edge);
    for(const dx of [-.32,.32])add(p,box(.045,h,.045),bodyMat(GREY),x+dx,(mount.y+edge)/2,z);
    if(mount.kind==="ceiling")add(p,box(.82,.035,.16),bodyMat(GREY),x,mount.y-.0175,z);
  }
  add(p, box(0.92, 0.36, 0.08, 0.2), bodyMat(GREEN), x, y, z).castShadow = false;
  plate(p, "🏃 비상구 EXIT", "#1f9d55", "#ffffff", 0.86, 0.3, x, y, z + 0.045);
  if (both) plate(p, "🏃 비상구 EXIT", "#1f9d55", "#ffffff", 0.86, 0.3, x, y, z - 0.045).rotation.y = Math.PI;
}

/** The waste bin the small fire burns in (origin: the middle of its cell's floor). */
export function binProp(): THREE.Group {
  const g = new THREE.Group();
  add(g, cylinder(0.24, 0.56, 0.3), bodyMat(0x5a6470), 0, 0.28, 0);
  add(g, cylinder(0.3, 0.05, 0.31), bodyMat(DARK), 0, 0.56, 0);
  // crumpled paper, so there is something to burn
  for (const [x, z, c] of [[-0.08, 0.05, WHITE], [0.1, -0.06, 0xe9e2c8], [0.02, 0.1, WHITE]] as const) {
    const paper = add(g, SPHERE, bodyMat(c), x, 0.57, z);
    paper.scale.set(0.16, 0.12, 0.16);
  }
  return g;
}

/** The gathering place's flag (origin: the pad's centre, on the ground). */
export function assemblyFlag(): THREE.Group {
  const g = new THREE.Group();
  add(g, cylinder(0.05, 3.2), bodyMat(WHITE), 0, 1.6, 0);
  add(g, box(1.1, 0.7, 0.05, 0.1), bodyMat(GREEN), 0.58, 2.8, 0);
  for (const side of [1, -1]) {
    const text = plate(g, "모이는 곳", "#1f9d55", "#ffffff", 1.0, 0.36, 0.58, 2.8, 0.03 * side);
    if (side < 0) text.rotation.y = Math.PI;
  }
  add(g, cylinder(0.22, 0.1), bodyMat(GREY), 0, 0.05, 0);
  return g;
}

/** Module-wide canvases and lamp materials (the shared blockParts caches are not ours to free). */
export function disposeFireProps(): void {
  for(const model of extinguishers.values())model.dispose();extinguishers.clear();
  for (const d of disposables.splice(0)) d.dispose();
  signs.clear();
}
