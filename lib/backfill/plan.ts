/**
 * Backfill write planners (dev-spec §5 M5; system-design §4, §7A).
 *
 * PURE: given the collector's explicit entries plus lookup maps, produce the exact rows a step
 * writes — Copy / EvolutionLine / LineSlot / BinderBlock / WishlistItem / PlacementDecision — with
 * ids pre-generated so relationships are wired without a DB round-trip. The executor (`commit.ts`)
 * just applies them; the tests assert them. The clock + id generator are injected so output is
 * deterministic.
 *
 * Backfill is a transcription of what is already on the shelf, so `PlacementDecision.resolved_by` is
 * always `user` and there is no Haul (`haul_id` NULL).
 *
 * EVERY CARD IS A COPY WAITING IN HER HAUL (UIL-098). The planners take their copy ids from
 * `deps.takeCopy`, which hands out the waiting copies of a (printing, Dex variant) key oldest first, and
 * emit PLACEMENTS of them. There is no path here that creates a copy: Dex is the source of truth, and a
 * copy made outside the import is a twin the next import cannot see.
 */

import type { CatalogCard, TypeColorMap } from "@/lib/engine";
import type { Insert } from "@/lib/repo";
import { bandKeyForTypes, deriveLineStatus } from "./resolve";
import {
  emptyWrites,
  type BackfillWrites,
  type BackLineCommit,
  type FrontHalfCommit,
  type SpecialtyCommit,
} from "./types";

/** Everything the pure planners need beyond the collector's input. */
export interface PlanDeps {
  ownerId: string;
  catalogById: Map<string, CatalogCard>;
  typeColorMap: TypeColorMap;
  binderNameById: Map<string, string>;
  bandDisplayByKey: Map<string, string>;
  collectionNameById: Map<string, string>;
  /** Injected so ids are deterministic in tests. */
  newId: () => string;
  /** The next waiting copy of a key, oldest first (`takerFor` in ./waiting). Never mints an id. */
  takeCopy: (tcgdexId: string, dexVariantRaw: string) => string;
  /** Injected clock (ISO string). */
  now: string;
}

const cardName = (id: string | null | undefined, deps: PlanDeps) =>
  (id && deps.catalogById.get(id)?.name) || id || "card";
const binderName = (id: string, deps: PlanDeps) => deps.binderNameById.get(id) ?? "binder";
const bandDisplay = (key: string, deps: PlanDeps) => deps.bandDisplayByKey.get(key) ?? key;

function decision(
  deps: PlanDeps,
  copyId: string | null,
  kind: string,
  reason: string,
): Insert<"placement_decision"> {
  return {
    id: deps.newId(),
    owner_id: deps.ownerId,
    haul_id: null,
    copy_id: copyId,
    decision: kind,
    reason,
    resolved_by: "user",
    created_at: deps.now,
  };
}

/**
 * Front half, entered as a flat ordered sequence (system-design §7A). One waiting copy placed per card,
 * band auto-computed from the card's type. Physical order is the input order — never re-sorted.
 */
export function planFrontHalf(input: FrontHalfCommit, deps: PlanDeps): BackfillWrites {
  const w = emptyWrites();
  for (const c of input.cards) {
    const card = deps.catalogById.get(c.tcgdexId);
    const bandKey = bandKeyForTypes(card?.types ?? [], deps.typeColorMap);
    const copyId = deps.takeCopy(c.tcgdexId, c.dexVariantRaw);
    w.placements.push({
      copyId,
      role: "shelved",
      binder_id: input.binderId,
      binder_half: input.half,
      color_band: bandKey,
    });
    w.decisions.push(
      decision(
        deps,
        copyId,
        "backfill-front",
        `Backfilled ${cardName(c.tcgdexId, deps)} into ${binderName(input.binderId, deps)} ${input.half} half, ${bandDisplay(bandKey, deps)} band (auto-computed from type).`,
      ),
    );
  }
  return w;
}

/**
 * Back half, entered line by line (system-design §7A). Builds the EvolutionLine, one LineSlot per
 * stage (filled / placeholder / block), a waiting copy placed for each filled stage, a WishlistItem for
 * each placeholder (sticky note → shopping list), and a BinderBlock for each block — recording WHICH
 * duplicate copy was repurposed when that is the material.
 */
