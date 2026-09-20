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

/** `'ja'` for "ja" or "Japanese" (any case); everything else — including null — is `'en'`. */
export function normalizeLocale(raw: string | null | undefined): Locale {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "ja" || v === "japanese" ? "ja" : "en";
}

/** The stored id for a TCGdex id in `locale`: verbatim for en, `<locale>:<id>` otherwise. */
export function namespaceId(locale: Locale, id: string): string {
  return locale === "en" ? id : `${locale}:${id}`;
}

/** The locale a stored id belongs to, read from its namespace. */
export function localeOfId(storedId: string): Locale {
  return storedId.startsWith("ja:") ? "ja" : "en";
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
