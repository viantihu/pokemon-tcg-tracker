/**
 * Lines' "Choose" (UIL-121 A2c): what the popup for an EXISTING line's open stages shows, read from fresh state.
 * Each open stage carries its species, its suggestion (shown, never selected) and what she has chosen for it so far;
 * a complete line shorter than three pockets carries its third pocket. Her choice is checked again on the server when
 * she confirms (./decide-stages).
 */

import {
  buildChain,
  band,
  lineFormOf,
  type CardForm,
  type CatalogCard,
  type TypeColorMap,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import { storedOr } from "@/lib/engine/form";
import { toCatalogCard } from "@/lib/plan/adapt";
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
  type BulkUnitView,
  type DbClient,
} from "@/lib/repo";
import type { Locale } from "@/lib/sync/types";
import {
  LINE_ROW_POCKETS,
  type LinePopupStage,
  type StageDecision,
  type ThirdPocketChoice,
} from "./popup";
import { stageOptionsFrom, stageSuggestion } from "./stage-options";
import { printingFromRow } from "./stage-options-load";
import type { CardIdentity } from "./types";

export interface LineStagesModel {
  line: {
    lineId: string;
    name: string;
    binderName: string;
    bandKey: string;
    bandDisplay: string;
    locale: Locale;
    /** The line's form (UIL-133): what its stages suggest first. */
    form?: CardForm;
    total: number;
  };
  /** Every stage, in order: the cards she has ("here") and the open ones she decides. */
  stages: LinePopupStage[];
  /** What she has chosen so far for each open stage she decided, by stage index. */
  current: Record<number, StageDecision>;
  /** A complete line shorter than three pockets: its third pocket, and what fills it now (null: not decided). */
  thirdPocket: { current: ThirdPocketChoice | null } | null;
  /**
   * UIL-130: every spare card filling one of this line's pockets now, by copy id. A choice that takes one out sends
   * it back to its home box, or to a box she picks when that one is full.
   */
  spares?: Record<string, { name: string; homeBoxId: string | null }>;
  /** Her bulk boxes, for a returning spare card's box. */
  boxes?: BulkUnitView[];
}

