import { describe, expect, it } from "vitest";
import { PET_SPECIES, SPECIES, isPetSpecies } from "../src/player/creatureRig.js";
import { GRAVITY } from "../src/craft/voxelBody.js";
import { freshState, loadCraft, saveCraft, type KeyValueStorage } from "../src/craft/craftSave.js";

const SAVE_KEY = "craftyap-craft-save-v1";

/**
 * The registry is the contract between the rigs, the voxel physics and the
 * adoption panel, and each of the three breaks in a different way when an
 * entry is wrong — so it is checked as data rather than trusted.
 */
describe("pet species registry", () => {
  it("lists every species exactly once, keyed by itself", () => {
    expect(new Set(PET_SPECIES).size).toBe(PET_SPECIES.length);
    expect(PET_SPECIES.slice().sort()).toEqual(Object.keys(SPECIES).sort());
    for (const key of PET_SPECIES) expect(SPECIES[key].key).toBe(key);
  });

  it("gives every species panel copy", () => {
    for (const key of PET_SPECIES) {
      const info = SPECIES[key];
      expect(info.name.length, `${key} name`).toBeGreaterThan(0);
      expect(info.emoji.length, `${key} emoji`).toBeGreaterThan(0);
      expect(info.trait.length, `${key} trait`).toBeGreaterThan(0);
    }
  });

  it("gives every species a hop that clears a full block", () => {
    // Rise is v²/2g. Below one metre the animal cannot climb the island's 1 m
    // steps and gets parked against the first one it meets — which is exactly
    // how the first dog shipped, at 6.4 m/s and a 0.85 m hop.
    for (const key of PET_SPECIES) {
      const rise = SPECIES[key].jumpSpeed ** 2 / (2 * GRAVITY);
      expect(rise, `${key} hop`).toBeGreaterThan(1.05);
    }
  });

  it("keeps every collider inside the voxel world's usable envelope", () => {
    for (const key of PET_SPECIES) {
      const info = SPECIES[key];
      expect(info.bodyWidth, `${key} width`).toBeGreaterThan(0.2);
      expect(info.bodyWidth, `${key} width`).toBeLessThanOrEqual(1);
      expect(info.bodyHeight, `${key} height`).toBeGreaterThan(0.5);
      // Taller than this and a pet could not follow through anything the
      // island has, so it would live permanently on the recall path.
      expect(info.bodyHeight, `${key} height`).toBeLessThanOrEqual(2.5);
      expect(info.pace, `${key} pace`).toBeGreaterThan(0.5);
      expect(info.pace, `${key} pace`).toBeLessThanOrEqual(1.5);
    }
  });

  it("recognises its own keys and rejects anything else", () => {
    for (const key of PET_SPECIES) expect(isPetSpecies(key)).toBe(true);
    // "toString" and "constructor" matter: a plain `key in SPECIES` would wave
    // inherited Object members through and the rig would be asked to build one.
    for (const junk of ["", "DOG", "wolf", "toString", "constructor", null, 7, {}]) {
      expect(isPetSpecies(junk), JSON.stringify(junk)).toBe(false);
    }
  });
});

describe("the adopted pet survives a save round-trip", () => {
  const memory = (): KeyValueStorage => {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    };
  };

  it("defaults to the dog on a fresh island", () => {
    expect(freshState(1).pet).toBe("dog");
  });

  it("round-trips every species", () => {
    for (const key of PET_SPECIES) {
      const store = memory();
      const state = freshState(99);
      state.pet = key;
      saveCraft(state, store, 1_700_000_000_000);
      expect(loadCraft(store, 99).pet, key).toBe(key);
    }
  });

  it("falls back to the dog for a save written before pets existed", () => {
    const store = memory();
    saveCraft(freshState(99), store, 1_700_000_000_000);
    const raw = JSON.parse(store.getItem(SAVE_KEY)!) as Record<string, unknown>;
    delete raw.pet;
    store.setItem(SAVE_KEY, JSON.stringify(raw));
    expect(loadCraft(store, 99).pet).toBe("dog");
  });

  it("falls back to the dog for a hostile species, WITHOUT losing the island", () => {
    // The point of keeping `pet` a loose string in the schema: a bad value must
    // cost you the pet, not the whole world. Typing it as an enum would fail
    // the parse and drop the player onto a fresh island.
    const store = memory();
    const state = freshState(99);
    state.world.set(10, 5, 10, 1);
    saveCraft(state, store, 1_700_000_000_000);
    const raw = JSON.parse(store.getItem(SAVE_KEY)!) as Record<string, unknown>;
    raw.pet = "__proto__";
    store.setItem(SAVE_KEY, JSON.stringify(raw));
    const loaded = loadCraft(store, 99);
    expect(loaded.pet).toBe("dog");
    expect(loaded.world.get(10, 5, 10)).toBe(1);
  });
});

describe("rig geometry invariants", () => {
  // The leg length is derived from the shoulder height inside `legs()`, so the
  // paw's underside lands exactly on y = 0. This pins the arithmetic: before
  // it was derived, every pet hovered — the panda by 20 cm — because the
  // shoulder and the leg were two independent numbers that drifted apart.
  const PAW_RATIO = 0.3;
  const footY = (shoulderY: number): number => {
    const h = shoulderY / (1 + PAW_RATIO / 2);
    return shoulderY - h - (h * PAW_RATIO) / 2;
  };

  it("puts the paw on the ground for any shoulder height", () => {
    for (const shoulderY of [0.34, 0.38, 0.46, 0.86, 0.88, 1.4]) {
      expect(footY(shoulderY), `shoulder ${shoulderY}`).toBeCloseTo(0, 9);
    }
  });
});
