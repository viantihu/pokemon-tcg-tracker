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
