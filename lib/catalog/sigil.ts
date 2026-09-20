/**
 * A deterministic pixel SIGIL for a card with no artwork (UIL-081; design/prototype.html `sigil()`).
 *
 * Karvi: cards with no art showed bare initials; she wants "a pixelated placeholder image that fits the
 * brand". The prototype already had the answer and it was never ported: a 6×6 grid, mirrored left to
 * right so it reads as a figure rather than noise, about 62% filled, seeded from the card's NAME so two
 * imageless cards never look identical and the same card always looks the same. Original art, no
 * licensed assets. Pure: hash in, cells out — the component only draws.
 *
 * Colour comes from the brand's own band palette (globals.css `--b-*`), picked by the same hash, with a
 * few cells in translucent ink for depth — the prototype's exact recipe.
 */

/** FNV-1a, 32-bit — the prototype's `hash()`. Stable across runs and machines. */
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type SigilShade = "band" | "dark";
export interface SigilCell {
  x: number;
  y: number;
  shade: SigilShade;
}

export const SIGIL_SIZE = 6;

/** The lit cells of the 6×6 grid, mirrored across the vertical axis. Same seed, same cells, always. */
export function sigilCells(seed: string): SigilCell[] {
  let h = fnv1a(seed);
  const out: SigilCell[] = [];
  for (let y = 0; y < SIGIL_SIZE; y++) {
    for (let x = 0; x < SIGIL_SIZE / 2; x++) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0; // LCG step, as the prototype
      const lit = ((h >>> 16) & 7) > 2; // ~62% fill
      if (!lit) continue;
      const shade: SigilShade = ((h >>> 7) & 3) === 0 ? "dark" : "band";
      out.push({ x, y, shade });
      if (SIGIL_SIZE - 1 - x !== x) out.push({ x: SIGIL_SIZE - 1 - x, y, shade });
    }
  }
  return out;
}

/** The brand band swatches a sigil may wear (globals.css). Picked by the seed, so it is stable per card. */
export const SIGIL_PALETTE = [
  "var(--b-red)",
  "var(--b-orange)",
  "var(--b-yellow)",
  "var(--b-olive)",
  "var(--b-green)",
  "var(--b-navy)",
  "var(--b-sky)",
  "var(--b-purple)",
] as const;

export function sigilColor(seed: string): string {
  return SIGIL_PALETTE[fnv1a(`${seed}·colour`) % SIGIL_PALETTE.length];
}

/** The ink the "dark" cells use — translucent so the face's cream shows through, as the prototype. */
export const SIGIL_DARK = "rgba(60, 60, 59, 0.35)";
