/**
 * Load persisted line state and assemble the M7 screen model (dev-spec §5 M7; §2 module boundary).
 *
 * All the I/O for the line screen lives here so the view/decision/move logic stays pure and the
 * server actions stay thin. Reads go through `lib/repo`; catalog facts and chain reconstruction use
 * the pure M3 engine. A line_slot stores no species reference for a block/placeholder, so the chain
 * is rebuilt from the line's `root_dex_id` against the catalog (system-design §6 walk) and the
 * ordered slots are mapped onto it — that is how a blocked slot still reads a species name.
 *
 * PERF (phase-1, mirrors lib/plan/context.ts): the whole catalog mirror is loaded for fact-counting
 * and alternate ranking. Trivial on the seeded local mirror; a production build should scope the
 * query to the lines' dexId neighbourhoods. Flagged, not premature-optimised. SERVER ONLY.
 */

import {
  band as bandOf,
  buildChain,
  rankAlternates,
  type Band,
  type CatalogCard,
  type IncomingCard,
  type TypeColorMap,
} from "@/lib/engine";
import { toCatalogCard } from "@/lib/plan/adapt";
import {
  binderBlockRepo,
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  wishlistItemRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import {
  deriveAllDecisions,
  type DecisionLineInput,
  type DerivedDecision,
  type StageFacts,
} from "./decisions";
import { buildLineView, type SlotInput } from "./view";
import type { CardIdentity, LineScreenData, LineView, MoveOptions, WishlistOption } from "./types";

/** A single per-slot resolution feeding both the view model and the decision model. */
interface ResolvedSlot {
  slotId: string;
  stageIndex: number;
  stage: string;
  state: "filled" | "placeholder" | "block";
  dexId: number | null;
  speciesName: string | null;
  card: CardIdentity | null;
  copyId: string | null;
  variant: string | null;
  copyShelved: boolean;
  priceMarket: number | null;
  willLiveInSpecialty: boolean;
  alternates: WishlistOption[];
  requiredType: string | null;
  facts: StageFacts;
  wedgeLabel: string | null;
}

const EMPTY_FACTS: StageFacts = {
  totalPrintings: 0,
  sameBandTotal: 0,
  sameBandStandard: 0,
  sameBandSpecialty: 0,
  otherBandExample: null,
  cheapestSameBand: null,
  chosenLocalId: null,
};

/** Everything the loader assembles: view lines + the decisions (cards + server-side resolutions). */
export interface ScreenModel {
  lines: LineView[];
  derived: DerivedDecision[];
  moveOptions: MoveOptions;
}

export async function buildScreenModel(db: DbClient): Promise<ScreenModel> {
  const [
    lineRows,
    slotRows,
    copyRows,
    catalogRows,
    wishlistRows,
    binderRows,
    collectionRows,
    bandRows,
    typeMapRows,
    blockRows,
  ] = await Promise.all([
    evolutionLineRepo.listAll(db),
    lineSlotRepo.listAll(db),
    copyRepo.listAll(db),
    catalogCardRepo.listAll(db),
    wishlistItemRepo.listAll(db),
    binderRepo.list(db),
    collectionRepo.list(db),
    colorBandRepo.listOrdered(db),
    typeColorMapRepo.list(db),
    binderBlockRepo.list(db),
  ]);

  const catalogById = new Map<string, CatalogCard>();
  for (const r of catalogRows) catalogById.set(r.tcgdex_id, toCatalogCard(r));
  const catalog = [...catalogById.values()];

  const copyById = new Map<string, Row<"copy">>();
  for (const r of copyRows) copyById.set(r.id, r);

  const typeColorMap: TypeColorMap = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;

  const binderNameById = new Map<string, string>(binderRows.map((b) => [b.id, b.name]));
  const bandDisplayByKey = new Map<string, string>(bandRows.map((b) => [b.band, b.display_name]));

  // Open wishlist items by slot (carries the stored willLiveInSpecialty + required fields).
  const wishBySlot = new Map<string, Row<"wishlist_item">>();
  for (const w of wishlistRows) {
    if (w.resolved_at === null && w.line_slot_id) wishBySlot.set(w.line_slot_id, w);
  }

  // Repurposed-duplicate wedge label per line (system-design §4 BinderBlock).
  const wedgeByLine = new Map<string, string>();
  for (const bl of blockRows) {
    if (bl.material !== "repurposedDuplicate" || !bl.line_id) continue;
    const copy = bl.copy_id ? copyById.get(bl.copy_id) : null;
    const cc = copy ? catalogById.get(copy.catalog_card_id) : null;
    wedgeByLine.set(
      bl.line_id,
      cc
        ? `WEDGED: ${cc.name.toUpperCase()}${cc.localId ? ` · ${cc.localId}` : ""}`
        : "WEDGED DUPLICATE",
    );
  }

  // Collections claim dexIds (collection-vs-line detection).
  const claimedDexIds = new Set<number>();
  for (const c of collectionRows) {
    for (const id of c.target_catalog_card_ids ?? []) {
      const cc = catalogById.get(id);
      if (cc?.dexId[0] !== undefined) claimedDexIds.add(cc.dexId[0]);
    }
  }

  const slotsByLine = new Map<string, Row<"line_slot">[]>();
  for (const s of slotRows) {
    const list = slotsByLine.get(s.line_id) ?? [];
    list.push(s);
    slotsByLine.set(s.line_id, list);
  }

  // imageUrl lives on the catalog ROW, not the engine CatalogCard, so resolve it from the row.
  const imageUrlById = new Map<string, string | null>(
    catalogRows.map((r) => [r.tcgdex_id, r.image_url]),
  );
  const identity = (cc: CatalogCard, bandKey: string): CardIdentity => ({
    tcgdexId: cc.tcgdexId,
    name: cc.name,
    setId: cc.setId,
    setName: cc.setName ?? null,
    localId: cc.localId,
    imageUrl: imageUrlById.get(cc.tcgdexId) ?? null,
    bandKey,
  });

  function stageFacts(dexId: number | null, bandKey: string): StageFacts {
    if (dexId === null) return EMPTY_FACTS;
    const phys = catalog.filter((c) => !c.isDigitalOnly && c.dexId.includes(dexId));
    const sameBand = phys.filter((c) => bandOf(c, typeColorMap) === bandKey);
    const std = sameBand.filter((c) => c.cardClass === "standard");
    const spec = sameBand.filter((c) => c.cardClass === "specialty");
    const other = phys.find((c) => bandOf(c, typeColorMap) !== bandKey);
    const alt = rankAlternates(dexId, bandKey as Band, catalog, typeColorMap);
    const chosen = alt.chosenCatalogCardId ? catalogById.get(alt.chosenCatalogCardId) : null;
    return {
      totalPrintings: phys.length,
      sameBandTotal: sameBand.length,
      sameBandStandard: std.length,
      sameBandSpecialty: spec.length,
      otherBandExample: other
        ? `${other.types[0] ?? "?"} · ${other.localId ?? other.tcgdexId}`
        : null,
      cheapestSameBand: chosen?.priceMarket ?? null,
      chosenLocalId: chosen?.localId ?? null,
    };
  }

  function altOptions(dexId: number | null, bandKey: string): WishlistOption[] {
    if (dexId === null) return [];
    const alt = rankAlternates(dexId, bandKey as Band, catalog, typeColorMap);
    const ids = [alt.chosenCatalogCardId, ...alt.alternateCatalogCardIds].filter((x): x is string =>
      Boolean(x),
    );
    return ids.map((id, i) => {
      const cc = catalogById.get(id)!;
      return {
        tcgdexId: cc.tcgdexId,
        name: cc.name,
        localId: cc.localId,
        setId: cc.setId,
        imageUrl: imageUrlById.get(cc.tcgdexId) ?? null,
        bandKey,
        priceMarket: cc.priceMarket ?? null,
        badge: i === 0 ? "CHEAPEST" : alt.willLiveInSpecialty ? "SPECIALTY" : "ALT",
        willLiveInSpecialty: alt.willLiveInSpecialty,
      };
    });
  }

  const lineViews: LineView[] = [];
  const decisionInputs: DecisionLineInput[] = [];

  for (const line of lineRows) {
    const bandKey = line.color_band;
    const slots = (slotsByLine.get(line.id) ?? [])
      .slice()
      .sort((a, b) => a.stage_index - b.stage_index);

    // Rebuild the chain from the root to name every slot (incl. blocks with no stored species).
    const seed = catalog.find((c) => !c.isDigitalOnly && c.dexId.includes(line.root_dex_id));
    const chain = seed
      ? buildChain({ id: "r", card: seed, variant: "normal" } as IncomingCard, catalog)
      : [];

    const resolved: ResolvedSlot[] = slots.map((s) => {
      const node = chain[s.stage_index];
      let dexId: number | null = node?.dexId ?? null;
      let speciesName: string | null = node?.name ?? null;
      let card: CardIdentity | null = null;
      let copyId: string | null = null;
      let variant: string | null = null;
      let copyShelved = false;
      let priceMarket: number | null = null;
      let willSpecialty = false;
      let alternates: WishlistOption[] = [];
      let requiredType: string | null = null;

      if (s.state === "filled" && s.copy_id) {
        const copy = copyById.get(s.copy_id);
        const cc = copy ? catalogById.get(copy.catalog_card_id) : null;
        if (cc) {
          card = identity(cc, bandKey);
          dexId = dexId ?? cc.dexId[0] ?? null;
          speciesName = speciesName ?? cc.name;
          requiredType = cc.types[0] ?? null;
        }
        copyId = s.copy_id;
        variant = copy?.variant ?? null;
        copyShelved = copy?.role === "shelved";
      } else if (s.state === "placeholder") {
        const targetCc = s.target_catalog_card_id
          ? catalogById.get(s.target_catalog_card_id)
          : null;
        const alt = altOptions(dexId, bandKey);
        alternates = alt;
        const chosen = targetCc ?? (alt[0] ? catalogById.get(alt[0].tcgdexId) : null);
        if (chosen) {
          card = identity(chosen, bandKey);
          dexId = dexId ?? chosen.dexId[0] ?? null;
          speciesName = speciesName ?? chosen.name;
          priceMarket = chosen.priceMarket ?? null;
          requiredType = chosen.types[0] ?? null;
        }
        const wish = wishBySlot.get(s.id);
        willSpecialty = wish?.will_live_in_specialty ?? alt[0]?.willLiveInSpecialty ?? false;
        requiredType = wish?.required_type ?? requiredType;
      } else if (s.state === "block") {
        // Blocks show a hatched void, not art; keep only the species name for evidence.
        card = null;
      }

      const facts = s.state === "filled" ? EMPTY_FACTS : stageFacts(dexId, bandKey);
      const wedgeLabel =
        s.state === "block"
          ? line.status === "terminated"
            ? "NO PAGE, SO NO POCKET."
            : (wedgeByLine.get(line.id) ?? "WEDGE A DUPLICATE HERE")
          : null;

      return {
        slotId: s.id,
        stageIndex: s.stage_index,
        stage: s.stage,
        state: s.state as ResolvedSlot["state"],
        dexId,
        speciesName,
        card,
        copyId,
        variant,
        copyShelved,
        priceMarket,
        willLiveInSpecialty: willSpecialty,
        alternates,
        requiredType,
        facts,
        wedgeLabel,
      };
    });

    const binderName = line.binder_id ? (binderNameById.get(line.binder_id) ?? "Binder") : "Binder";

    lineViews.push(
      buildLineView({
        lineId: line.id,
        rootDexId: line.root_dex_id,
        bandKey,
        binderId: line.binder_id,
        binderLabel: `${binderName} · BACK`,
        status: line.status as LineView["status"],
        slots: resolved.map((r): SlotInput => ({
          slotId: r.slotId,
          stageIndex: r.stageIndex,
          stage: r.stage,
          state: r.state,
          card: r.card,
          copyId: r.copyId,
          variant: r.variant,
          copyShelved: r.copyShelved,
          priceMarket: r.priceMarket,
          willLiveInSpecialty: r.willLiveInSpecialty,
          alternates: r.alternates.map((a) => ({
            tcgdexId: a.tcgdexId,
            name: a.name,
            localId: a.localId,
            priceMarket: a.priceMarket,
          })),
          note: null,
          wedgeLabel: r.wedgeLabel,
        })),
      }),
    );

    decisionInputs.push({
      lineId: line.id,
      rootDexId: line.root_dex_id,
      bandKey,
      bandDisplay: bandDisplayByKey.get(bandKey) ?? bandKey,
      status: line.status as DecisionLineInput["status"],
      binderLabel: `${binderName} · BACK`,
      claimedDexIds,
      slots: resolved.map((r) => ({
        slotId: r.slotId,
        stageIndex: r.stageIndex,
        stage: r.stage,
        state: r.state,
        dexId: r.dexId,
        speciesName: r.speciesName,
        card: r.card,
        priceMarket: r.priceMarket,
        willLiveInSpecialty: r.willLiveInSpecialty,
        alternates: r.alternates,
        facts: r.facts,
        requiredType: r.requiredType,
      })),
    });
  }

  const specialtyBinderIds = new Set(
    binderRows.filter((b) => b.type === "specialty").map((b) => b.id),
  );
  const collectionsByBinder: MoveOptions["collectionsByBinder"] = {};
  for (const c of collectionRows) {
    for (const bid of c.current_binder_ids ?? []) {
      if (!specialtyBinderIds.has(bid)) continue;
      (collectionsByBinder[bid] ??= []).push({ id: c.id, name: c.name });
    }
  }

  const moveOptions: MoveOptions = {
    binders: binderRows.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type === "specialty" ? "specialty" : "general",
    })),
    collectionsByBinder,
    bands: bandRows.map((b) => ({ key: b.band, display: b.display_name })),
  };

  return { lines: lineViews, derived: deriveAllDecisions(decisionInputs), moveOptions };
}

