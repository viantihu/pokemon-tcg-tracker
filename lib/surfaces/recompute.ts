/**
 * Recompute stored colour bands after a `type_color_map` edit (dev-spec §5 M8; system-design §4, §10).
 *
 * A `Copy`'s `colorBand` and an `EvolutionLine`'s `colorBand` are DERIVED from the card's energy
 * type via the `TypeColorMap` (decision §1 — the band is stored, not re-derived on read, so a lookup
 * narrows to a page or two). When the map is edited in Settings the stored bands go stale, so this
 * module recomputes them.
 *
 * PURE. Rows in, the exact set of updates out — no DB, no I/O. The Settings server action applies
 * the returned updates via `lib/repo`. This is the piece the M8 acceptance test pins ("editing
 * type_color_map recomputes stored colorBand on affected copies").
 *
 * SCOPE. Only copies that currently carry a band are touched: bulk and specialty copies store a
 * NULL band (no shelf location — system-design §4 BinderSection), so remapping a type must never
 * give them one. Lines are recomputed alongside their copies so a back-half line and its members
 * never disagree on colour (they derive from the same type through the same map).
 */

import { band, type CatalogCard, type TypeColorMap } from "@/lib/engine";

/** A copy considered for recompute. `colorBand` is its stored band (NULL ⇒ bulk/specialty, skipped). */
export interface RecomputeCopy {
  id: string;
  catalogCardId: string;
  colorBand: string | null;
}

/** A line considered for recompute. `representativeCardId` is any member/target card that fixes the
 * line's colour (a line is one colour, so any member resolves it). NULL ⇒ cannot resolve, skipped. */
export interface RecomputeLine {
  id: string;
  colorBand: string;
  representativeCardId: string | null;
}

export interface BandUpdate {
  id: string;
  /** The freshly derived band key. */
  band: string;
  /** The stale band it replaces (kept for the audit line / rollback). */
  previous: string;
}

export interface RecomputeResult {
  copyUpdates: BandUpdate[];
  lineUpdates: BandUpdate[];
}

/**
 * Compute every stored-band update implied by moving from the current map to `newMap`.
 *
 * @param copies         all owned copies (only those with a non-null `colorBand` can change).
 * @param lines          all evolution lines, each with a representative card id.
 * @param catalogById    engine `CatalogCard` by tcgdex id — the band derivation reads its type.
 * @param newMap         the edited type→band map (DB-key space, e.g. `Fire → "orange"`).
 */
export function recomputeBands(
  copies: readonly RecomputeCopy[],
  lines: readonly RecomputeLine[],
  catalogById: ReadonlyMap<string, CatalogCard>,
  newMap: TypeColorMap,
): RecomputeResult {
  const copyUpdates: BandUpdate[] = [];
  for (const c of copies) {
    // Bulk / specialty copies carry no band — never assign them one.
    if (c.colorBand === null) continue;
    const card = catalogById.get(c.catalogCardId);
    if (!card) continue;
    const next = band(card, newMap);
    if (next !== c.colorBand) copyUpdates.push({ id: c.id, band: next, previous: c.colorBand });
  }

  const lineUpdates: BandUpdate[] = [];
  for (const l of lines) {
    if (!l.representativeCardId) continue;
    const card = catalogById.get(l.representativeCardId);
    if (!card) continue;
    const next = band(card, newMap);
    if (next !== l.colorBand) lineUpdates.push({ id: l.id, band: next, previous: l.colorBand });
  }

  return { copyUpdates, lineUpdates };
}
