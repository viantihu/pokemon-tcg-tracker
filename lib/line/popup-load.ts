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
  buildChain,
  formOf,
  formsALine,
  generateSlots,
  lineFormOf,
  lineLocaleOf,
  testViability,
  type Band,
  type CardForm,
  type CatalogCard,
  type IncomingCard,
  type LineSlotRecord,
  type TypeColorMap,
  type Variant,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import { formFromStored, storedOr } from "@/lib/engine/form";
import { toCatalogCard, toOwnedCopy } from "@/lib/plan/adapt";
import { loadCatalogCached } from "@/lib/plan/catalog-cache";
import {
  binderBlockRepo,
  binderRepo,
  bulkUnitRepo,
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
  NOT_A_LINE,
  stageLabel,
  type LinePopupExistingLine,
  type LinePopupModel,
  type LinePopupStage,
  type LineProposal,
} from "./popup";
import type { CardIdentity } from "./types";
import { LINE_ROW_POCKETS } from "./popup";
import { stageOptionsFrom, stageSuggestion } from "./stage-options";
import { printingFromRow } from "./stage-options-load";

export async function loadLinePopupModel(
  db: DbClient,
  copyId: string,
  proposal: LineProposal,
  /**
   * UIL-121: the haul copies the SCREEN routes to this same line (the Haul Plan's proposals: an add to this line, or a
   * start of the same new line). Only those count as "coming" (the Senior BA: species and language cannot say which
   * line a card is for). Absent: nothing is coming, so every open stage is asked.
   */
  opts: { comingCopyIds?: readonly string[] } = {},
): Promise<LinePopupModel> {
  const [copy, catalogRows, typeMapRows, copies, lines, slots, binders, bands, boxes, blocks] =
    await Promise.all([
      copyRepo.getByPk(db, copyId),
      loadCatalogCached(db),
      typeColorMapRepo.list(db),
      // Every row, paged: each of these passes the server's 1,000-row cap with her collection, and `list` throws there.
      copyRepo.listAll(db),
      evolutionLineRepo.listAll(db),
      lineSlotRepo.listAll(db),
      binderRepo.list(db),
      colorBandRepo.listOrdered(db),
      bulkUnitRepo.views(db),
      binderBlockRepo.listAll(db),
    ]);
  /** UIL-130: her boxes by id, for where a bulk card is now. */
  const boxName = new Map(boxes.map((u) => [u.id, u.name]));
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
    if (c.role === "bulk" || !c.binder_id)
      return (c.bulk_unit_id && boxName.get(c.bulk_unit_id)) || "Bulk box";
    const half = c.binder_half === "back" ? "Back" : c.binder_half === "front" ? "Front" : null;
    return [
      binderName.get(c.binder_id) ?? "A binder",
      half,
      c.color_band ? (bandDisplay.get(c.color_band) ?? c.color_band) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  /**
   * The line a card fills now, named as the Lines page names it ("CHARMANDER LINE"), and the stage it would leave
   * empty. Only when the slot really holds this copy (the pointer and the slot agree, UIL-087).
   */
  const leavesOf = (c: Row<"copy">): { lineName: string; stage: string } | null => {
    if (!c.line_slot_id) return null;
    const slot = slots.find((s) => s.id === c.line_slot_id);
    if (!slot || slot.copy_id !== c.id) return null;
    const named = (slotsByLine.get(slot.line_id) ?? [])
      .map((s) => {
        const id = s.copy_id ? cardOfCopy(s.copy_id) : s.target_catalog_card_id;
        return id ? catalogById.get(id)?.name : undefined;
      })
      .find((n): n is string => !!n);
    return {
      lineName: named ? `${named.toUpperCase()} LINE` : "EVOLUTION LINE",
      stage: stageLabel(slot.stage),
    };
  };

  const cardLocale = localeOfId(card.tcgdexId);
  const incoming: IncomingCard = {
    id: copy.id,
    card,
    variant: (copy.variant as Variant) ?? "normal",
  };

  let model: Omit<LinePopupModel, "existingLines">;
  let hereBinder: string | null;
  let hereBand: string;
  /** The line's form (UIL-133): a new line takes the card's; an existing one, what it holds or chases. */
  let lineForm: CardForm = null;

  /** UIL-121: a stage she may decide carries its species and its suggestion (shown, never selected). */
  const decidableIn = (dexId: number, locale: string, bandKey: string) => ({
    dexId,
    suggestion: stageSuggestion(
      stageOptionsFrom(
        catalogRows
          .filter((r) => r.dex_id.includes(dexId))
          .map((r) => printingFromRow(r, typeColorMap)),
        { locale: locale as typeof cardLocale, bandKey, form: lineForm },
      ),
    ),
  });
  /** A haul copy the screen routes to this line, of that species and language (its stage is not asked yet). */
  const routedHere = new Set(opts.comingCopyIds ?? []);
  const waitingFor = (dexId: number, locale: string) =>
    copies.find(
      (c) =>
        c.id !== copy.id &&
        routedHere.has(c.id) &&
        c.role === "haul" &&
        (catalogById.get(c.catalog_card_id)?.dexId ?? []).includes(dexId) &&
        localeOfId(c.catalog_card_id) === locale,
    );

  if (proposal.kind === "start") {
    // A species with no evolutions is never a line (Karvi, 2026-09-27): no line to lay out.
    if (!formsALine(card, catalog)) throw new Error(NOT_A_LINE);
    const general = binders.filter((b) => b.type === "general");
    hereBinder = proposal.binderId ?? general[0]?.id ?? null;
    hereBand = proposal.band;
    lineForm = formOf(card, catalog);
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
    const decidable = (dexId: number) => decidableIn(dexId, cardLocale, hereBand);
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
      const leaves = pullRow ? leavesOf(pullRow) : null;
      if (pullRow && pullCard) {
        return {
          stageIndex: s.stageIndex,
          stage: s.stage,
          state: "pullable",
          card: identity(pullCard, hereBand),
          // Left unticked, the stage is unfilled and hers to decide.
          ...decidable(s.dexId),
          pull: {
            copyId: pullRow.id,
            fromLabel: whereIs(pullRow),
            ...(leaves ? { leaves } : {}),
          },
        };
      }
      // Its card still waiting in THIS haul: not asked about now; it joins when she places that card (Karvi's ruling:
      // she is asked about a missing stage only after the last card she has for the line).
      const waiting = waitingFor(s.dexId, cardLocale);
      const waitingCard = waiting ? catalogById.get(waiting.catalog_card_id) : undefined;
      if (waiting && waitingCard) {
        return {
          stageIndex: s.stageIndex,
          stage: s.stage,
          state: "coming",
          card: identity(waitingCard, hereBand),
          dexId: s.dexId,
          coming: { copyId: waiting.id },
        };
      }
      // Nothing is chosen for her: the stage shows no card until she decides (the suggestion rides alongside).
      return {
        stageIndex: s.stageIndex,
        stage: s.stage,
        state: "wanted",
        card: null,
        ...decidable(s.dexId),
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
        form: lineForm,
        filledBefore: 0,
        filledAfter: 1,
        total: stages.length,
        status: null,
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
    lineForm = storedOr(line.form, () =>
      lineFormOf(
        [...lineSlots]
          .sort((a, b) => a.stage_index - b.stage_index)
          .map((s) => {
            const id = s.copy_id
              ? cardOfCopy(s.copy_id)
              : s.stage_choice === "chase"
                ? s.target_catalog_card_id
                : null;
            return id ? catalogById.get(id) : undefined;
          }),
        catalog,
      ),
    );
    const chain = testViability(incoming, [], catalog, typeColorMap).chain;
    const lineLocale = localeOfLine(line.id);
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
      // UIL-121: a card shows on an open stage only when she is chasing it. A card the engine stored before her
      // choices existed is never shown as hers (the Senior BA's condition 2).
      const choice = (s.stage_choice ?? null) as LinePopupStage["choice"];
      const target =
        choice === "chase" && s.target_catalog_card_id
          ? catalogById.get(s.target_catalog_card_id)
          : undefined;
      // An open stage she has not decided: its card still in this haul (not asked yet), or hers to decide now.
      const node = chain[s.stage_index];
      if (s.state === "placeholder" && choice === null && node) {
        const waiting = waitingFor(node.dexId, lineLocale);
        const waitingCard = waiting ? catalogById.get(waiting.catalog_card_id) : undefined;
        if (waiting && waitingCard) {
          return {
            stageIndex: s.stage_index,
            stage: s.stage,
            state: "coming",
            card: identity(waitingCard, hereBand),
            dexId: node.dexId,
            choice,
            coming: { copyId: waiting.id },
          };
        }
        return {
          stageIndex: s.stage_index,
          stage: s.stage,
          state: "wanted",
          card: null,
          choice,
          ...decidableIn(node.dexId, lineLocale, hereBand),
        };
      }
      return {
        stageIndex: s.stage_index,
        stage: s.stage,
        state: s.state === "block" ? "blocked" : "wanted",
        card: target ? identity(target, hereBand) : null,
        choice,
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
        form: lineForm,
        filledBefore,
        filledAfter: replacing ? filledBefore : filledBefore + 1,
        total: lineSlots.length,
        status: line.status,
        thirdPocketOpen: lineSlots.length < LINE_ROW_POCKETS && line.extra_pocket == null,
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
      // UIL-130: an Add into a stage she filled with a spare card takes its pocket; the spare card goes back.
      ...(!replacing && target.state === "block"
        ? {
            returning: blocks
              .filter((b) => b.line_slot_id === target.id && b.copy_id)
              .map((b) => {
                const spare = copyById.get(b.copy_id!);
                const spareCard = spare ? catalogById.get(spare.catalog_card_id) : undefined;
                return {
                  copyId: b.copy_id!,
                  name: spareCard?.name ?? "The spare card",
                  homeBoxId: spare?.bulk_unit_id ?? null,
                };
              }),
          }
        : {}),
      boxes,
    };
  }

  const existingLines = familyLinesFrom(
    { card, lines, slotsByLine, catalog, catalogById, typeColorMap, cardOfCopy, identity },
    { binderName, bandDisplay },
    { binderId: hereBinder, band: hereBand, locale: cardLocale },
    model.line.lineId,
  );
  // Every stage names its species (the family's chain, by stage), so a screen can tell which of its waiting cards
  // this line could still take: the Haul Plan's "· next" and step-through (UIL-120; one predicate, sameLineWaiting).
  const chain = buildChain(incoming, catalog);
  const stages = model.stages.map((st) =>
    st.dexId === undefined && chain[st.stageIndex]
      ? { ...st, dexId: chain[st.stageIndex].dexId }
      : st,
  );
  return { ...model, stages, existingLines };
}

/**
 * UIL-096 for a screen with no single moving copy (Backfill's confirm sheet, UIL-117 PR 5): every line the SEED
 * card's family already has, anywhere, from fresh state, each with the open slot that card's species would take
 * there, its tile image, and whether it is in this binder and band. Read only; the same list the popup's START shows.
 */
export async function loadFamilyLines(
  db: DbClient,
  seedTcgdexId: string,
  here: { binderId: string | null; band: string },
): Promise<LinePopupExistingLine[]> {
  const [catalogRows, typeMapRows, copies, lines, slots, binders, bands] = await Promise.all([
    loadCatalogCached(db),
    typeColorMapRepo.list(db),
    copyRepo.listAll(db),
    evolutionLineRepo.listAll(db),
    lineSlotRepo.listAll(db),
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
  ]);
  const catalog = catalogRows.map(toCatalogCard);
  const catalogById = new Map(catalog.map((c) => [c.tcgdexId, c]));
  const card = catalogById.get(seedTcgdexId);
  if (!card) throw new Error("That card's catalog entry is missing — reload and try again.");
  const imageUrlById = new Map(catalogRows.map((r) => [r.tcgdex_id, r.image_url]));
  const typeColorMap: TypeColorMap = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;
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
  return familyLinesFrom(
    {
      card,
      lines,
      slotsByLine,
      catalog,
      catalogById,
      typeColorMap,
      cardOfCopy: (id) => copyById.get(id)?.catalog_card_id ?? null,
      identity,
    },
    {
      binderName: new Map(binders.map((b) => [b.id, b.name])),
      bandDisplay: new Map(bands.map((b) => [b.band, b.display_name])),
    },
    { ...here, locale: localeOfId(card.tcgdexId) },
    null,
  );
}

/** The one derivation behind both: pure over state already read. */
function familyLinesFrom(
  st: {
    card: CatalogCard;
    lines: Row<"evolution_line">[];
    slotsByLine: Map<string, Row<"line_slot">[]>;
    catalog: CatalogCard[];
    catalogById: Map<string, CatalogCard>;
    typeColorMap: TypeColorMap;
    cardOfCopy: (copyId: string) => string | null;
    identity: (cc: CatalogCard, bandKey: string) => CardIdentity;
  },
  names: { binderName: Map<string, string>; bandDisplay: Map<string, string> },
  here: { binderId: string | null; band: string; locale: string },
  excludeLineId: string | null,
): LinePopupExistingLine[] {
  const { card, slotsByLine, catalogById, cardOfCopy, identity } = st;
  // UIL-096: every line this family has, anywhere; each with the open slot THIS card's species would take there.
  const index = buildLineJoinIndex(
    st.lines.map((l) => ({
      id: l.id,
      rootDexId: l.root_dex_id,
      colorBand: l.color_band,
      binderId: l.binder_id,
      form: formFromStored(l.form),
    })),
    slotsByLine,
    st.catalog,
    cardOfCopy,
  );
  const options = joinOptionsFor(card, index, st.typeColorMap, st.catalog);
  // The open slot this card takes there, by the join index: the ONE rule the line builder holds a join to (`stageFit`).
  // It used to need a target naming the species, which an undecided stage has not had since UIL-121, so a line with
  // room for the card offered no "Add" and she could start a second one without meaning to.
  const openSlotFor = (lineId: string): string | null =>
    options?.joinCandidates.find((c) => c.lineId === lineId)?.slotId ?? null;
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
  // A line where she chases this exact printing first, then the lines of its own form (UIL-133, the Senior BA's ruling).
  const chasesThis = (lineId: string) =>
    options?.joinCandidates.some(
      (c) => c.lineId === lineId && c.chasedCatalogCardId === card.tcgdexId,
    ) ?? false;
  const rank = (l: { lineId: string; sameForm?: boolean }) =>
    chasesThis(l.lineId) ? 0 : l.sameForm === false ? 2 : 1;
  return (options?.existingLines ?? [])
    .filter((l) => l.lineId !== excludeLineId)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map(({ l }) => ({
      ...l,
      binderName: l.binderId ? (names.binderName.get(l.binderId) ?? "A binder") : "No binder",
      bandDisplay: names.bandDisplay.get(l.bandKey) ?? l.bandKey,
      joinSlotId: openSlotFor(l.lineId),
      sameHere: l.binderId === here.binderId && l.bandKey === here.band && l.locale === here.locale,
      face: faceOfLine(l.lineId, l.bandKey),
    }));
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
