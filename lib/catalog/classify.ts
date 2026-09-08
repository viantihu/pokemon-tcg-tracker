/**
 * Derive `cardClass` for a catalog card (docs/dev-spec.md §5 M2; docs/system-design.md §4).
 *
 *   specialty  — ex / V / VMAX / VSTAR / GX / Radiant / Prime / full art / illustration rare / gold
 *   standard   — everything else
 *
 * This is the flag the specialty-binder rule and the ex-only line rule both read (cascade steps 2
 * and the §6 slot table). Two independent signals, OR'd, because neither alone is complete:
 *
 *   1. Rarity — sourced from the live TCGdex /rarities vocabulary (verified 2026-09-07). Catches
 *      cards whose PRINTED NAME has no special token, e.g. Toedscool "Illustration rare"
 *      (sv01-201), Steelix "Secret Rare" (sm12-247).
 *   2. Printed-name token — catches the ex/V/…/Radiant mechanics regardless of the rarity string,
 *      e.g. Charizard ex (sv03-125), Zacian V (swsh1-138), Radiant Charizard (swsh10.5-011).
 *
 * Do NOT infer type/class from the name beyond these tokens (the name carries owner prefixes and
 * forms — sync-architecture §1.3). A famous holo like base1-4 Charizard "Rare" stays `standard`.
 */

export type CardClass = "standard" | "specialty";

/** Rarity strings that denote a non-standard card. Verbatim from the TCGdex English vocabulary. */
export const SPECIALTY_RARITIES: ReadonlySet<string> = new Set([
  "Double rare", // ex
  "Holo Rare V",
  "Holo Rare VMAX",
  "Holo Rare VSTAR",
  "Ultra Rare", // full-art V / VMAX / GX, etc.
  "Illustration rare",
  "Special illustration rare",
  "Hyper rare", // gold
  "Mega Hyper Rare", // gold
  "Crown", // gold / crown
  "Secret Rare", // gold / secret
  "Radiant Rare",
  "Amazing Rare",
  "Rare PRIME", // Prime
  "Rare Holo LV.X", // LV.X
  "LEGEND",
  "ACE SPEC Rare",
  "Full Art Trainer", // full art
  "Shiny rare",
  "Shiny rare V",
  "Shiny rare VMAX",
  "Shiny Ultra Rare",
  "Black White Rare",
  "Classic Collection",
]);

/**
 * True when the printed name carries a specialty mechanic token. Matched case-insensitively:
 *   * "Radiant " prefix           — Radiant Charizard
 *   * trailing " ex" / "-EX" / " GX" / "-GX" — Charizard ex, Mewtwo-GX, M Rayquaza EX
 *   * trailing " V" / " VMAX" / " VSTAR" / " V-UNION" / " Prime"
 */
export function hasSpecialtyNameToken(name: string): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (/^radiant\s/i.test(n)) return true;
  if (/[-\s](ex|gx)$/i.test(n)) return true;
  if (/\s(v|vmax|vstar|v-union|prime)$/i.test(n)) return true;
  return false;
}

export function classifyCard(card: { name: string; rarity?: string | null }): CardClass {
  if (card.rarity && SPECIALTY_RARITIES.has(card.rarity)) return "specialty";
  if (hasSpecialtyNameToken(card.name)) return "specialty";
  return "standard";
}
