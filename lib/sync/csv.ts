import { DEX_CSV_COLUMNS, type DexRow } from "./types";

/**
 * Dex CSV ingestion (docs/sync-architecture.md §1.2 + Appendix).
 *
 * Verified physical format of the export:
 *   - Encoding: UTF-16 little-endian with BOM (FF FE)
 *   - Delimiter: semicolon `;`
 *   - Header: Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes
 * A parser assuming UTF-8 or comma fails immediately. This is fixed, not a guess.
 */

/** Rows we treat as OWNED presence. Everything else (wishlists) is filtered out. */
export const OWNED_TYPE = "collection";

/** Decode raw export bytes (UTF-16LE, BOM-tolerant) to a string. */
export function decodeDexCsv(bytes: Uint8Array): string {
  // TextDecoder strips the BOM for utf-16le automatically.
  return new TextDecoder("utf-16le").decode(bytes);
}

/**
 * Parse decoded Dex CSV text into rows keyed by column name.
 * The last column (Notes) may itself contain semicolons, so any overflow
 * fields beyond the known column count are re-joined into Notes.
 */
export function parseDexCsv(text: string): DexRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = lines[0].split(";");
  const colCount = DEX_CSV_COLUMNS.length;

  const rows: DexRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(";");
    if (fields.length > colCount) {
      // Fold trailing semicolons back into the final (Notes) column.
      const head = fields.slice(0, colCount - 1);
      const notes = fields.slice(colCount - 1).join(";");
      fields.length = 0;
      fields.push(...head, notes);
    }
    const row = {} as DexRow;
    DEX_CSV_COLUMNS.forEach((col, idx) => {
      row[col] = fields[idx] ?? "";
    });
    rows.push(row);
  }

  // Header sanity check keeps a format change from silently corrupting a sync.
  if (header[0] !== "Type") {
    throw new Error(`Unexpected Dex CSV header. Expected first column "Type", got "${header[0]}".`);
  }
  return rows;
}

/**
 * Scope filter — the first step of ingestion (§1.2). The export bundles wishlist
 * lists (`Type=standard_v2`) alongside the owned collection; ingesting them as
 * presence would import wishlist cards as OWNED. This filter is not optional.
 */
export function filterOwned(rows: DexRow[]): DexRow[] {
  return rows.filter((r) => r.Type === OWNED_TYPE);
}
