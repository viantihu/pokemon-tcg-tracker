/**
 * The real card a stand-in stands in for, once TCGdex carries it (UIL-108; UIL-060 Half 2's swap asks
 * `standInMatch` below, which keeps every rule here and adds the set NAME for a stand-in with no set id).
 *
 * Karvi: when TCGdex later adds the real card, the swap must pick the SAME-LANGUAGE printing.
 *
 * A candidate is a mirrored printing:
 *   - in the stand-in's language — English is the bare id space, Japanese the `ja:` one. A language the
 *     catalog does not mirror (French, German, …) has no candidate until it is mirrored, because no
 *     mirrored row carries that locale;
 *   - in the stand-in's set (a stand-in with no known set has no candidate: the set is the only safe key);
 *   - with the same collector number, normalised the way the importer normalises it (`localIdCandidates`:
 *     "5", "005" and "05" are one number);
 *   - physical (not digital-only), and not itself a stand-in.
 * A stand-in made before UIL-108 recorded no language, so it has no candidate either: guessing one is how
 * a Japanese card would end up swapped for an English printing.
 */

import { isStandInId, languageOfId } from "@/lib/catalog/locale";
import { localIdCandidates } from "@/lib/sync/resolve";

export interface StandInForCandidate {
  tcgdexId: string;
  setId: string | null;
  localId: string | null;
}

export interface MirroredPrinting {
  tcgdexId: string;
  setId: string | null;
  localId: string | null;
  locale: string;
  isDigitalOnly: boolean;
}

export function realPrintingFor(
  standIn: StandInForCandidate,
  catalog: readonly MirroredPrinting[],
): string | null {
  if (!isStandInId(standIn.tcgdexId)) return null;
  const language = languageOfId(standIn.tcgdexId);
  // A language the catalog does not mirror needs no guard of its own: no mirrored row carries it (0027 holds
  // every mirrored row to 'en' or 'ja'), so the locale test below finds nothing. When one is mirrored, its
  // stand-ins start finding candidates with no change here.
  if (!language) return null;
  if (!standIn.setId || !standIn.localId) return null;

  const numbers = new Set(localIdCandidates(standIn.localId));
  const hit = catalog.find(
    (c) =>
      !isStandInId(c.tcgdexId) &&
      !c.isDigitalOnly &&
      c.locale === language &&
      c.setId === standIn.setId &&
      c.localId !== null &&
      localIdCandidates(c.localId).some((n) => numbers.has(n)),
  );
  return hit?.tcgdexId ?? null;
}

/* ------------------------------ the swap: which real card is it, and is it certain? ------------------------------ */

/**
 * The collector number she typed, as the importer's candidates. A card's printed number often carries the set's
 * size ("15/128"); TCGdex stores only the card's own part ("015"), so the part after a "/" is dropped first.
 */
export function collectorNumberCandidates(localId: string): string[] {
  const own = localId.split("/")[0].trim();
  return own ? localIdCandidates(own) : [];
}

/**
 * A set name as compared across her typing and TCGdex's: case, accents, punctuation and spacing do not count, and
 * "&" is "and" ("Sun & Moon" is "sun and moon"). Japanese is kept as written, voiced marks included.
 */
