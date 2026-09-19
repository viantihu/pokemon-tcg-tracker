"use server";

/**
 * Server actions for the Lookup screen (dev-spec §5 M8; system-design §7C).
 *
 * Type-ahead reuses the plan screen's mirror search (M6). `lookupAnswer` loads the shared plan
 * context (M6 `loadPlanContext`) + open wishlist items, then hands the joins to the PURE
 * `buildLookupAnswer` (lib/surfaces). The client never touches the DB or TCGdex.
 *
 * EVERY action here returns a RESULT and never throws to the client (UIL-035, third site). A thrown
 * server-action error reaches a production browser as a generic message with a digest — Next redacts
 * the text — so a throw could never tell her WHAT failed, and the old `catch → notFound` told her the
 * card did not exist when the truth was that nothing was asked. A returned `{ ok: false, error }`
 * carries the real message across the boundary, and `answer: null` inside `ok: true` is the ONLY thing
 * that means "the mirror was asked and does not have this card".
 */

import { band } from "@/lib/engine";
import { applyMove, loadMoveOptions, moveNameLookups } from "@/lib/line";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { getOwnerContext, loadPlanContext, type PlanContext } from "@/lib/plan";
import { catalogCardRepo, wishlistItemRepo, type DbClient } from "@/lib/repo";
import {
  buildLookupAnswer,
  type LookupAnswer,
  type LookupCopy,
  type LookupLineRef,
} from "@/lib/surfaces";
import { errorMessage } from "@/lib/errors";
import { lookupCatalog } from "../plan/actions";
import type { LookupCard } from "../plan/plan-types";
import { toMovableCopy, type HomeNames, type LookupMovableCopy } from "./lookup-copies";

/** Type-ahead against the local mirror — the same server search the plan intake uses. */
export async function searchCatalog(query: string): Promise<LookupCard[]> {
  return lookupCatalog(query);
}

/**
 * The show-floor answer for one printing. `answer: null` = not in the mirror (a real miss);
 * `ok: false` = the lookup itself failed, and the card may well exist.
 */
export type LookupResult =
  | { ok: true; answer: LookupAnswer | null; copies: LookupMovableCopy[] }
  | { ok: false; error: string };

