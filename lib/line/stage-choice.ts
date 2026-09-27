/**
 * Her choice for each unfilled stage of a line, and for a short complete line's third pocket, checked on the server
 * and turned into writes (UIL-121). Karvi, 2026-09-27: "Functionally, there are only 2 stages: open or closed", and
 * nothing is written for her. Every empty stage waits for her choice:
 *
 *   chase a card     one in the catalog (the stage's species, the LINE's language), or a placeholder card she makes
 *                    when the catalog lacks it (a catalog-only stand-in: no copy). Chasing = her wishlist add.
 *   leave it empty   nothing on her wishlist for it.
 *   a filler         what physically fills the pocket: a basic energy (untracked), or one of her spare copies, which
 *                    becomes a block there.
 *
 * ONE rule for every screen that writes a line (the line popup on the Haul Plan, Move, Lookup, Collections, Lines'
 * Choose, and Backfill), so they cannot disagree. Migration 0030's `assert_line_slots` holds the database to the
 * same meaning; this is where she hears why, in her words, before anything is written.
 *
 * PURE: the fresh state comes in as `StageState`, read by the caller in the same request. Ids for new rows come from
 * `st.newId` / `st.newStandInId` so a test can pin them.
 */

import { languageOfId, localeOfId, type Language } from "@/lib/catalog/locale";
import { mirrorPrintingLike, standInTwin } from "@/lib/catalog/stand-in";
import type { SlotPatch, WriteOp } from "@/lib/repo/write-ops";
import type { Locale } from "@/lib/sync/types";
import {
  LINE_ROW_POCKETS,
  stageLabel,
  type FillerChoice,
  type StageDecision,
  type StandInDraft,
  type ThirdPocketChoice,
} from "./popup";

/* ------------------------------------------ inputs ------------------------------------------ */

/** A catalog card as the checks read it. */
export interface StageCatalogCard {
  tcgdexId: string;
  name: string;
  dexId: readonly number[];
  cardClass: string;
  setName: string | null;
  localId: string | null;
  locale: string;
}

/** One of her copies as the filler check reads it. */
export interface StageCopy {
  id: string;
  role: string;
}

/** Fresh state, read by the caller in the same request. */
export interface StageState {
  card(id: string): StageCatalogCard | null;
  copy(id: string): StageCopy | null;
  /** Her stand-ins, for the twin check. */
  standIns: readonly StageCatalogCard[];
  /** Mirrored printings that could be the card a stand-in draft describes (same name), for the duplicate check. */
  mirrorCandidates(draft: StandInDraft): readonly StageCatalogCard[];
  newId(): string;
  newStandInId(language: Language): string;
}

/** The stage being decided, from the server's own read of the line (never the browser's). */
export interface StageTarget {
  lineId: string;
  slotId: string;
  stageIndex: number;
  /** "Basic" | "Stage1" | "Stage2". */
  stage: string;
  dexId: number;
  /** "Charmeleon", for her refusal. */
  speciesName: string;
  lineLocale: Locale;
  binderId: string;
  /** The line colour's representative type: the wishlist's `required_type`, and a new stand-in's type. */
  requiredType: string | null;
}

/** Where a filler card may come from: her bulk box (every popup screen), or her haul (Backfill transcribing). */
export type FillerSource = "bulk" | "haul";

/* ------------------------------------------ refusals ------------------------------------------ */

/** Her words for each refusal. Nothing is written when one is thrown. */
export const STAGE_REFUSAL = {
  missing: (stage: string) => `Choose what goes in the ${stageLabel(stage)} slot.`,
  wrongSpecies: (species: string) => `That card isn't a ${species}; pick one for this stage.`,
  otherLanguage: "That card is in another language than this line.",
  unknownCard: "That card isn't in the catalog any more; reload and pick again.",
  standInName: "A placeholder card needs a name.",
  standInTwin: "You already made that card; pick it from the list.",
  mirrorDuplicate: "That card is already in the catalog; pick it from the list.",
  fillerNotInBulk: "That card isn't in your bulk box any more.",
  fillerNotInHaul: "That card isn't waiting in your haul any more.",
  thirdPocketMissing: "Choose what fills the third pocket.",
  noThirdPocket: "This line has no third pocket to fill.",
} as const;

/** A refusal in her words. The screen shows `message` as it is. */
export class StageChoiceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageChoiceRefusal";
  }
}

const refuse = (message: string): never => {
  throw new StageChoiceRefusal(message);
};

/* ------------------------------------------ outputs ------------------------------------------ */

type Op<K extends WriteOp["op"]> = Extract<WriteOp, { op: K }>;

