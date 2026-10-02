/**
 * A card's FORM, the second half of a line's identity (UIL-133). Karvi, 2026-10-01: "The evolution line can only
 * belong to the trainer/ region", so Arven's Toedscool and Toedscool are two lines, and so is each regional form
 * (Alolan, Galarian, Hisuian, Paldean). 2026-10-02: Dark and Light Pokémon get their own lines too ("Own lines").
 *
 * TCGdex has no field for any of these (a card carries name, dexId, stage and evolveFrom), so the form is read off the
 * NAME, with the same rules the Database Engineer's line-class check reads Testing with
 * (~/pokemon-tcg-backups/line-class-check.py), in the same order:
 *
 *   region   en "Alolan |Galarian |Hisuian |Paldean " (any case)   ja アローラ / ガラル / ヒスイ / パルデア
 *   shade    en "Dark |Light "                                      ja わるい / やさしい
 *   trainer  en "<Name>'s " (straight or curly apostrophe)          ja "<名>の" with no space before it, on ja: ids
 *
 * A Pokémon's own name is katakana, so a hiragana の or わるい never belongs to it.
 *
 * A RECOMMENDATION, never a refusal (UIL-135, Karvi 2026-10-01: "Users should always be able to override all
 * rules"). Everything here ranks and names; nothing here refuses a card.
 *
 * Pure and I/O-free, like the rest of lib/engine.
 */

import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import type { CatalogCard } from "./types";

/**
 * "trainer:<name>" (the en prefix lower-cased, the ja prefix as printed), "region:alolan" | "region:galarian" |
 * "region:hisuian" | "region:paldean", "dark" or "light". Null is a plain Pokémon.
 */
export type CardForm = string | null;