export async function loadLineStagesModel(db: DbClient, lineId: string): Promise<LineStagesModel> {
  const [line, slots, blocks, catalogRows, typeMapRows, copies, binders, bands, boxes] =
    await Promise.all([
      evolutionLineRepo.getByPk(db, lineId),
      lineSlotRepo.listByLine(db, lineId),
      binderBlockRepo.listAll(db),
      loadCatalogCached(db),
      typeColorMapRepo.list(db),
      // Paged: her copies pass the server's 1,000-row cap, where `list` throws.
      copyRepo.listAll(db),
      binderRepo.list(db),
      colorBandRepo.listOrdered(db),
      bulkUnitRepo.views(db),
    ]);
  if (!line) throw new Error("That line is no longer there. Reload and choose again.");
  const map: TypeColorMap = {};
  for (const t of typeMapRows) map[t.card_type] = t.band;
  const catalog: CatalogCard[] = catalogRows.map(toCatalogCard);
  const byId = new Map(catalog.map((c) => [c.tcgdexId, c]));
  const imageOf = new Map(catalogRows.map((r) => [r.tcgdex_id, r.image_url]));
  const copyById = new Map(copies.map((c) => [c.id, c]));
  const ordered = [...slots].sort((a, b) => a.stage_index - b.stage_index);
  const identity = (cc: CatalogCard): CardIdentity => ({
    tcgdexId: cc.tcgdexId,
    name: cc.name,
    setId: cc.setId,
    setName: cc.setName ?? null,
    localId: cc.localId,
    setCardCountOfficial: cc.setCardCountOfficial ?? null,
    imageUrl: imageOf.get(cc.tcgdexId) ?? null,
    bandKey: band(cc, map),
  });
  const anchorId =
    ordered
      .map((s) => (s.copy_id ? copyById.get(s.copy_id)?.catalog_card_id : null))
      .find(Boolean) ?? catalog.find((c) => c.dexId.includes(line.root_dex_id))?.tcgdexId;
  const anchor = anchorId ? byId.get(anchorId) : undefined;
  const chain = anchor ? buildChain({ id: "line", card: anchor, variant: "normal" }, catalog) : [];
  const locale = (anchor ? localeOfId(anchor.tcgdexId) : "en") as Locale;
  // Its form (UIL-133): stored when it was made (0038), else from what it holds or chases.
  const form = storedOr(line.form, () =>
    lineFormOf(
      ordered.map((s) => {
        const id = s.copy_id
          ? copyById.get(s.copy_id)?.catalog_card_id
          : s.stage_choice === "chase"
            ? s.target_catalog_card_id
            : null;
        return id ? byId.get(id) : undefined;
      }),
      catalog,
    ),
  );
  const lineBlocks = blocks.filter((b) => b.line_id === line.id);

  const current: Record<number, StageDecision> = {};
  const stages: LinePopupStage[] = ordered.map((s) => {
    const node = chain[s.stage_index];
    if (s.state === "filled") {
      const cc = s.copy_id ? byId.get(copyById.get(s.copy_id)?.catalog_card_id ?? "") : undefined;
      return {
        stageIndex: s.stage_index,
        stage: s.stage,
        state: "here",
        card: cc ? identity(cc) : null,
        ...(s.copy_id ? { copyId: s.copy_id } : {}),
      };
    }
    const choice = (s.stage_choice ?? null) as LinePopupStage["choice"];
    if (choice === "chase" && s.target_catalog_card_id) {
      current[s.stage_index] = { kind: "chase", catalogCardId: s.target_catalog_card_id };
    } else if (choice === "empty") {
      current[s.stage_index] = { kind: "empty" };
    } else if (choice === "filler") {
      const b = lineBlocks.find((x) => x.line_slot_id === s.id);
      current[s.stage_index] = {
        kind: "filler",
        filler: b?.copy_id ? { material: "card", copyId: b.copy_id } : { material: "energy" },
      };
    }
    const target =
      choice === "chase" && s.target_catalog_card_id
        ? byId.get(s.target_catalog_card_id)
        : undefined;
    return {
      stageIndex: s.stage_index,
      stage: s.stage,
      state: s.state === "block" ? "blocked" : "wanted",
      card: target ? identity(target) : null,
      choice,
      ...(node
        ? {
            dexId: node.dexId,
            suggestion: stageSuggestion(
              stageOptionsFrom(
                catalogRows
                  .filter((r) => r.dex_id.includes(node.dexId))
                  .map((r) => printingFromRow(r, map)),
                { locale, bandKey: line.color_band, form },
              ),
            ),
          }
        : {}),
    };
  });

  const complete = ordered.length > 0 && ordered.every((s) => s.state === "filled");
  const pocketBlock = lineBlocks.find(
    (b) => b.line_slot_id === null && b.purpose === "line-filler",
  );
  const extra = line.extra_pocket;
  const thirdPocket =
    complete && ordered.length < LINE_ROW_POCKETS
      ? {
          current:
            extra === "energy"
              ? ({ material: "energy" } as const)
              : extra === "empty"
                ? ({ material: "empty" } as const)
                : extra === "card" && pocketBlock?.copy_id
                  ? ({ material: "card", copyId: pocketBlock.copy_id } as const)
                  : null,
        }
      : null;

  const top = [...stages].reverse().find((s) => s.card)?.card?.name ?? anchor?.name ?? "Line";
  const binderName = line.binder_id
    ? (binders.find((b) => b.id === line.binder_id)?.name ?? "A binder")
    : "No binder";
  return {
    line: {
      lineId: line.id,
      name: top,
      binderName,
      bandKey: line.color_band,
      bandDisplay: bands.find((b) => b.band === line.color_band)?.display_name ?? line.color_band,
      locale,
      form,
      total: ordered.length,
    },
    stages,
    current,
    thirdPocket,
    spares: Object.fromEntries(
      lineBlocks
        .filter((b) => b.copy_id)
        .map((b) => {
          const spare = copyById.get(b.copy_id!);
          const cc = spare ? byId.get(spare.catalog_card_id) : undefined;
          return [
            b.copy_id!,
            { name: cc?.name ?? "The spare card", homeBoxId: spare?.bulk_unit_id ?? null },
          ];
        }),
    ),
    boxes,
  };
}
