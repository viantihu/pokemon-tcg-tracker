/**
 * The catalog's locale namespace (UIL-047, migration 0016).
 *
 * `catalog_card.tcgdex_id` is the primary key ALONE and the mirror upserts on it, so two TCGdex locales
 * cannot share the id space: a Japanese row is stored as `ja:<id>` with set_id `ja:<set>`, English rows
 * stay exactly as TCGdex returns them. These helpers are the ONLY place that prefix is spelled out —
 * storage (lib/catalog/mirror.ts), the resolver (lib/sync) and display all go through here.
 *
 * Canonical locale spelling for keys is `'en' | 'ja'` (set_alias's form). The Dex export writes
 * "Japanese"/"English" into unresolved_entry.locale; that is display text and is normalised at the
 * boundary by `normalizeLocale`, never migrated.
 */
import type { Locale } from "@/lib/sync/types";

export const LOCALES: readonly Locale[] = ["en", "ja"];

export function isLocale(v: string | null | undefined): v is Locale {
  return v === "en" || v === "ja";
}

/**
 * The Dex export's Locale text, when it is one we recognise; null otherwise (UIL-108).
 *
 * Dex writes "International" for an English-language card and "Japanese" for a Japanese one — on her data
 * those are the only two values (the Senior BA's read, run 36254308302). "English" and the bare codes are
 * accepted too. Anything else is NOT guessed: the stand-in form pre-fills nothing and she picks.
 */
export function knownDexLocale(raw: string | null | undefined): Locale | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "ja" || v === "japanese") return "ja";
  if (v === "en" || v === "english" || v === "international") return "en";
  return null;
}

/** `'ja'` for "ja" or "Japanese" (any case); everything else — including null — is `'en'`. */
export function normalizeLocale(raw: string | null | undefined): Locale {
  return knownDexLocale(raw) ?? "en";
}

/** The stored id for a TCGdex id in `locale`: verbatim for en, `<locale>:<id>` otherwise. */
export function namespaceId(locale: Locale, id: string): string {
  return locale === "en" ? id : `${locale}:${id}`;
}

/**
 * The locale a stored id belongs to, read from its namespace.
 *
 * A stand-in in Japanese (`user:ja:…`, UIL-108) is a Japanese card, so it is scoped with the Japanese
 * printings (UIL-090's rule: an en line and a ja line are different lines). A stand-in in any OTHER
 * language stays English-scoped: the catalog holds no printings in those languages to scope it against,
 * so it lives with the English ones, as every stand-in did before its language was recorded.
 */
export function localeOfId(storedId: string): Locale {
  return storedId.startsWith("ja:") || storedId.startsWith(`${STAND_IN_ID_PREFIX}ja:`)
    ? "ja"
    : "en";
}

/** A stored id with its locale namespace removed — what TCGdex (and she) call it. */
export function stripLocaleNamespace(storedId: string | null | undefined): string {
  if (!storedId) return "";
  return storedId.startsWith("ja:") ? storedId.slice(3) : storedId;
}

/** A short tag for a non-English printing, or null for English. */
export function localeTag(storedId: string | null | undefined): string | null {
  return storedId && localeOfId(storedId) !== "en" ? localeOfId(storedId).toUpperCase() : null;
}

/* --------------------------------- a stand-in's language (UIL-108) --------------------------------- */

/**
 * Every language TCGdex publishes cards in, as it names them in its API path (`/v2/<code>/…`), with the
 * name she reads. Probed 2026-09-26: each of these serves at least one set (en 220 … pl 2). `pt-pt` answers
 * but serves no sets, so it is left out. A stand-in is offered exactly these.
 */
export const TCGDEX_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ja", name: "Japanese" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "es", name: "Spanish" },
  { code: "es-mx", name: "Spanish (Mexico)" },
  { code: "pt", name: "Portuguese" },
  { code: "pt-br", name: "Portuguese (Brazil)" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "ru", name: "Russian" },
  { code: "ko", name: "Korean" },
  { code: "zh-tw", name: "Chinese (Traditional)" },
  { code: "zh-cn", name: "Chinese (Simplified)" },
  { code: "id", name: "Indonesian" },
  { code: "th", name: "Thai" },
] as const;

export type Language = (typeof TCGDEX_LANGUAGES)[number]["code"];

const LANGUAGE_CODES: ReadonlySet<string> = new Set(TCGDEX_LANGUAGES.map((l) => l.code));

export function isLanguage(v: string | null | undefined): v is Language {
  return v != null && LANGUAGE_CODES.has(v);
}

export function languageName(code: Language): string {
  return TCGDEX_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** The id namespace a stand-in lives in; the schema check in 0015 ties it to `source = 'user'`. */
export const STAND_IN_ID_PREFIX = "user:";

export function isStandInId(storedId: string): boolean {
  return storedId.startsWith(STAND_IN_ID_PREFIX);
}

/**
 * A new stand-in's id: `user:<language>:<uuid>`. The language is IN the id, so every screen that already
 * holds a card's id can say what language it is, and 0027 keeps `catalog_card.locale` derived from it, so
 * the column and the id cannot disagree.
 */
export function standInIdFor(language: Language): string {
  return `${STAND_IN_ID_PREFIX}${language}:${crypto.randomUUID()}`;
}

/**
 * The language a stored id says its card is printed in. A mirrored card's is its locale; a stand-in's is
 * the one she recorded; a stand-in made before UIL-108 (`user:<uuid>`) recorded none, so null.
 */
export function languageOfId(storedId: string): Language | null {
  if (!isStandInId(storedId)) return localeOfId(storedId);
  const rest = storedId.slice(STAND_IN_ID_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const code = rest.slice(0, colon);
  return isLanguage(code) ? code : null;
}

/**
 * How a stand-in is labelled wherever it appears — "Stand-in · FR" — so she can tell her own record from a
 * catalog card, and one language's from another's, with no artwork to go on. Null for a catalog card.
 */
export function standInLabel(storedId: string | null | undefined): string | null {
  if (!storedId || !isStandInId(storedId)) return null;
  const language = languageOfId(storedId);
  return language ? `Stand-in · ${language.toUpperCase()}` : "Stand-in";
}

/**
 * The one short tag a card's set line carries: a stand-in's "Stand-in · FR", else a non-English printing's
 * "JA", else nothing. One helper, so a Japanese stand-in is not tagged "JA" twice.
 */
export function cardTag(storedId: string | null | undefined): string | null {
  return standInLabel(storedId) ?? localeTag(storedId);
}