/** The writes one stage decision implies. `stageWriteOps` puts them in the order the database needs. */
export interface StageWrite {
  slotPatch: SlotPatch;
  /** A new placeholder card, inserted before the slot names it. */
  standIn?: Op<"insert_catalog_stand_in">;
  /** Her wishlist add, for a chase. */
  wish?: Op<"upsert_wishlist_for_slot">;
  /** Close the slot's open wish: she is no longer chasing it. */
  resolveWish?: true;
  /** A filler card: it leaves her bulk box (or haul) and becomes a block in the line's binder. */
  copyPatch?: Op<"update_copy">;
  block?: Op<"insert_binder_block">;
  decision?: Op<"insert_decision">;
}

/* ------------------------------------------ the stage ------------------------------------------ */

/**
 * Check her choice for one unfilled stage against fresh state, and say what to write. Throws `StageChoiceRefusal`,
 * in her words, for a missing or impossible choice.
 */
export function validateStageDecision(
  st: StageState,
  target: StageTarget,
  d: StageDecision | undefined,
  opts: { fillerFrom?: readonly FillerSource[] } = {},
): StageWrite {
  if (!d) return refuse(STAGE_REFUSAL.missing(target.stage));
  // Anything but a chase closes the slot's open wish, if it has one (a stage she re-decides on Lines); on a slot with
  // none it changes nothing.
  const closeWish = { resolveWish: true as const };

  switch (d.kind) {
    case "chase": {
      let chosen: StageCatalogCard;
      let standIn: Op<"insert_catalog_stand_in"> | undefined;
      if ("catalogCardId" in d) {
        chosen = st.card(d.catalogCardId) ?? refuse(STAGE_REFUSAL.unknownCard);
        if (!chosen.dexId.includes(target.dexId)) {
          refuse(STAGE_REFUSAL.wrongSpecies(target.speciesName));
        }
        const language = languageOfId(chosen.tcgdexId) ?? localeOfId(chosen.tcgdexId);
        if (language !== target.lineLocale) refuse(STAGE_REFUSAL.otherLanguage);
      } else {
        standIn = standInFor(st, target, d.newStandIn);
        chosen = {
          tcgdexId: standIn.tcgdex_id,
          name: standIn.name,
          dexId: [target.dexId],
          cardClass: "standard",
          setName: standIn.set_name,
          localId: standIn.local_id,
          locale: target.lineLocale,
        };
      }
      return {
        ...(standIn ? { standIn } : {}),
        slotPatch: {
          state: "placeholder",
          target_catalog_card_id: chosen.tcgdexId,
          note: null,
          stage_choice: "chase",
        },
        wish: {
          op: "upsert_wishlist_for_slot",
          line_slot_id: target.slotId,
          required_dex_id: target.dexId,
          required_type: target.requiredType,
          required_stage: target.stage,
          chosen_catalog_card_id: chosen.tcgdexId,
          alternate_catalog_card_ids: [],
          will_live_in_specialty: chosen.cardClass === "specialty",
          held_for_binder_id: target.binderId,
        },
      };
    }

    case "empty":
      return {
        ...closeWish,
        slotPatch: {
          state: "placeholder",
          target_catalog_card_id: null,
          note: null,
          stage_choice: "empty",
        },
      };

    case "filler": {
      const pocket = fillerWrites(st, target.lineId, target.binderId, d.filler, opts.fillerFrom, {
        slotId: target.slotId,
        stage: target.stage,
      });
      return {
        ...closeWish,
        slotPatch: {
          state: "block",
          target_catalog_card_id: null,
          note: null,
          stage_choice: "filler",
        },
        ...pocket,
      };
    }
  }
}

/** The stage's writes, in the order the database needs them (a new card before the slot that names it). */
export function stageWriteOps(slotId: string, w: StageWrite): WriteOp[] {
  const ops: WriteOp[] = [];
  if (w.standIn) ops.push(w.standIn);
  if (w.resolveWish) ops.push({ op: "resolve_wishlist_for_slot", line_slot_id: slotId });
  ops.push({ op: "update_slot", id: slotId, patch: w.slotPatch });
  if (w.wish) ops.push(w.wish);
  if (w.copyPatch) ops.push(w.copyPatch);
  if (w.block) ops.push(w.block);
  if (w.decision) ops.push(w.decision);
  return ops;
}

/** A catalog-only placeholder card for this stage: her words, the stage's dex id, stage and type. No copy. */
function standInFor(
  st: StageState,
  target: StageTarget,
  draft: StandInDraft,
): Op<"insert_catalog_stand_in"> {
  const name = draft.name.trim();
  if (!name) refuse(STAGE_REFUSAL.standInName);
  if (draft.language !== target.lineLocale) refuse(STAGE_REFUSAL.otherLanguage);
  const key = { ...draft, name };
  if (standInTwin(st.standIns, key)) refuse(STAGE_REFUSAL.standInTwin);
  if (mirrorPrintingLike(st.mirrorCandidates(key), key)) refuse(STAGE_REFUSAL.mirrorDuplicate);
  return {
    op: "insert_catalog_stand_in",
    tcgdex_id: st.newStandInId(draft.language),
    name,
    set_id: null,
    set_name: draft.setName?.trim() || null,
    local_id: draft.localId?.trim() || null,
    dex_id: [target.dexId],
    types: target.requiredType ? [target.requiredType] : [],
    stage: target.stage,
    card_class: "standard",
  };
}

