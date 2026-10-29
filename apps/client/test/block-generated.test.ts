import * as THREE from "three";
import {describe,it,expect,vi,afterEach} from "vitest";
import {BlockMaterialLibrary} from "../src/craft/blockMaterials.js";
import {loadTexture} from "../src/render/textures.js";
vi.mock("../src/render/textures.js",async()=>{
 const {Texture}=await import("three");
 return {loadTexture:vi.fn((url:string)=>{const t=new Texture();t.name=url;return Promise.resolve(t);})};
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe("generated material sample gate",()=>{
 it("keeps generated sample maps out of the default game material library",()=>{
  vi.stubGlobal("document",{});const lib=new BlockMaterialLibrary();const snow=lib.get("snow")[0]!;
  expect(loadTexture).not.toHaveBeenCalled();expect(snow.map).toBeInstanceOf(THREE.DataTexture);lib.dispose();
 });
 it("uses generated turf in the enabled preview while retaining the refined soil surface",async()=>{
  vi.stubGlobal("document",{});const lib=new BlockMaterialLibrary(true),materials=lib.get("grass");
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(loadTexture).toHaveBeenCalledTimes(3);
  expect(materials[0]!.userData.texture_source).toBe("image_gen v3");expect(materials[0]!.map!.flipY).toBe(false);
  for(const m of materials.slice(1)){expect(m.map).toBeInstanceOf(THREE.DataTexture);expect(m.userData.surface_detail).toBe("restrained microdetail v2");expect(m.userData.texture_source).not.toBe("image_gen v3");}
  for(const m of materials){expect(m.normalMap).not.toBeNull();expect(m.roughnessMap).not.toBeNull();}
  lib.dispose();
 });
});