export function setNameKey(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Two set names that are close without being the same: one's words inside the other's, or nearly the same letters. */
function setNamesClose(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const wordsA = a.split(" ");
  const wordsB = new Set(b.split(" "));
  if (wordsA.every((w) => wordsB.has(w)) || [...wordsB].every((w) => wordsA.includes(w)))
    return true;
  return letterPairSimilarity(a.replace(/ /g, ""), b.replace(/ /g, "")) >= 0.75;
}

/** Sørensen–Dice over adjacent letter pairs: 1 for the same string, 0 for nothing in common. */
function letterPairSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const n = pairs.get(p) ?? 0;
    if (n > 0) {
      shared++;
      pairs.set(p, n - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

const cardNameKey = (v: string | null | undefined) => setNameKey(v);

/** A stand-in as the swap reads it: what she typed when she made it. */
export interface StandInForMatch {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  localId: string | null;
}

/** A mirrored catalog row as the swap reads it. */
export interface MatchableCard extends MirroredPrinting {
  name: string;
  setName: string | null;
}

/**
 * What the swap does with a stand-in (UIL-060 Half 2; Karvi 2026-10-22: swap on its own only when certain, else ask).
 *   certain — swap it now, without asking;
 *   unsure  — show her these real cards (at most five) and let her pick, or leave it;
 *   none    — TCGdex does not carry it yet (or it cannot be told): leave it alone.
 */
export type StandInMatch =
  | { kind: "certain"; realId: string }
  | { kind: "unsure"; candidateIds: string[] }
  | { kind: "none" };

const MAX_CANDIDATES = 5;

/**
 * Which real card a stand-in is. Every candidate keeps `realPrintingFor`'s rules — the stand-in's language, a
 * physical mirrored printing, the same collector number — and then the SET decides. She cannot know TCGdex's set
 * id when she makes a stand-in, so most carry only the set name she typed:
 *   - with a set id, the set is that id;
 *   - without one, the set is every set whose name is hers once case, accents and punctuation are ignored.
 * CERTAIN needs exactly one printing in that set with that number, carrying her card name too. Anything less — two
 * printings, another name, or a set name only close to hers ("Celebrations" for "30th Celebration") — is UNSURE,
 * and goes to her with the candidates.
 */
export function standInMatch(
  standIn: StandInForMatch,
  catalog: readonly MatchableCard[],
): StandInMatch {
  const none = { kind: "none" } as const;
  if (!isStandInId(standIn.tcgdexId)) return none;
  const language = languageOfId(standIn.tcgdexId);
  if (!language || !standIn.localId) return none;
  const numbers = new Set(collectorNumberCandidates(standIn.localId));
  if (numbers.size === 0) return none;

  const pool = catalog.filter(
    (c) =>
      !isStandInId(c.tcgdexId) &&
      !c.isDigitalOnly &&
      c.locale === language &&
      c.localId !== null &&
      localIdCandidates(c.localId).some((n) => numbers.has(n)),
  );
  if (pool.length === 0) return none;

  const mySet = setNameKey(standIn.setName);
  const myName = cardNameKey(standIn.name);
  const inSet = standIn.setId
    ? pool.filter((c) => c.setId === standIn.setId)
    : mySet
      ? pool.filter((c) => setNameKey(c.setName) === mySet)
      : [];

  if (inSet.length === 1 && cardNameKey(inSet[0].name) === myName) {
    return { kind: "certain", realId: inSet[0].tcgdexId };
  }

  const close = mySet
    ? pool.filter(
        (c) => cardNameKey(c.name) === myName && setNamesClose(setNameKey(c.setName), mySet),
      )
    : [];
  const candidateIds = [...new Set([...inSet, ...close].map((c) => c.tcgdexId))].slice(
    0,
    MAX_CANDIDATES,
  );
  return candidateIds.length > 0 ? { kind: "unsure", candidateIds } : none;
}

/* ------------------------------ a new stand-in: is it one she already has? ------------------------------ */

/** What she typed for a new stand-in, and the language it is printed in (UIL-108). */
export interface StandInKey {
  name: string;
  setName: string | null;
  localId: string | null;
  language: string;
}

/** A catalog row as the two checks below read it. */
export interface StandInCheckRow {
  tcgdexId: string;
  name: string;
  setName: string | null;
  localId: string | null;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/**
 * The stand-in she already made for this card, if any: same language, name, set name and number. An English and a
 * Japanese stand-in of one card are two cards, as their printings are (UIL-090); a stand-in made before UIL-108
 * recorded no language, so it is nobody's twin. The same key 0027's unique index holds, so Sync's match and the line
 * popup refuse the same twin.
 */
export function standInTwin<T extends StandInCheckRow>(
  standIns: readonly T[],
  key: StandInKey,
): T | undefined {
  return standIns.find(
    (c) =>
      isStandInId(c.tcgdexId) &&
      languageOfId(c.tcgdexId) === key.language &&
      norm(c.name) === norm(key.name) &&
      norm(c.setName) === norm(key.setName) &&
      norm(c.localId) === norm(key.localId),
  );
}

/**
 * A MIRRORED printing of the card she is describing (UIL-121): same language, name, set name, and collector number
 * normalised the way the importer does ("5", "005"). Then the card is in the catalog and she picks it rather than
 * making a stand-in. Nothing checked this before: a stand-in could duplicate a real TCGdex card. A draft with no set
 * or no number has nothing to compare, so it is not refused here.
 */
export function mirrorPrintingLike<T extends StandInCheckRow & { locale: string }>(
  catalog: readonly T[],
  key: StandInKey,
): T | undefined {
  if (!norm(key.setName) || !norm(key.localId)) return undefined;
  const numbers = new Set(collectorNumberCandidates(key.localId ?? ""));
  return catalog.find(
    (c) =>
      !isStandInId(c.tcgdexId) &&
      c.locale === key.language &&
      norm(c.name) === norm(key.name) &&
      norm(c.setName) === norm(key.setName) &&
      c.localId !== null &&
      localIdCandidates(c.localId).some((n) => numbers.has(n)),
  );
}
