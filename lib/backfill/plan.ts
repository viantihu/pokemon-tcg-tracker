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
import {
  lineStatusOf,
  type FillerChoice,
  type StageDecision,
  type ThirdPocketChoice,
} from "@/lib/line/popup";
import {
  STAGE_REFUSAL,
  StageChoiceRefusal,
  stageWriteOps,
  thirdPocketWriteOps,
  validateStageDecision,
  validateThirdPocket,
  type StageState,
} from "@/lib/line/stage-choice";
import type { Insert, WriteOp } from "@/lib/repo";
import { bandKeyForTypes } from "./resolve";
import type { ValidatedBackLine } from "./validate";
import {
  emptyWrites,
  type BackfillFiller,
  type BackfillStageChoice,
  type BackfillThirdPocket,
  type BackfillWrites,
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
  /** Fresh state for the shared stage-choice rule (UIL-121): the catalog, her waiting copies, her stand-ins. */
  stageState: StageState;
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
 * Back half, entered line by line (system-design §7A; UIL-117 C; UIL-121). Builds the EvolutionLine and one
 * LineSlot per stage:
 *
 *   - a card she HAS: a waiting copy placed there, the slot filled, both pointers, and its decision;
 *   - every other stage: the slot, then her choice through the SHARED rule (lib/line/stage-choice.ts), which checks it
 *     and says what to write: a chase (the slot's target and her wishlist add, or a placeholder card she made), left
 *     empty (nothing on her wishlist), or a filler (a basic energy, or a spare card from her haul, which becomes a
 *     block there). A stage goes on her wishlist only when she chases it (UIL-119);
 *   - a complete line shorter than three pockets: her third-pocket choice, through the same rule.
 *
 * The line's status is her choices' (`lineStatusOf`): CLOSED when every stage is filled, empty or a filler, OPEN while
 * one is chased. A refusal from the shared rule is thrown here, before anything is written.
 */
export function planBackLine(line: ValidatedBackLine, deps: PlanDeps): BackfillWrites {
  const w = emptyWrites();
  const lineId = deps.newId();
  const bd = bandDisplay(line.bandKey, deps);
  const bn = binderName(line.binderId, deps);
  const st = deps.stageState;
  // A spare card comes from her bulk box or her haul (the Senior BA's ruling); each pick is held to its own source.
  const fillerFrom = ["bulk", "haul"] as const;
  const spare = spareCards(deps);
  const finals: { state: string; stageChoice?: string | null }[] = [];
  const choiceOps: WriteOp[] = [];

  line.stages.forEach((s, i) => {
    const slotId = deps.newId();
    const choice = s.choice;
    if (choice?.kind === "have") {
      const copyId = deps.takeCopy(choice.tcgdexId, choice.dexVariantRaw);
      w.placements.push({
        copyId, // linked to its slot below, once the slot exists (circular FK)
        role: "shelved",
        binder_id: line.binderId,
        binder_half: "back",
        color_band: line.bandKey,
      });
      w.slots.push({
        id: slotId,
        owner_id: deps.ownerId,
        line_id: lineId,
        stage_index: s.stageIndex,
        stage: s.stage,
        state: "filled",
        copy_id: copyId,
        target_catalog_card_id: choice.tcgdexId,
        note: null,
      });
      w.copyLineSlotLinks.push({ copyId, slotId });
      w.decisions.push(
        decision(
          deps,
          copyId,
          "backfill-line-filled",
          `Backfilled ${cardName(choice.tcgdexId, deps)} (${s.stage}) into ${bn} back half, ${bd} line.`,
        ),
      );
      finals.push({ state: "filled" });
      return;
    }

    // Undecided until her choice patches it, in the same write (0030 checks only the final state).
    w.slots.push({
      id: slotId,
      owner_id: deps.ownerId,
      line_id: lineId,
      stage_index: s.stageIndex,
      stage: s.stage,
      state: "placeholder",
      copy_id: null,
      target_catalog_card_id: null,
      note: null,
    });
    const info = line.chain[i];
    const decided = validateStageDecision(
      st,
      {
        lineId,
        slotId,
        stageIndex: s.stageIndex,
        stage: s.stage,
        dexId: s.dexId,
        speciesName: info?.name ?? s.stage,
        lineLocale: line.lineLocale,
        binderId: line.binderId,
        requiredType: line.requiredType,
      },
      sharedChoice(choice, spare),
      { fillerFrom },
    );
    choiceOps.push(...stageWriteOps(slotId, decided));
    finals.push({
      state: decided.slotPatch.state ?? "placeholder",
      stageChoice: decided.slotPatch.stage_choice,
    });
  });

  w.lines.push({
    id: lineId,
    owner_id: deps.ownerId,
    root_dex_id: line.rootDexId,
    color_band: line.bandKey,
    binder_id: line.binderId,
    half: "back",
    status: lineStatusOf(finals),
    // No form: the database stamps it from the cards and chases this write puts in it, at commit (0038).
    created_at: deps.now,
  });

  // The third pocket: only a COMPLETE line shorter than three pockets has one (UIL-121 Q4).
  const third = validateThirdPocket(
    st,
    {
      lineId,
      binderId: line.binderId,
      slotCount: line.stages.length,
      completeAfterWrite: finals.length > 0 && finals.every((f) => f.state === "filled"),
    },
    line.thirdPocket ? sharedThirdPocket(line.thirdPocket, spare) : undefined,
    { fillerFrom },
  );
  if (third) choiceOps.push(...thirdPocketWriteOps(lineId, third));

  w.lineOps.push(...choiceOps);
  return w;
}

/** Her Backfill choice as the shared rule's, with a filler card resolved to the copy it takes. */
function sharedChoice(
  choice: BackfillStageChoice | undefined,
  spare: (f: BackfillFiller) => FillerChoice,
): StageDecision | undefined {
  if (!choice || choice.kind === "have") return undefined;
  if (choice.kind === "filler") return { kind: "filler", filler: spare(choice.filler) };
  return choice;
}

function sharedThirdPocket(
  t: BackfillThirdPocket,
  spare: (f: BackfillFiller) => FillerChoice,
): ThirdPocketChoice {
  return t.material === "empty" ? t : spare(t);
}

/**
 * A spare card as the shared rule takes it, held to where she picked it. A haul card takes the next waiting copy of
 * that printing (`from: "haul"`); a bulk box card is that copy (the default source), and one copy fills one pocket.
 */
function spareCards(deps: PlanDeps): (f: BackfillFiller) => FillerChoice {
  const usedBulk = new Set<string>();
  return (f) => {
    if (f.material === "energy") return f;
    if ("copyId" in f) {
      if (usedBulk.has(f.copyId)) throw new StageChoiceRefusal(STAGE_REFUSAL.fillerNotInBulk);
      usedBulk.add(f.copyId);
      return { material: "card", copyId: f.copyId };
    }
    return { material: "card", copyId: deps.takeCopy(f.tcgdexId, f.dexVariantRaw), from: "haul" };
  };
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
