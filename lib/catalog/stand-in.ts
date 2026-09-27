/**
 * The real card a stand-in stands in for, once TCGdex carries it (UIL-108; the rule UIL-060's "Half 2" swap
 * will use when it is built).
 *
 * Karvi: when TCGdex later adds the real card, the swap must pick the SAME-LANGUAGE printing. Nothing swaps
 * today: a row she matched to a stand-in stays on it (UIL-099 E4; her match wins, UIL-082). This is only the
 * question the swap will ask, pinned now so that recording a stand-in's language is not decoration.
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
  const numbers = new Set(localIdCandidates(key.localId ?? ""));
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