/** A pocket's filler: the block row, and for a card, the copy becoming that block. */
function fillerWrites(
  st: StageState,
  lineId: string,
  binderId: string,
  filler: FillerChoice,
  fillerFrom: readonly FillerSource[] = ["bulk"],
  slot: { slotId: string; stage: string } | null,
): Pick<StageWrite, "copyPatch" | "block" | "decision"> {
  const block = (copyId: string | null): Op<"insert_binder_block"> => ({
    op: "insert_binder_block",
    id: st.newId(),
    binder_id: binderId,
    half: "back",
    pocket_count: 1,
    purpose: "line-filler",
    material: copyId ? "repurposedDuplicate" : "basicEnergy",
    copy_id: copyId,
    line_id: lineId,
    line_slot_id: slot?.slotId ?? null,
  });
  if (filler.material === "energy") return { block: block(null) };

  const copy = st.copy(filler.copyId);
  if (!copy || !fillerFrom.includes(copy.role as FillerSource)) {
    refuse(
      fillerFrom.includes("bulk") ? STAGE_REFUSAL.fillerNotInBulk : STAGE_REFUSAL.fillerNotInHaul,
    );
  }
  return {
    copyPatch: {
      op: "update_copy",
      id: filler.copyId,
      patch: {
        role: "block",
        binder_id: binderId,
        binder_half: "back",
        color_band: null,
        line_slot_id: null,
      },
    },
    block: block(filler.copyId),
    decision: {
      op: "insert_decision",
      haul_id: null,
      copy_id: filler.copyId,
      decision: "line-filler",
      reason: slot
        ? `Her filler for the ${stageLabel(slot.stage)} pocket of this line (UIL-121).`
        : "Her filler for this line's third pocket (UIL-121).",
      resolved_by: "user",
      line_id: lineId,
      line_slot_id: slot?.slotId ?? null,
    },
  };
}

/* ------------------------------------------ the third pocket ------------------------------------------ */

/** The line whose third pocket is being decided, from the server's own read. */
export interface ThirdPocketTarget {
  lineId: string;
  binderId: string;
  /** The line's slots. A line of LINE_ROW_POCKETS or more has no third pocket. */
  slotCount: number;
  /** Every slot holds a card once this write lands: only a COMPLETE short line has a third pocket (Q4). */
  completeAfterWrite: boolean;
}

/** The writes her third-pocket choice implies. `thirdPocketWriteOps` orders them. */
export interface ThirdPocketWrite {
  extraPocket: "energy" | "card" | "empty";
  copyPatch?: Op<"update_copy">;
  block?: Op<"insert_binder_block">;
  decision?: Op<"insert_decision">;
}

/** Whether this line, after this write, has a third pocket for her to fill. */
export function hasThirdPocket(t: Pick<ThirdPocketTarget, "slotCount" | "completeAfterWrite">) {
  return t.completeAfterWrite && t.slotCount > 0 && t.slotCount < LINE_ROW_POCKETS;
}

/**
 * Check her third-pocket choice. Null when the line has no third pocket and she sent none. Required when the write
 * completes a line shorter than LINE_ROW_POCKETS; refused when the line has no third pocket.
 */
export function validateThirdPocket(
  st: StageState,
  t: ThirdPocketTarget,
  choice: ThirdPocketChoice | undefined,
  opts: { fillerFrom?: readonly FillerSource[] } = {},
): ThirdPocketWrite | null {
  if (!hasThirdPocket(t)) {
    if (choice) refuse(STAGE_REFUSAL.noThirdPocket);
    return null;
  }
  if (!choice) return refuse(STAGE_REFUSAL.thirdPocketMissing);
  if (choice.material === "empty") return { extraPocket: "empty" };
  const pocket = fillerWrites(st, t.lineId, t.binderId, choice, opts.fillerFrom, null);
  return { extraPocket: choice.material === "energy" ? "energy" : "card", ...pocket };
}

/** The third pocket's writes, in order: the line records her choice, then what fills it. */
export function thirdPocketWriteOps(lineId: string, w: ThirdPocketWrite): WriteOp[] {
  const ops: WriteOp[] = [
    { op: "update_line", id: lineId, patch: { extra_pocket: w.extraPocket } },
  ];
  if (w.copyPatch) ops.push(w.copyPatch);
  if (w.block) ops.push(w.block);
  if (w.decision) ops.push(w.decision);
  return ops;
}
