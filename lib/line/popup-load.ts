/**
 * The line popup's model, built on the SERVER from fresh state (UIL-117, mockup v3 sections 3 and 4). A screen asks
 * for it with a proposal (start a line here / add to this line's slot) and renders it; nothing in it is trusted back:
 * her confirm sends a `LineChoice`, which `buildLineChoiceOps` re-checks against state read again at write time.
 *
 * START lays the line out stage by stage exactly as the engine would generate it for her band: the card being placed,
 * every card she already owns that could fill a stage (shown UNTICKED, with where it is now, UIL-061), the stages
 * still wanted, and the ones no card can fill. ADD lays out the existing line with the card landing in its open slot.
 * Both carry every line the family already has, anywhere in her collection and in either language (UIL-096, UIL-090),
 * each with the slot this card could take there, so starting a second line is never a surprise.
 */

import {
  generateSlots,
  lineLocaleOf,
  testViability,
  type Band,
  type CatalogCard,
  type IncomingCard,
  type LineSlotRecord,
  type TypeColorMap,
  type Variant,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import { toCatalogCard, toOwnedCopy } from "@/lib/plan/adapt";
import {
  binderRepo,
  catalogCardRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import { buildLineJoinIndex, joinOptionsFor } from "./join-options";
import {
  IN_THE_HAUL,
  type LinePopupExistingLine,
  type LinePopupModel,
  type LinePopupStage,
  type LineProposal,
} from "./popup";
import type { CardIdentity } from "./types";

export async function loadLinePopupModel(
  db: DbClient,
  copyId: string,
  proposal: LineProposal,
): Promise<LinePopupModel> {
  const [copy, catalogRows, typeMapRows, copies, lines, slots, binders, bands] = await Promise.all([
    copyRepo.getByPk(db, copyId),
    catalogCardRepo.listAll(db),
    typeColorMapRepo.list(db),
    copyRepo.list(db),
    evolutionLineRepo.list(db),
    lineSlotRepo.list(db),
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
  ]);
  if (!copy) throw new Error("That card is no longer in the collection.");
  const catalog = catalogRows.map(toCatalogCard);
  const catalogById = new Map(catalog.map((c) => [c.tcgdexId, c]));
  const imageUrlById = new Map(catalogRows.map((r) => [r.tcgdex_id, r.image_url]));
  const card = catalogById.get(copy.catalog_card_id);
  if (!card) throw new Error("That card's catalog entry is missing — reload and try again.");
  const typeColorMap: TypeColorMap = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;
  const binderName = new Map(binders.map((b) => [b.id, b.name]));
  const bandDisplay = new Map(bands.map((b) => [b.band, b.display_name]));
  const copyById = new Map(copies.map((c) => [c.id, c]));
  const slotsByLine = new Map<string, Row<"line_slot">[]>();
  for (const s of slots) slotsByLine.set(s.line_id, [...(slotsByLine.get(s.line_id) ?? []), s]);
  for (const list of slotsByLine.values()) list.sort((a, b) => a.stage_index - b.stage_index);

  const identity = (cc: CatalogCard, bandKey: string): CardIdentity => ({
    tcgdexId: cc.tcgdexId,
    name: cc.name,
    setId: cc.setId,
    setName: cc.setName ?? null,
    localId: cc.localId,
    setCardCountOfficial: cc.setCardCountOfficial ?? null,
    imageUrl: imageUrlById.get(cc.tcgdexId) ?? null,
    bandKey,
  });
  const cardOfCopy = (id: string) => copyById.get(id)?.catalog_card_id ?? null;
  const localeOfLine = (lineId: string) =>
    lineLocaleOf((slotsByLine.get(lineId) ?? []).map(toSlotRecord), cardOfCopy);
  /** Where a card is now, in her words: "KB-001 · Front · Red", the bulk box, or still in the haul. */
  const whereIs = (c: Row<"copy">): string => {
    if (c.role === "haul") return IN_THE_HAUL;
    if (c.role === "bulk" || !c.binder_id) return "Bulk box";
    const half = c.binder_half === "back" ? "Back" : c.binder_half === "front" ? "Front" : null;
    return [
      binderName.get(c.binder_id) ?? "A binder",
      half,
      c.color_band ? (bandDisplay.get(c.color_band) ?? c.color_band) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const cardLocale = localeOfId(card.tcgdexId);
  const incoming: IncomingCard = {
    id: copy.id,
    card,
    variant: (copy.variant as Variant) ?? "normal",
  };

  // UIL-096: every line this family has, anywhere; each with the open slot THIS card's species would take there.
  const index = buildLineJoinIndex(
    lines.map((l) => ({
      id: l.id,
      rootDexId: l.root_dex_id,
      colorBand: l.color_band,
      binderId: l.binder_id,
    })),
    slotsByLine,
    catalog,
    cardOfCopy,
  );
  const options = joinOptionsFor(card, index, typeColorMap, catalog);
  const openSlotFor = (lineId: string): string | null =>
    (slotsByLine.get(lineId) ?? []).find(
      (s) =>
        s.state !== "filled" &&
        !!s.target_catalog_card_id &&
        (catalogById.get(s.target_catalog_card_id)?.dexId ?? []).some((d) =>
          card.dexId.includes(d),
        ),
    )?.id ?? null;

  /** An existing line's tile image: its most evolved card she holds there, else its top target. */
  const faceOfLine = (lineId: string, bandKey: string): CardIdentity | null => {
    const lineSlots = slotsByLine.get(lineId) ?? [];
    for (const s of [...lineSlots].reverse()) {
      const held = s.state === "filled" && s.copy_id ? cardOfCopy(s.copy_id) : null;
      const cc = held ? catalogById.get(held) : undefined;
      if (cc) return identity(cc, bandKey);
    }
    const top = lineSlots.at(-1)?.target_catalog_card_id;
    const target = top ? catalogById.get(top) : undefined;
    return target ? identity(target, bandKey) : null;
  };

  let model: Omit<LinePopupModel, "existingLines">;
  let hereBinder: string | null;
  let hereBand: string;

  if (proposal.kind === "start") {
    const general = binders.filter((b) => b.type === "general");
    hereBinder = proposal.binderId ?? general[0]?.id ?? null;
    hereBand = proposal.band;
    const owned = copies
      .filter((c) => c.id !== copy.id)
      .map((c) => toOwnedCopy(c, catalogById))
      .filter((o): o is NonNullable<typeof o> => o !== null);
    const viability = {
      ...testViability(incoming, owned, catalog, typeColorMap),
      band: hereBand as Band,
      viable: true,
    };
    const gen = generateSlots(incoming, viability, owned, catalog, typeColorMap);
    const stages: LinePopupStage[] = gen.slots.map((s) => {
      if (s.stageIndex === gen.incomingStageIndex) {
        return {
          stageIndex: s.stageIndex,
          stage: s.stage,
          state: "incoming",
          card: identity(card, hereBand),
        };
      }
      const pullRow = s.copyId ? copyById.get(s.copyId) : undefined;
      const pullCard = pullRow ? catalogById.get(pullRow.catalog_card_id) : undefined;
      if (pullRow && pullCard) {
        return {
          stageIndex: s.stageIndex,
          stage: s.stage,
          state: "pullable",
          card: identity(pullCard, hereBand),
          pull: { copyId: pullRow.id, fromLabel: whereIs(pullRow) },
        };
      }
      const target = s.targetCatalogCardId ? catalogById.get(s.targetCatalogCardId) : undefined;
      return {
        stageIndex: s.stageIndex,
        stage: s.stage,
        state: s.state === "block" ? "blocked" : "wanted",
        card: target ? identity(target, hereBand) : null,
      };
    });
    model = {
      mode: "start",
      copyId: copy.id,
      card: { ...identity(card, hereBand), locale: cardLocale },
      line: {
        lineId: null,
        binderId: hereBinder,
        binderName: hereBinder ? (binderName.get(hereBinder) ?? "A binder") : "No binder",
        bandKey: hereBand,
        bandDisplay: bandDisplay.get(hereBand) ?? hereBand,
        locale: cardLocale,
        filledBefore: 0,
        filledAfter: 1,
        total: stages.length,
      },
      stages,
    };
  } else {
    // ADD lays out the line with the card landing in its open slot; REPLACE the same, with the card there now
    // beside it (v3 section 5: the two cards for the one slot, side by side).
    const line = lines.find((l) => l.id === proposal.lineId);
    const lineSlots = slotsByLine.get(proposal.lineId) ?? [];
    const target = lineSlots.find((s) => s.id === proposal.slotId);
    if (!line || !target) {
      throw new Error("That line slot no longer exists — reload the screen and pick again.");
    }
    const current = target.copy_id ? copyById.get(target.copy_id) : undefined;
    const currentCard = current ? catalogById.get(current.catalog_card_id) : undefined;
    if (proposal.kind === "replace" && (target.state !== "filled" || !current || !currentCard)) {
      throw new Error("That slot is no longer filled — add this card to it instead of replacing.");
    }
    hereBinder = line.binder_id;
    hereBand = line.color_band;
    const stages: LinePopupStage[] = lineSlots.map((s) => {
      if (s.id === proposal.slotId) {
        return {
          stageIndex: s.stage_index,
          stage: s.stage,
          state: "incoming",
          card: identity(card, hereBand),
        };
      }
      const here = s.copy_id ? copyById.get(s.copy_id) : undefined;
      const hereCard = here ? catalogById.get(here.catalog_card_id) : undefined;
      if (s.state === "filled" && here && hereCard) {
        return {
          stageIndex: s.stage_index,
          stage: s.stage,
          state: "here",
          card: identity(hereCard, hereBand),
          copyId: here.id,
        };
      }
      const target = s.target_catalog_card_id
        ? catalogById.get(s.target_catalog_card_id)
        : undefined;
      return {
        stageIndex: s.stage_index,
        stage: s.stage,
        state: s.state === "block" ? "blocked" : "wanted",
        card: target ? identity(target, hereBand) : null,
      };
    });
    const filledBefore = lineSlots.filter((s) => s.state === "filled").length;
    const replacing = proposal.kind === "replace";
    model = {
      mode: replacing ? "replace" : "add",
      copyId: copy.id,
      card: { ...identity(card, hereBand), locale: cardLocale },
      line: {
        lineId: line.id,
        binderId: line.binder_id,
        binderName: line.binder_id ? (binderName.get(line.binder_id) ?? "A binder") : "No binder",
        bandKey: hereBand,
        bandDisplay: bandDisplay.get(hereBand) ?? hereBand,
        locale: localeOfLine(line.id),
        filledBefore,
        filledAfter: replacing ? filledBefore : filledBefore + 1,
        total: lineSlots.length,
      },
      stages,
      ...(replacing && current && currentCard
        ? {
            replace: {
              slotId: target.id,
              stageIndex: target.stage_index,
              current: {
                copyId: current.id,
                card: identity(currentCard, hereBand),
                where: whereIs(current),
              },
              incoming: { copyId: copy.id, card: identity(card, hereBand), where: whereIs(copy) },
              defaultKeep: proposal.defaultKeep,
              suggestedOutgoing: { kind: "bulk" as const },
            },
          }
        : {}),
    };
  }

  const existingLines: LinePopupExistingLine[] = (options?.existingLines ?? [])
    .filter((l) => l.lineId !== model.line.lineId)
    .map((l) => ({
      ...l,
      binderName: l.binderId ? (binderName.get(l.binderId) ?? "A binder") : "No binder",
      bandDisplay: bandDisplay.get(l.bandKey) ?? l.bandKey,
      joinSlotId: openSlotFor(l.lineId),
      sameHere: l.binderId === hereBinder && l.bandKey === hereBand && l.locale === cardLocale,
      face: faceOfLine(l.lineId, l.bandKey),
    }));
  return { ...model, existingLines };
}

function toSlotRecord(s: Row<"line_slot">): LineSlotRecord {
  return {
    id: s.id,
    stageIndex: s.stage_index,
    stage: s.stage,
    state: s.state as LineSlotRecord["state"],
    copyId: s.copy_id,
    dexId: null,
    targetCatalogCardId: s.target_catalog_card_id,
  };
}
