/**
 * A Backfill line whose cards are in more than one language (the Senior BA's ruling on #400): allowed, since she is
 * transcribing a real binder, but never silent. It reads as the language of its lowest card (UIL-090), the sheet says
 * so in these words, and the server refuses it without her OK.
 *
 * Pure, and free of I/O imports, so the screen and the server read the same sentence.
 */

import { languageName, type Language } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";

/** "This line mixes English and Japanese cards; it will read as Japanese." Null when the line does not mix. */
export function mixedLanguageNote(cardLocales: readonly Locale[], lineLocale: Locale): string | null {
  const distinct = [...new Set(cardLocales)];
  if (distinct.length < 2) return null;
  const names = distinct.map((l) => languageName(l as Language));
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(", ");
  return `This line mixes ${list} cards; it will read as ${languageName(lineLocale as Language)}.`;
}