/**
 * Just the move-panel options (binders, their collections, ordered bands). Lightweight loader for
 * surfaces that only need the picker — e.g. the plan spotlight's placement override — without the
 * full line + decision model.
 */
export async function loadMoveOptions(db: DbClient): Promise<MoveOptions> {
  const [binderRows, collectionRows, bandRows] = await Promise.all([
    binderRepo.list(db),
    collectionRepo.list(db),
    colorBandRepo.listOrdered(db),
  ]);
  const specialtyBinderIds = new Set(
    binderRows.filter((b) => b.type === "specialty").map((b) => b.id),
  );
  const collectionsByBinder: MoveOptions["collectionsByBinder"] = {};
  for (const c of collectionRows) {
    for (const bid of c.current_binder_ids ?? []) {
      if (!specialtyBinderIds.has(bid)) continue;
      (collectionsByBinder[bid] ??= []).push({ id: c.id, name: c.name });
    }
  }
  return {
    binders: binderRows.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type === "specialty" ? "specialty" : "general",
    })),
    collectionsByBinder,
    bands: bandRows.map((b) => ({ key: b.band, display: b.display_name })),
  };
}

/** The client-facing screen data (decisions flattened to their cards). */
export async function loadLineScreen(db: DbClient): Promise<LineScreenData> {
  const model = await buildScreenModel(db);
  return {
    lines: model.lines,
    decisions: model.derived.map((d) => d.card),
    moveOptions: model.moveOptions,
  };
}
