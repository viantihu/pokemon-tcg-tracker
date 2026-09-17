"use server";

/**
 * Server actions for Settings (dev-spec §5 M8; system-design §4).
 *
 * Binders (pages/pockets/half-split/active), rainbow order, and the type→band map. Editing the map
 * RECOMPUTES the stored `colorBand` on every affected copy (and its line) via the pure
 * `recomputeBands` — the derived band is stored (decision §1), so the map edit must rewrite it. The
 * empty Pink band is never dropped: the band list is read straight from `color_band`, which keeps
 * all ten.
 */

import { getOwnerContext, toCatalogCard } from "@/lib/plan";
import {
  binderRepo,
  catalogCardRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
} from "@/lib/repo";
import {
  binderSplit,
  recomputeBands,
  strandedSections,
  strandedSectionsMessage,
  type RecomputeCopy,
  type RecomputeLine,
} from "@/lib/surfaces";
import { readShelvedBySection } from "@/lib/binders/save";
import type { CatalogCard as EngineCatalogCard } from "@/lib/engine";
import { errorMessage } from "@/lib/errors";
import type { BinderInput, RecomputeCounts, SettingsData, SettingsResult } from "./settings-types";

export async function loadSettings(): Promise<SettingsData> {
  const { db } = await getOwnerContext();
  const [binders, bands, typeMap] = await Promise.all([
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
    typeColorMapRepo.list(db),
  ]);

  return {
    binders: binders
      .map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type === "specialty" ? ("specialty" as const) : ("general" as const),
        pages: b.pages,
        pocketsPerPage: b.pockets_per_page,
        backHalfStartPage: b.back_half_start_page,
        isActive: b.is_active,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    bands: bands.map((b) => ({ band: b.band, displayName: b.display_name, position: b.position })),
    typeMap: typeMap
      .map((t) => ({ cardType: t.card_type, band: t.band }))
      .sort((a, b) => a.cardType.localeCompare(b.cardType)),
  };
}

/**
 * Create or update a binder. Setting one active clears `is_active` on every other binder.
 *
 * UIL-050: editing an EXISTING binder is checked against what is actually shelved there first —
 * shrinking pages, moving the divider forward, or clearing `back_half_start_page` can all leave fewer
 * pockets than cards already shelved, the "shelved is greater than capacity" number she reported.
 * Blocked and named, not silently rebalanced: this app doesn't move her cards without her asking
 * (UIL-061), and a resize can't relocate a physical card regardless. A brand-new binder has nothing
 * shelved in it yet, so nothing to check.
 */
export async function saveBinder(input: BinderInput): Promise<SettingsResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "A binder needs a name." };
  try {
    const { db, ownerId } = await getOwnerContext();

    const patch = {
      name,
      type: input.type,
      pages: Math.max(0, Math.floor(input.pages)),
      pockets_per_page: Math.max(1, Math.floor(input.pocketsPerPage)),
      back_half_start_page:
        input.type === "general" && input.backHalfStartPage
          ? Math.max(1, Math.floor(input.backHalfStartPage))
          : null,
      is_active: input.isActive,
    };

    if (input.id) {
      const shelved = await readShelvedBySection(db, input.id);
      const blocked = strandedSections(binderSplit(input), shelved);
      if (blocked.length > 0) return { ok: false, error: strandedSectionsMessage(blocked) };
    }

    let savedId = input.id ?? null;
    if (input.id) {
      await binderRepo.update(db, input.id, patch);
    } else {
      const created = await binderRepo.insert(db, { owner_id: ownerId, ...patch });
      savedId = created.id;
    }

    // One binder in progress (decision §3): making this one active retires the others.
    if (input.isActive && savedId) {
      const all = await binderRepo.list(db);
      await Promise.all(
        all
          .filter((b) => b.id !== savedId && b.is_active)
          .map((b) => binderRepo.update(db, b.id, { is_active: false })),
      );
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteBinder(id: string): Promise<SettingsResult> {
  try {
    const { db } = await getOwnerContext();
    await binderRepo.remove(db, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Re-assign rainbow positions from an ordered list of band keys. Two-phase (negative temp positions
 * first) so the `position` UNIQUE constraint never trips mid-swap.
 */
export async function reorderBands(orderedKeys: string[]): Promise<SettingsResult> {
  try {
    const { db } = await getOwnerContext();
    for (let i = 0; i < orderedKeys.length; i++) {
      await colorBandRepo.update(db, orderedKeys[i], { position: -(i + 1) });
    }
    for (let i = 0; i < orderedKeys.length; i++) {
      await colorBandRepo.update(db, orderedKeys[i], { position: i + 1 });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Remap an energy type / card class to a band, then recompute the stored `colorBand` on every
 * affected copy and evolution line (M8 acceptance). Bulk/specialty copies (NULL band) are never
 * given one — see `recomputeBands`.
 */
export async function setTypeBand(
  cardType: string,
  band: string,
): Promise<SettingsResult<RecomputeCounts>> {
  try {
    const { db } = await getOwnerContext();

    // 1. Persist the map edit (update existing, else insert the pairing).
    const existing = await typeColorMapRepo.getByPk(db, cardType);
    if (existing) await typeColorMapRepo.update(db, cardType, { band });
    else await typeColorMapRepo.insert(db, { card_type: cardType, band });

    // 2. Load everything the recompute needs.
    const [copies, catalogRows, lines, slots, typeMapRows] = await Promise.all([
      copyRepo.listAll(db),
      catalogCardRepo.listAll(db),
      evolutionLineRepo.listAll(db),
      lineSlotRepo.listAll(db),
      typeColorMapRepo.list(db),
    ]);

    const catalogById = new Map<string, EngineCatalogCard>();
    for (const r of catalogRows) catalogById.set(r.tcgdex_id, toCatalogCard(r));
    const copyById = new Map(copies.map((c) => [c.id, c]));
    const newMap: Record<string, string> = {};
    for (const t of typeMapRows) newMap[t.card_type] = t.band;

    const recomputeCopies: RecomputeCopy[] = copies.map((c) => ({
      id: c.id,
      catalogCardId: c.catalog_card_id,
      colorBand: c.color_band,
    }));

    // A line's colour follows any member card's type — prefer a filled copy, else a target card.
    const slotsByLine = new Map<string, typeof slots>();
    for (const s of slots) {
      const list = slotsByLine.get(s.line_id) ?? [];
      list.push(s);
      slotsByLine.set(s.line_id, list);
    }
    const recomputeLines: RecomputeLine[] = lines.map((l) => {
      const lineSlots = (slotsByLine.get(l.id) ?? [])
        .slice()
        .sort((a, b) => a.stage_index - b.stage_index);
      let rep: string | null = null;
      for (const s of lineSlots) {
        if (s.copy_id) {
          rep = copyById.get(s.copy_id)?.catalog_card_id ?? null;
          if (rep) break;
        }
      }
      if (!rep)
        rep = lineSlots.find((s) => s.target_catalog_card_id)?.target_catalog_card_id ?? null;
      return { id: l.id, colorBand: l.color_band, representativeCardId: rep };
    });

    const { copyUpdates, lineUpdates } = recomputeBands(
      recomputeCopies,
      recomputeLines,
      catalogById,
      newMap,
    );

    // 3. Apply.
    await Promise.all([
      ...copyUpdates.map((u) => copyRepo.update(db, u.id, { color_band: u.band })),
      ...lineUpdates.map((u) => evolutionLineRepo.update(db, u.id, { color_band: u.band })),
    ]);

    return { ok: true, data: { copies: copyUpdates.length, lines: lineUpdates.length } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