export function planBackLine(input: BackLineCommit, deps: PlanDeps): BackfillWrites {
  const w = emptyWrites();
  const lineId = deps.newId();
  const bd = bandDisplay(input.bandKey, deps);
  const bn = binderName(input.binderId, deps);
  const status = deriveLineStatus(input.stages, input.terminated);

  w.lines.push({
    id: lineId,
    owner_id: deps.ownerId,
    root_dex_id: input.rootDexId,
    color_band: input.bandKey,
    binder_id: input.binderId,
    half: "back",
    status,
    created_at: deps.now,
  });

  for (const s of input.stages) {
    const slotId = deps.newId();

    if (s.decision === "filled") {
      const copyId = deps.takeCopy(s.filledTcgdexId!, s.filledDexVariantRaw!);
      w.placements.push({
        copyId, // linked to its slot below, once the slot exists (circular FK)
        role: "shelved",
        binder_id: input.binderId,
        binder_half: "back",
        color_band: input.bandKey,
      });
      w.slots.push({
        id: slotId,
        owner_id: deps.ownerId,
        line_id: lineId,
        stage_index: s.stageIndex,
        stage: s.stage,
        state: "filled",
        copy_id: copyId,
        target_catalog_card_id: s.filledTcgdexId ?? null,
        note: null,
      });
      w.copyLineSlotLinks.push({ copyId, slotId });
      w.decisions.push(
        decision(
          deps,
          copyId,
          "backfill-line-filled",
          `Backfilled ${cardName(s.filledTcgdexId, deps)} (${s.stage}) into ${bn} back half, ${bd} line.`,
        ),
      );
      continue;
    }

    if (s.decision === "placeholder") {
      w.slots.push({
        id: slotId,
        owner_id: deps.ownerId,
        line_id: lineId,
        stage_index: s.stageIndex,
        stage: s.stage,
        state: "placeholder",
        copy_id: null,
        target_catalog_card_id: s.targetCatalogCardId ?? null,
        note: null,
      });
      w.wishlist.push({
        id: deps.newId(),
        owner_id: deps.ownerId,
        line_slot_id: slotId,
        required_dex_id: s.dexId,
        required_type: input.requiredType,
        required_stage: s.stage,
        chosen_catalog_card_id: s.targetCatalogCardId ?? null,
        alternate_catalog_card_ids: s.alternateCatalogCardIds ?? [],
        held_for_binder_id: input.binderId,
        will_live_in_specialty: s.specialtyOnly ?? false,
        created_at: deps.now,
      });
      continue;
    }

    // block — a physically reserved pocket run (basic energy, or a repurposed duplicate).
    let blockCopyId: string | null = null;
    if (s.blockMaterial === "repurposedDuplicate" && s.blockCopyTcgdexId) {
      blockCopyId = deps.takeCopy(s.blockCopyTcgdexId, s.blockCopyDexVariantRaw!);
      w.placements.push({
        copyId: blockCopyId,
        role: "block",
        binder_id: input.binderId,
        binder_half: "back",
        color_band: null,
      });
      w.decisions.push(
        decision(
          deps,
          blockCopyId,
          "backfill-block-repurposed",
          `Repurposed duplicate ${cardName(s.blockCopyTcgdexId, deps)} as a binder block for the ${s.stage} slot of the ${bd} line in ${bn} back half.`,
        ),
      );
    }
    w.slots.push({
      id: slotId,
      owner_id: deps.ownerId,
      line_id: lineId,
      stage_index: s.stageIndex,
      stage: s.stage,
      state: "block",
      copy_id: null,
      target_catalog_card_id: null,
      note: s.blockMaterial === "basicEnergy" ? "basic energy block" : "repurposed duplicate block",
    });
    w.blocks.push({
      id: deps.newId(),
      owner_id: deps.ownerId,
      binder_id: input.binderId,
      half: "back",
      pocket_count: s.pocketCount ?? 1,
      purpose: "line-terminated",
      material: s.blockMaterial ?? "basicEnergy",
      copy_id: blockCopyId,
      line_id: lineId,
      created_at: deps.now,
    });
  }

  return w;
}

/**
 * Specialty binder, entered as a flat list with collection tags (system-design §7A). One waiting
 * copy placed per card (a specialty binder is a single section — no half, no band) and, per tagged
 * collection, a target-membership add so the collection-claim cascade rule can later fire.
 */
export function planSpecialty(input: SpecialtyCommit, deps: PlanDeps): BackfillWrites {
  const w = emptyWrites();
  for (const c of input.cards) {
    const copyId = deps.takeCopy(c.tcgdexId, c.dexVariantRaw);
    w.placements.push({
      copyId,
      role: "shelved",
      binder_id: input.binderId,
      binder_half: null,
      color_band: null,
    });
    const tags = c.collectionIds
      .map((id) => deps.collectionNameById.get(id))
      .filter((n): n is string => Boolean(n));
    const tagNote = tags.length > 0 ? ` (collections: ${tags.join(", ")})` : "";
    w.decisions.push(
      decision(
        deps,
        copyId,
        "backfill-specialty",
        `Backfilled ${cardName(c.tcgdexId, deps)} into specialty binder ${binderName(input.binderId, deps)}${tagNote}.`,
      ),
    );
    for (const collectionId of c.collectionIds) {
      w.collectionTags.push({ collectionId, catalogCardId: c.tcgdexId });
    }
  }
  return w;
}
