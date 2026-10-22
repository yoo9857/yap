import { PET_SPECIES, SPECIES, type PetSpecies } from "../player/creatureRig.js";
import "./petShop.css";

/**
 * The adoption panel: a crayon chip in the top-right corner (under the machine
 * lab's) that opens a card per animal. Clicking a card swaps the companion in
 * place.
 *
 * Pure DOM — it knows the species registry and nothing else, and reports a
 * choice through `onAdopt`. Two behaviours are deliberate:
 *
 * - **Opening releases pointer lock**, like the recipe panel. The cards cannot
 *   be clicked while the mouse is captured for looking around, and a panel you
 *   can see but not touch is worse than no panel.
 * - **The adopted card is drawn pressed-in**, not merely tinted. Everything
 *   here is already warm-toned, so a colour-only state is easy to miss.
 */
export class PetShop {
  private readonly chip: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly cards = new Map<PetSpecies, HTMLButtonElement>();
  private current: PetSpecies;

  constructor(
    parent: HTMLElement,
    initial: PetSpecies,
    private readonly onAdopt: (species: PetSpecies) => void,
  ) {
    this.current = initial;

    this.chip = document.createElement("button");
    this.chip.className = "pet-chip";
    this.chip.type = "button";
    this.chip.dataset.id = "pet-chip";
    this.chip.innerHTML = `<span class="pet-chip-emoji">🐾</span><span data-id="pet-chip-label"></span>`;
    this.chip.addEventListener("click", () => this.toggle());
    parent.appendChild(this.chip);

    this.panel = document.createElement("div");
    this.panel.className = "pet-panel hidden";
    this.panel.dataset.id = "pet-panel";
    this.panel.innerHTML = `
      <div class="pet-panel-head">
        <span class="pet-panel-title">입양하기</span>
        <span class="pet-panel-sub">한 마리만 데려갈 수 있어요</span>
      </div>`;
    for (const key of PET_SPECIES) {
      const info = SPECIES[key];
      const card = document.createElement("button");
      card.className = "pet-card";
      card.type = "button";
      card.dataset.id = `pet-card-${key}`;
      card.dataset.species = key;
      card.innerHTML = `
        <span class="pet-card-emoji">${info.emoji}</span>
        <span class="pet-card-text">
          <span class="pet-card-name">${info.name}</span>
          <span class="pet-card-trait">${info.trait}</span>
        </span>
        <span class="pet-card-badge">함께 있음</span>`;
      card.addEventListener("click", () => this.pick(key));
      this.panel.appendChild(card);
      this.cards.set(key, card);
    }
    parent.appendChild(this.panel);
    this.refresh();
  }

  get open(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.panel.classList.toggle("hidden", !open);
    // Cards are unclickable while the mouse is captured for looking around.
    if (open) document.exitPointerLock();
  }

  /** Reflect a species adopted from somewhere else (a save, a debug hook). */
  setCurrent(species: PetSpecies): void {
    this.current = species;
    this.refresh();
  }

  private pick(species: PetSpecies): void {
    if (species === this.current) return;
    this.current = species;
    this.refresh();
    this.onAdopt(species);
  }

  private refresh(): void {
    for (const [key, card] of this.cards) card.classList.toggle("adopted", key === this.current);
    const label = this.chip.querySelector<HTMLElement>('[data-id="pet-chip-label"]');
    if (label) label.textContent = `입양 · ${SPECIES[this.current].name}`;
  }

  setVisible(visible: boolean): void {
    this.chip.style.display = visible ? "" : "none";
    if (!visible) this.setOpen(false);
  }

  dispose(): void {
    this.chip.remove();
    this.panel.remove();
  }
}
