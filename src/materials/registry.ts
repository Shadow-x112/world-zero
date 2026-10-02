// Materials: abstract stuff the world is made of, defined only by properties.
//
// No material has a name. Each is a bundle of eight property values; how it
// looks, what it is good for and what the AIs eventually call it all follow
// from those values. The base set below exists in every world. The creator
// panel can add more; those live only in that world's registry (and save).

export const PROPERTIES = [
  "hardness",
  "sharpness",
  "flexibility",
  "mass",
  "energy",
  "nourishment",
  "growth",
  "reactivity",
] as const;
export type Property = (typeof PROPERTIES)[number];
export type Properties = Record<Property, number>;

/** Properties an AI can judge just by looking. */
export const VISIBLE: readonly Property[] = ["mass", "growth", "energy"];
/** Properties revealed by picking something up and handling it. */
export const TACTILE: readonly Property[] = ["hardness", "sharpness", "flexibility", "mass"];
/** Properties revealed only by tasting. */
export const TASTED: readonly Property[] = ["nourishment", "reactivity"];

export type SeasonName = "growth" | "peak" | "decline" | "cold";

export interface MaterialType {
  /** Stable id stored in the world grid (1-255). */
  id: number;
  props: Properties;
  /** Most units one tile can hold. */
  maxAmount: number;
  /** Seasons in which it can be eaten; absent means always (if nourishing at all). */
  ripeIn?: SeasonName[];
  /** True if added by the creator rather than part of the base set. */
  custom?: boolean;
}

/** Energy gained from one unit of a material with nourishment 1. */
export const UNIT_ENERGY = 0.1;

/**
 * The base set. Treat this list as frozen: worlds store these ids in their
 * ground, so existing entries must never change meaning. New materials get
 * new ids.
 */
export const BASE_MATERIALS: readonly MaterialType[] = [
  // 1. Soft, nourishing growth. Common, in patches; regrows quickly in warm seasons.
  { id: 1, maxAmount: 10, props: { hardness: 0.05, sharpness: 0, flexibility: 0.5, mass: 0.1, energy: 0.15, nourishment: 0.7, growth: 0.8, reactivity: 0 } },
  // 2. Flexible fibers. Common; regrows. Binds and ties things together.
  { id: 2, maxAmount: 10, props: { hardness: 0.1, sharpness: 0, flexibility: 0.9, mass: 0.1, energy: 0.2, nourishment: 0.05, growth: 0.6, reactivity: 0 } },
  // 3. Sturdy, burnable growth in groves. Moderately common; regrows slowly.
  { id: 3, maxAmount: 40, props: { hardness: 0.55, sharpness: 0.05, flexibility: 0.3, mass: 0.5, energy: 0.55, nourishment: 0, growth: 0.25, reactivity: 0.05 } },
  // 4. Hard, heavy, stable. Scattered; never regrows.
  { id: 4, maxAmount: 30, props: { hardness: 0.85, sharpness: 0.2, flexibility: 0, mass: 0.85, energy: 0, nourishment: 0, growth: 0, reactivity: 0.02 } },
  // 5. Hard and sharp. Less common; never regrows. Cuts and shapes other materials.
  { id: 5, maxAmount: 15, props: { hardness: 0.8, sharpness: 0.85, flexibility: 0, mass: 0.4, energy: 0, nourishment: 0, growth: 0, reactivity: 0.05 } },
  // 6. Shapeable, heavy earth near water. Hardens when exposed to energy.
  { id: 6, maxAmount: 40, props: { hardness: 0.2, sharpness: 0, flexibility: 0.45, mass: 0.6, energy: 0, nourishment: 0, growth: 0, reactivity: 0.6 } },
  // 7. Rare, glowing, high-energy. Found far out. Harmful to eat.
  { id: 7, maxAmount: 8, props: { hardness: 0.4, sharpness: 0.3, flexibility: 0, mass: 0.3, energy: 0.9, nourishment: 0, growth: 0, reactivity: 0.5 } },
  // 8. Rare, dense and reactive, near ridges. Useful only once energy is understood.
  { id: 8, maxAmount: 20, props: { hardness: 0.6, sharpness: 0.1, flexibility: 0.05, mass: 0.8, energy: 0.1, nourishment: 0, growth: 0, reactivity: 0.85 } },
  // 9. Rich nourishment. Uncommon; ripe only in the warm seasons.
  { id: 9, maxAmount: 6, ripeIn: ["growth", "peak"], props: { hardness: 0.05, sharpness: 0, flexibility: 0.2, mass: 0.1, energy: 0.3, nourishment: 0.95, growth: 0.4, reactivity: 0.05 } },
];

export function regrows(type: MaterialType): boolean {
  return type.props.growth > 0.1;
}

export function isRipe(type: MaterialType, season: string): boolean {
  return !type.ripeIn || (type.ripeIn as string[]).includes(season);
}

/** Health harm from eating one unit (reactive things hurt). */
export function harmPerUnit(type: MaterialType): number {
  const r = type.props.reactivity;
  return r > 0.3 ? (r - 0.3) * 0.08 : 0;
}

/** Plain-language description built from properties, e.g. "a soft, nourishing, growing material". */
export function describe(props: Partial<Properties>): string {
  const words: string[] = [];
  const p = (k: Property) => props[k];
  const h = p("hardness");
  if (h !== undefined) words.push(h > 0.7 ? "hard" : h < 0.15 ? "soft" : "firm");
  if ((p("sharpness") ?? 0) > 0.6) words.push("sharp");
  if ((p("flexibility") ?? 0) > 0.7) words.push("flexible");
  const m = p("mass");
  if (m !== undefined) words.push(m > 0.7 ? "heavy" : m < 0.2 ? "light" : "");
  if ((p("energy") ?? 0) > 0.7) words.push("glowing");
  if ((p("nourishment") ?? 0) > 0.5) words.push("nourishing");
  if ((p("growth") ?? 0) > 0.5) words.push("growing");
  if ((p("reactivity") ?? 0) > 0.5) words.push("volatile");
  const list = words.filter(Boolean);
  return list.length ? `a ${list.join(", ")} material` : "a plain material";
}

export interface RegistryData {
  types: MaterialType[];
}

/** All material types in a world. */
export class MaterialRegistry {
  private readonly types = new Map<number, MaterialType>();

  constructor(types: Iterable<MaterialType> = BASE_MATERIALS) {
    for (const t of types) this.types.set(t.id, structuredClone(t));
  }

  get(id: number): MaterialType | undefined {
    return this.types.get(id);
  }

  require(id: number): MaterialType {
    const t = this.types.get(id);
    if (!t) throw new Error(`Unknown material ${id}`);
    return t;
  }

  all(): MaterialType[] {
    return [...this.types.values()].sort((a, b) => a.id - b.id);
  }

  /** Adds a new material type (for the creator panel). Returns its id. */
  add(props: Properties, maxAmount: number, ripeIn?: SeasonName[]): number {
    let id = 1;
    while (this.types.has(id)) id++;
    if (id > 255) throw new Error("No material ids left");
    const type: MaterialType = { id, props: { ...props }, maxAmount, custom: true };
    if (ripeIn) type.ripeIn = ripeIn;
    this.types.set(id, type);
    return id;
  }

  toJSON(): RegistryData {
    return { types: this.all() };
  }

  static fromJSON(data: RegistryData): MaterialRegistry {
    // Base types always come from code (they are frozen); custom ones from the save.
    const custom = data.types.filter((t) => t.custom);
    return new MaterialRegistry([...BASE_MATERIALS, ...custom]);
  }
}
