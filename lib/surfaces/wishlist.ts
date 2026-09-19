/**
 * Wishlist surface — grouping + export (dev-spec §5 M8; system-design §7D).
 *
 * Every open placeholder is a wishlist item. This module (pure, I/O-free) turns the assembled
 * entries into the two shapes the screen needs:
 *
 *   1. GROUPED — by binder, then by line within it (system-design §7D "grouped by line and by
 *      binder"), each showing required species / stage / colour, the chosen target + alternates,
 *      and where it will live.
 *   2. EXPORTED — a copy-paste list AND a Dex-shaped CSV she can mirror into Dex for in-store
 *      scanning. The CSV is the exact Dex export format (`lib/sync`): semicolon-delimited, the
 *      verified 14-column header, encodable to UTF-16LE+BOM. It ROUND-TRIPS: bytes we emit decode
 *      and parse back through `lib/sync` unchanged (M8 acceptance). Rows carry `Type=standard_v2`
 *      (a Dex wishlist list), so `filterOwned` drops them — a mirrored wishlist can never be
 *      re-imported as OWNED (sync-arch §1.2 scope filter).
 */

import { DEX_CSV_COLUMNS, type DexRow } from "@/lib/sync/types";

/** A catalog printing surfaced as a wishlist target or alternate, trimmed to what export needs. */
export interface WishlistCard {
  tcgdexId: string;
  name: string;
  setName: string | null;
  setSeries: string | null;
  localId: string | null;
  /** Printed set total, for the full "099/182" form (UIL-077). Null when TCGdex reports none. */
  setCardCountOfficial: number | null;
  rarity: string | null;
  illustrator: string | null;
  priceMarket: number | null;
}

/** One open wishlist item, assembled from the DB (line + binder + catalog joins done by the caller). */
export interface WishlistEntry {
  id: string;
  requiredDexId: number | null;
  requiredType: string | null;
  requiredStage: string | null;
  /** DB band key of the gap (line colour). */
  bandKey: string | null;
  bandDisplay: string | null;
  /** Species the gap needs, for the line label + copy-paste text. */
  speciesName: string | null;
  lineId: string | null;
  /** Human line label, e.g. "Charmander line". */
  lineLabel: string | null;
  binderId: string | null;
  binderName: string | null;
  willLiveInSpecialty: boolean;
  /** The cheapest same-colour printing to chase; null when nothing exists (a blocked/orphan slot). */
  chosen: WishlistCard | null;
  alternates: WishlistCard[];
}

/** Wishlist entries for one line, in stage order as assembled. */
export interface WishlistLineGroup {
  lineId: string | null;
  lineLabel: string;
  entries: WishlistEntry[];
}

/** Wishlist entries for one binder, grouped by line within it. */
export interface WishlistBinderGroup {
  binderId: string | null;
  binderName: string;
  lineGroups: WishlistLineGroup[];
  count: number;
}

const UNPLACED = "Not yet placed";
const LOOSE = "Loose placeholders";

/**
 * Group entries by binder (where the card will live), then by line within each binder. Order is the
 * caller's input order, so a stable upstream sort (band then stage) carries through. Binders/lines
 * with no entries are omitted — the grouping only reflects open gaps.
 */
export function groupWishlist(entries: readonly WishlistEntry[]): WishlistBinderGroup[] {
  const binders = new Map<string, WishlistBinderGroup>();
  const binderOrder: string[] = [];

  for (const e of entries) {
    const binderKey = e.binderId ?? "__none";
    let bg = binders.get(binderKey);
    if (!bg) {
      bg = {
        binderId: e.binderId,
        binderName: e.binderName ?? UNPLACED,
        lineGroups: [],
        count: 0,
      };
      binders.set(binderKey, bg);
      binderOrder.push(binderKey);
    }
    const lineKey = e.lineId ?? "__loose";
    let lg = bg.lineGroups.find((g) => (g.lineId ?? "__loose") === lineKey);
    if (!lg) {
      lg = { lineId: e.lineId, lineLabel: e.lineLabel ?? LOOSE, entries: [] };
      bg.lineGroups.push(lg);
    }
    lg.entries.push(e);
    bg.count += 1;
  }

  return binderOrder.map((k) => binders.get(k)!);
}

