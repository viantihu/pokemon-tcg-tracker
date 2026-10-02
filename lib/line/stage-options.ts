/**
 * The printings she can chase for one stage, and the one suggested (UIL-121). Karvi, 2026-09-27: suggest "the cheapest
 * same-colour, same-language printing, else the special one", NOT pre-selected; she can pick any other printing of the
 * species in the LINE's language (Q2), same colour first and the others tagged "different colour".
 *
 * PURE: the caller reads the species' printings and the colour map.
 */

import { languageOfId, localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import { ownFormOf, type CardForm } from "@/lib/engine/form";
import type { StageOption } from "./popup";

/** A printing as this reads it. */
export interface StagePrinting {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  localId: string | null;
  setCardCountOfficial: number | null;
  imageUrl: string | null;
  cardClass: string;
  isDigitalOnly: boolean;
  priceMarket: number | null;
  /** The printing's own colour band key. */
  bandKey: string;
}

const languageOf = (id: string) => languageOfId(id) ?? localeOfId(id);

/**
 * Her options for a stage: the species' physical printings in the line's language. Same colour first, then standard
 * before special, then cheapest first (an unpriced printing last), then by id so the order is stable.
 */
export function stageOptionsFrom(
  printings: readonly StagePrinting[],
  /**
   * The line's form (UIL-133): its own printings first. A stage none of whose printings is of the form (the plain
   * Pikachu under an Alolan Raichu) is the form's own, whatever they are. Absent: nothing is preferred.
   */
  line: { locale: Locale; bandKey: string; form?: CardForm },
): StageOption[] {
  const inLanguage = printings.filter(
    (p) => !p.isDigitalOnly && languageOf(p.tcgdexId) === line.locale,
  );
  const formOfP = (p: StagePrinting) => ownFormOf(p.name, p.tcgdexId);
  const hasForm = line.form !== undefined && inLanguage.some((p) => formOfP(p) === line.form);
  return inLanguage
    .map((p) => ({
      card: {
        tcgdexId: p.tcgdexId,
        name: p.name,
        setId: p.setId,
        setName: p.setName,
        localId: p.localId,
        setCardCountOfficial: p.setCardCountOfficial,
        imageUrl: p.imageUrl,
        bandKey: p.bandKey,
      },
      sameColour: p.bandKey === line.bandKey,
      ...(line.form !== undefined ? { sameForm: !hasForm || formOfP(p) === line.form } : {}),
      special: p.cardClass === "specialty",
      priceMarket: p.priceMarket,
    }))
    .sort(
      (a, b) =>
        Number(b.sameForm !== false) - Number(a.sameForm !== false) ||
        Number(b.sameColour) - Number(a.sameColour) ||
        Number(a.special) - Number(b.special) ||
        (a.priceMarket ?? Infinity) - (b.priceMarket ?? Infinity) ||
        a.card.tcgdexId.localeCompare(b.card.tcgdexId),
    );
}

/**
 * The suggestion: the cheapest same-colour standard printing, else the cheapest same-colour special one, flagged.
 * Null when no printing is in the line's colour: then nothing is suggested, and she can still pick any.
 */
export function stageSuggestion(
  options: readonly StageOption[],
): { card: StageOption["card"]; special: boolean } | null {
  // The line's own form first (UIL-133), then any same-colour printing as before.
  const own = options.filter((o) => o.sameForm !== false);
  const pick =
    own.find((o) => o.sameColour && !o.special) ??
    own.find((o) => o.sameColour) ??
    options.find((o) => o.sameColour && !o.special) ??
    options.find((o) => o.sameColour);
  return pick ? { card: pick.card, special: pick.special } : null;
}