export async function lookupAnswer(tcgdexId: string): Promise<LookupResult> {
  try {
    const { db } = await getOwnerContext();
    return await assembleLookup(db, tcgdexId);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Move-picker options (binders, collections, bands) for the per-copy Move (UIL-051). */
export async function lookupMoveOptions(): Promise<
  { ok: true; options: MoveOptions } | { ok: false; error: string }
> {
  try {
    const { db } = await getOwnerContext();
    return { ok: true, options: await loadMoveOptions(db) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export type LookupMoveResult =
  { ok: true; label: string; lookup: LookupResult } | { ok: false; error: string };

/**
 * Move one of her copies from the Lookup screen (UIL-051) through the SAME atomic write the Line and
 * Plan screens use (`applyMove`: placement + vacated slot + demoted line + collection membership +
 * audit, one transaction), then re-read the answer so the screen shows the card where it now is.
 */
export async function moveFromLookup(
  copyId: string,
  destination: MoveDestination,
  tcgdexId: string,
): Promise<LookupMoveResult> {
  try {
    const { db } = await getOwnerContext();
    const options = await loadMoveOptions(db);
    const res = await applyMove(db, { copyId, destination }, moveNameLookups(options));
    const lookup = await assembleLookup(db, tcgdexId);
    return { ok: true, label: res.destinationLabel, lookup };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Name lookups for a copy's present home, resolved from the plan context (see lookup-copies.ts). */
function homeNames(pc: PlanContext, tcgdexId: string): HomeNames {
  return {
    binderName: (id) => pc.lookups.binderNameById.get(id),
    bandDisplay: (key) => pc.lookups.bandDisplayByKey.get(key),
    collectionIn: (binderId) =>
      pc.ctx.collections.find(
        (c) => c.currentBinderIds.includes(binderId) && c.targetCatalogCardIds.includes(tcgdexId),
      )?.id ?? null,
  };
}

/** Assemble the answer + movable copies for one printing. Throws on I/O failure; callers wrap. */
async function assembleLookup(
  db: DbClient,
  tcgdexId: string,
): Promise<Extract<LookupResult, { ok: true }>> {
  const [row, pc, openWishlist] = await Promise.all([
    catalogCardRepo.getByPk(db, tcgdexId),
    loadPlanContext(db),
    wishlistItemRepo.listOpen(db),
  ]);
  if (!row) return { ok: true, answer: null, copies: [] };

  const engineCard = pc.catalogById.get(tcgdexId);
  if (!engineCard) return { ok: true, answer: null, copies: [] };

  const bandKey = band(engineCard, pc.ctx.typeColorMap);
  const bandDisplay = pc.lookups.bandDisplayByKey.get(bandKey) ?? bandKey;
  const dexId = engineCard.dexId[0] ?? null;

  // Species name for a line label: any catalog card sharing the line's root dexId.
  const nameByDexId = new Map<number, string>();
  for (const c of pc.catalogById.values()) {
    const d = c.dexId[0];
    if (d != null && !nameByDexId.has(d)) nameByDexId.set(d, c.name);
  }
  const lineLabel = (rootDexId: number) => `${nameByDexId.get(rootDexId) ?? "Line"} line`;

  // Physical copies of THIS printing (all roles).
  const ownedHere = pc.ctx.owned.filter((o) => o.card.tcgdexId === tcgdexId);
  const copies: LookupCopy[] = ownedHere.map((o) => ({
    role: o.role,
    binderId: o.binderId,
    binderName: o.binderId ? (pc.lookups.binderNameById.get(o.binderId) ?? null) : null,
    binderHalf: o.binderHalf,
    bandDisplay: o.colorBand ? (pc.lookups.bandDisplayByKey.get(o.colorBand) ?? o.colorBand) : null,
    lineSlotId: o.lineSlotId,
  }));
  const names = homeNames(pc, tcgdexId);
  const movable = ownedHere.map((o) => toMovableCopy(o, names));

  const toLineRef = (
    lineId: string,
    rootDexId: number,
    stage: string | null,
    status: string,
  ): LookupLineRef => ({
    lineId,
    lineLabel: lineLabel(rootDexId),
    stage,
    status: (status as LookupLineRef["status"]) ?? "open",
  });

  // Is one of her copies already sitting in a line?
  const slotIds = new Set(copies.map((c) => c.lineSlotId).filter((s): s is string => !!s));
  let ownedInLine: LookupLineRef | null = null;
  for (const line of pc.ctx.lines) {
    const slot = line.slots.find((s) => s.copyId && slotIds.has(s.id));
    if (slot) {
      ownedInLine = toLineRef(line.id, line.rootDexId, slot.stage, line.status);
      break;
    }
  }

  // Would this species+colour fill an OPEN placeholder somewhere?
  let completesLine: LookupLineRef | null = null;
  if (!ownedInLine && dexId != null) {
    for (const line of pc.ctx.lines) {
      if (line.colorBand !== bandKey) continue;
      const slot = line.slots.find((s) => s.state === "placeholder" && s.dexId === dexId);
      if (slot) {
        completesLine = toLineRef(line.id, line.rootDexId, slot.stage, line.status);
        break;
      }
    }
  }

  // Wishlist: chosen/alternate target, or the species is required by an open gap.
  const wished = openWishlist.find(
    (w) =>
      w.chosen_catalog_card_id === tcgdexId ||
      w.alternate_catalog_card_ids.includes(tcgdexId) ||
      (dexId != null && w.required_dex_id === dexId),
  );
  const wishlist = {
    wished: !!wished,
    willLiveInSpecialty: wished?.will_live_in_specialty ?? false,
    detail: wished
      ? wished.chosen_catalog_card_id === tcgdexId && row.price_market != null
        ? `$${row.price_market.toFixed(2)} · chosen target`
        : wished.will_live_in_specialty
          ? "Would go to the specialty binder."
          : "On the hunt to fill a gap."
      : null,
  };

  const collections = pc.ctx.collections
    .filter((c) => c.targetCatalogCardIds.includes(tcgdexId))
    .map((c) => ({ id: c.id, name: c.name }));

  const answer = buildLookupAnswer({
    card: {
      tcgdexId: row.tcgdex_id,
      name: row.name,
      setName: row.set_name,
      localId: row.local_id,
      rarity: row.rarity,
      types: row.types ?? [],
      stage: row.stage,
      cardClass: row.card_class === "specialty" ? "specialty" : "standard",
      imageUrl: row.image_url,
    },
    bandKey,
    bandDisplay,
    orderedBandKeys: pc.orderedBandKeys,
    copies,
    ownedInLine,
    completesLine,
    wishlist,
    collections,
  });
  return { ok: true, answer, copies: movable };
}