/** Strip characters that would break the Dex CSV grid: the `;` delimiter and any newline. */
function csvSafe(value: string): string {
  return value.replace(/[;\r\n]+/g, " ").trim();
}

function priceField(p: number | null): string {
  return p === null || p === undefined || Number.isNaN(p) ? "" : p.toFixed(2);
}

/**
 * Turn wishlist entries into Dex CSV rows, one per entry that has a chosen target (a real card to
 * buy). `Type=standard_v2` marks each as a Dex wishlist row — NOT owned — so a re-import filters
 * them out. Every field except Notes is `;`-safe so the round-trip is lossless.
 */
export function wishlistToDexRows(entries: readonly WishlistEntry[]): DexRow[] {
  const rows: DexRow[] = [];
  for (const e of entries) {
    const c = e.chosen;
    if (!c) continue; // nothing exists to chase (blocked/orphan slot) — not a buyable line
    const context = [
      e.lineLabel ?? undefined,
      e.binderName ?? undefined,
      e.willLiveInSpecialty ? "specialty" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    rows.push({
      Type: "standard_v2",
      Category: "Pokemon",
      Locale: "en",
      Series: csvSafe(c.setSeries ?? ""),
      Set: csvSafe(c.setName ?? ""),
      Id: csvSafe(c.tcgdexId),
      Number: csvSafe(c.localId ?? ""),
      Name: csvSafe(c.name),
      Variant: "Normal",
      Rarity: csvSafe(c.rarity ?? ""),
      Illustrator: csvSafe(c.illustrator ?? ""),
      Quantity: "1",
      Price: priceField(c.priceMarket),
      Notes: csvSafe(context ? `Wishlist · ${context}` : "Wishlist"),
    });
  }
  return rows;
}

/** Serialize Dex rows (with the verified header) to semicolon-delimited text. */
export function serializeDexCsv(rows: readonly DexRow[]): string {
  const header = DEX_CSV_COLUMNS.join(";");
  const lines = rows.map((r) => DEX_CSV_COLUMNS.map((col) => r[col] ?? "").join(";"));
  return [header, ...lines].join("\r\n");
}

/**
 * Encode CSV text to the physical Dex export format: UTF-16 little-endian with a BOM. Mirror image
 * of `lib/sync/csv.ts` `decodeDexCsv`, so the byte stream we hand the browser to download is exactly
 * what a Dex CSV parser expects to read.
 */
export function encodeDexCsvUtf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff; // BOM (LE)
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes;
}

/** The full Dex CSV export string for the wishlist (header + rows). */
export function buildWishlistCsv(entries: readonly WishlistEntry[]): string {
  return serializeDexCsv(wishlistToDexRows(entries));
}

/**
 * A human copy-paste list, grouped by binder then line — the quick shopping list she pastes into a
 * note or a chat. Alternates and prices ride along so it is usable at a counter without the app.
 */
export function buildWishlistCopyText(groups: readonly WishlistBinderGroup[]): string {
  const out: string[] = [];
  for (const bg of groups) {
    out.push(`# ${bg.binderName} (${bg.count})`);
    for (const lg of bg.lineGroups) {
      out.push(`  ${lg.lineLabel}`);
      for (const e of lg.entries) {
        const c = e.chosen;
        const stage = e.requiredStage ? ` ${e.requiredStage}` : "";
        const bandTxt = e.bandDisplay ? ` [${e.bandDisplay}]` : "";
        if (c) {
          const price = c.priceMarket != null ? ` $${c.priceMarket.toFixed(2)}` : "";
          const num = c.localId ? ` ${c.localId}` : "";
          const spec = e.willLiveInSpecialty ? " (specialty)" : "";
          out.push(`    - ${c.name}${num} · ${c.setName ?? ""}${price}${bandTxt}${spec}`);
          if (e.alternates.length > 0) {
            const alts = e.alternates
              .map((a) => `${a.name}${a.localId ? ` ${a.localId}` : ""}`)
              .join(", ");
            out.push(`      alts: ${alts}`);
          }
        } else {
          const species = e.speciesName ?? "Unknown";
          out.push(`    - ${species}${stage}${bandTxt} · nothing in catalog yet`);
        }
      }
    }
  }
  return out.join("\n");
}
