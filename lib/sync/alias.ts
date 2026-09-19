/**
 * Learned set aliases — the pure half of "forget an alias" (UIL-047 C3, second half; the inverse of
 * sync-ui-spec §A.8's side effect). No I/O here; lib/sync/exec.ts `forgetSetAlias` applies the result.
 *
 * A manual match on an UNKNOWN_SET entry teaches `(locale, dexCode) → tcgdexSetId`, and from then on
 * every Dex row from that set resolves through it ("one match drains the set"). Forgetting one is MORE
 * than deleting the row: a WAITING entry from that set currently reads UNKNOWN_CARD — "the set is known,
 * this card is not", the queue's "Needs your match" group. Without the alias the set is not known, so
 * the honest reason is UNKNOWN_SET again ("Waiting on catalog"). This module decides which entries those
 * are and emits the ordered write set, so the alias delete and the re-classifications land in ONE
 * transaction (migration 0014's header says why they must).
 *
 * Only WAITING entries are touched. A RESOLVED entry records a match she made by hand — the alias was
 * its side effect, not its substance — and a DISMISSED one is out of the retry sweep by her choice.
 * Copies are never touched here: the ones later imports resolved through the alias are not recorded as
 * such, and the next import is what finds them (their rows stop resolving; the reconciler lists the
 * copies as removals in the gated preview).
 */
import type { Row, WriteOp } from "@/lib/repo";
import { parseDexId } from "./resolve";
import type { Locale } from "./types";

/** One learned `set_alias` row, in engine shape (same fields `manualMatch` reports learning). */
export interface LearnedAlias {
  locale: string;
  dexCode: string;
  tcgdexSetId: string;
}

type EntryKeyFields = Pick<Row<"unresolved_entry">, "locale" | "dex_id">;

/**
 * The locale an entry resolves under. The Dex export writes `Japanese`/`English`; the resolver stores
 * `ja`/`en`; queue rows carry whichever they were parked with. Same normalisation `manualMatch` and the
 * retry sweep (`entryAsDexRow`) apply, so an alias learned from an entry matches that entry's key here.
 */
export function entryLocale(e: Pick<Row<"unresolved_entry">, "locale">): Locale {
  return e.locale === "ja" || e.locale === "Japanese" ? "ja" : "en";
}

/** The alias-map key resolve.ts looks aliases up by: `${locale}:${dexCode}`. */
export function aliasKey(locale: string, dexCode: string): string {
  return `${locale}:${dexCode}`;
}

/** The alias key an entry's set resolves through — `jpn_` stripped, locale normalised. */
export function entryAliasKey(e: EntryKeyFields): string {
  return aliasKey(entryLocale(e), parseDexId(e.dex_id).rawCode);
}

/**
 * WAITING entries whose set resolves through `alias`. Locale is part of the key on purpose: `en:m6` and
 * `ja:m6` are different aliases (the cross-locale confusion is UIL-047 C3's whole subject), so forgetting
 * one must not touch the other's entries.
 */
export function entriesUnderAlias<
  E extends EntryKeyFields & Pick<Row<"unresolved_entry">, "status">,
>(entries: readonly E[], alias: Pick<LearnedAlias, "locale" | "dexCode">): E[] {
  const key = aliasKey(alias.locale, alias.dexCode);
  return entries.filter((e) => e.status === "WAITING" && entryAliasKey(e) === key);
}

/**
 * The entries a forget re-parks: WAITING, under the alias, and currently UNKNOWN_CARD — i.e. the ones
 * whose "set is known" claim rests on this alias. An entry still reading UNKNOWN_SET (parked before the
 * alias was learned and never retried since) is already telling the truth and is left alone.
 */
export function reparkCandidates<
  E extends EntryKeyFields & Pick<Row<"unresolved_entry">, "status" | "reason">,
>(entries: readonly E[], alias: Pick<LearnedAlias, "locale" | "dexCode">): E[] {
  return entriesUnderAlias(entries, alias).filter((e) => e.reason === "UNKNOWN_CARD");
}

/**
 * The ordered write set for forgetting `alias`: drop the row, then re-park each candidate as
 * UNKNOWN_SET. Only `reason` changes — a re-park is not a retry, so `retry_count`/`last_retry_sync` stay.
 */
export function buildForgetAliasOps(
  alias: Pick<LearnedAlias, "locale" | "dexCode">,
  entries: readonly (EntryKeyFields & Pick<Row<"unresolved_entry">, "id" | "status" | "reason">)[],
): WriteOp[] {
  const ops: WriteOp[] = [
    { op: "delete_set_alias", locale: alias.locale, dex_code: alias.dexCode },
  ];
  for (const e of reparkCandidates(entries, alias)) {
    ops.push({ op: "update_unresolved_entry", id: e.id, patch: { reason: "UNKNOWN_SET" } });
  }
  return ops;
}