const REGION_EN = /^(alolan|galarian|hisuian|paldean) /i;
const REGION_JA = /^(アローラ|ガラル|ヒスイ|パルデア)/;
const REGION_OF_JA: Record<string, string> = {
  アローラ: "alolan",
  ガラル: "galarian",
  ヒスイ: "hisuian",
  パルデア: "paldean",
};
const SHADE_EN = /^(dark|light) /i;
const SHADE_JA = /^(わるい|やさしい)/;
const SHADE_OF_JA: Record<string, string> = { わるい: "dark", やさしい: "light" };
const TRAINER_EN = /^(.{1,30}?)['’]s /;
// No space before the の: "オーガポン みどりのめん" (Teal Mask Ogerpon) and "ネクロズマ あかつきのつばさ" are forms of
// one Pokémon, not a trainer's (50 such printings in the mirror on 2026-10-02).
const TRAINER_JA = /^([^\s　]{1,12}?)の./;

/** The form a card's own name says, before anything it evolves from is asked. */
export function ownFormOf(name: string, tcgdexId: string): CardForm {
  const regionEn = REGION_EN.exec(name);
  if (regionEn) return `region:${regionEn[1].toLowerCase()}`;
  const regionJa = REGION_JA.exec(name);
  if (regionJa) return `region:${REGION_OF_JA[regionJa[1]]}`;
  const shadeEn = SHADE_EN.exec(name);
  if (shadeEn) return shadeEn[1].toLowerCase();
  const shadeJa = SHADE_JA.exec(name);
  if (shadeJa) return SHADE_OF_JA[shadeJa[1]];
  const trainerEn = TRAINER_EN.exec(name);
  if (trainerEn) return `trainer:${trainerEn[1].toLowerCase()}`;
  if (localeOfId(tcgdexId) === "ja") {
    const trainerJa = TRAINER_JA.exec(name);
    if (trainerJa) return `trainer:${trainerJa[1]}`;
  }
  return null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** A Pokémon: a card with a species. A Trainer or an Energy has none. */
const isPokemon = (c: CatalogCard) => c.dexId.length > 0;

interface FormIndex {
  /** Physical cards by locale and name, for walking `evolveFrom`. */
  byName: Map<string, CatalogCard>;
  /** Each card's form, once worked out. */
  form: Map<string, CardForm>;
  /** Per locale and form: the plain names that form evolves from (see `formFit`). */
  preForms: Map<string, Set<string>>;
  /** The languages `preForms` has been worked out for. */
  preFormsDone: Set<Locale>;
}

const indexes = new WeakMap<CatalogCard[], FormIndex>();

const nameKey = (locale: Locale, name: string) => `${locale}|${norm(name)}`;

function indexOf(catalog: CatalogCard[]): FormIndex {
  let ix = indexes.get(catalog);
  if (ix) return ix;
  const byName = new Map<string, CatalogCard>();
  for (const c of catalog) {
    if (c.isDigitalOnly || !isPokemon(c)) continue;
    const k = nameKey(localeOfId(c.tcgdexId), c.name);
    if (!byName.has(k)) byName.set(k, c);
  }
  ix = { byName, form: new Map(), preForms: new Map(), preFormsDone: new Set() };
  indexes.set(catalog, ix);
  return ix;
}

/**
 * A card's form. Its own name first; a card whose name says none takes the form of what it evolves from, so an
 * unprefixed evolution of a regional form is that form (Perrserker from Galarian Meowth, Obstagoon, Sirfetch'd,
 * Cursola, Mr. Rime, Runerigus, Overqwil, Sneasler, Clodsire). Its own language only, the way a line's chain walks.
 */
export function formOf(card: CatalogCard, catalog: CatalogCard[]): CardForm {
  // A Trainer or an Energy has no line and so no form ("Boss's Orders", "Arven's Sandwich", "Dark Patch").
  if (!isPokemon(card)) return null;
  const ix = indexOf(catalog);
  const hit = ix.form.get(card.tcgdexId);
  if (hit !== undefined) return hit;
  const locale = localeOfId(card.tcgdexId);
  let form: CardForm = null;
  let cur: CatalogCard | undefined = card;
  const seen = new Set<string>();
  while (cur && !seen.has(norm(cur.name))) {
    seen.add(norm(cur.name));
    form = ownFormOf(cur.name, cur.tcgdexId);
    if (form !== null || !cur.evolveFrom) break;
    // The name it evolves from says enough on its own, even where the catalog has no card by that name.
    form = ownFormOf(cur.evolveFrom, cur.tcgdexId);
    if (form !== null) break;
    cur = ix.byName.get(nameKey(locale, cur.evolveFrom));
  }
  ix.form.set(card.tcgdexId, form);
  return form;
}

/**
 * The plain names a form evolves from, in one language: the Pikachu an Alolan Raichu evolves from, the Rowlet and
 * Dartrix under a Hisuian Decidueye, the Drowzee TCGdex gives Sabrina's Hypno (gym2-56). Walked down from every card
 * of the form, through its own form's cards, stopping at another form.
 */
function preFormsOf(locale: Locale, form: string, catalog: CatalogCard[]): ReadonlySet<string> {
  const ix = indexOf(catalog);
  if (!ix.preFormsDone.has(locale)) {
    // Every form of this language in one pass over the catalog.
    for (const c of catalog) {
      if (c.isDigitalOnly || !c.evolveFrom || localeOfId(c.tcgdexId) !== locale) continue;
      const own = formOf(c, catalog);
      if (own === null) continue;
      const key = `${locale}|${own}`;
      const names = ix.preForms.get(key) ?? new Set<string>();
      ix.preForms.set(key, names);
      let from: string | null = c.evolveFrom;
      const seen = new Set<string>();
      while (from && !seen.has(norm(from))) {
        seen.add(norm(from));
        const below = ix.byName.get(nameKey(locale, from));
        const belowForm = below ? formOf(below, catalog) : ownFormOf(from, c.tcgdexId);
        if (belowForm === null) names.add(norm(from));
        else if (belowForm !== own) break;
        from = below?.evolveFrom ?? null;
      }
    }
    ix.preFormsDone.add(locale);
  }
  return ix.preForms.get(`${locale}|${form}`) ?? NONE;
}

const NONE: ReadonlySet<string> = new Set();

/** Whether a card is of a line's form: its own form, or a plain card that form evolves from. */
export type FormFit = "same" | "other";

/**
 * Whether a card belongs to a line of this form (UIL-133). The same form; or a plain card the form evolves from, so a
 * plain Pikachu is at home under an Alolan Raichu and a plain Drowzee under Sabrina's Hypno. Anything else is another
 * line's card: a RECOMMENDATION only (UIL-135), never a refusal.
 */
export function formFit(card: CatalogCard, lineForm: CardForm, catalog: CatalogCard[]): FormFit {
  const form = formOf(card, catalog);
  if (form === lineForm) return "same";
  if (
    form === null &&
    lineForm !== null &&
    preFormsOf(localeOfId(card.tcgdexId), lineForm, catalog).has(norm(card.name))
  ) {
    return "same";
  }
  return "other";
}

/**
 * A line's form, from the cards known at its stages (a card in a slot, or the card she chases there), lowest stage
 * first: the most evolved one that has a form, else plain. A plain card at the bottom of a regional line (a Pikachu
 * under an Alolan Raichu) does not make the line plain.
 */
export function lineFormOf(
  known: readonly (CatalogCard | null | undefined)[],
  catalog: CatalogCard[],
): CardForm {
  for (let i = known.length - 1; i >= 0; i--) {
    const c = known[i];
    const form = c ? formOf(c, catalog) : null;
    if (form !== null) return form;
  }
  return null;
}

/** The name a stage goes by in a line of this form: the shortest of its cards of that form, else the shortest. */
export function nameInForm(
  cards: readonly CatalogCard[],
  form: CardForm,
  catalog: CatalogCard[],
): string {
  const shortest = (list: readonly CatalogCard[]) =>
    list.map((c) => c.name).sort((a, b) => a.length - b.length)[0];
  return (
    shortest(cards.filter((c) => formFit(c, form, catalog) === "same")) ?? shortest(cards) ?? ""
  );
}

/** A form as she reads it: "Arven's", "Team Rocket's", "Alolan", "Dark". Null for plain. */
export function formLabel(form: CardForm): string | null {
  if (form === null) return null;
  if (form === "dark" || form === "light") return form === "dark" ? "Dark" : "Light";
  const [kind, value] = [form.slice(0, form.indexOf(":")), form.slice(form.indexOf(":") + 1)];
  const title = value.replace(
    /(^|[\s.-])(\p{Ll})/gu,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );
  if (kind === "region") return title;
  // A Japanese trainer reads as printed, with its の.
  return /\p{Script=Latin}/u.test(value) ? `${title}'s` : `${value}の`;
}

/**
 * A line's label (UIL-133): its root's name in its form, and the form after it when that name does not say it (a
 * Hisuian Decidueye line starts at a plain Rowlet: "ROWLET LINE · HISUIAN").
 */
export function lineLabel(rootName: string, form: CardForm, tcgdexId: string): string {
  const base = rootName ? `${rootName.toUpperCase()} LINE` : "EVOLUTION LINE";
  const said = rootName ? ownFormOf(rootName, tcgdexId) : null;
  const label = formLabel(form);
  return label && said !== form ? `${base} · ${label.toUpperCase()}` : base;
}
