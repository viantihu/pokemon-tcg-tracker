/**
 * UIL-084, point 6 — when TWO lines want the same species, which one does the cascade fill?
 *
 * `existingLineSlot` matches by species alone (UIL-065, deliberately) and used to take the FIRST match
 * in `ctx.lines`. That list is read with a plain `select *` and no ORDER BY, so the answer was whatever
 * order the rows happened to arrive in — different run to run for the same data. Two lines for one
 * family became ordinary the moment line uniqueness went per binder (she is filling a second binder),
 * though the ambiguity was already reachable before that through two lines of one family in DIFFERENT
 * BANDS, which the app has always allowed.
 *
 * The order, the Senior BA's call: a line whose band matches the card's own natural band wins; then one
 * with an OPEN slot for this stage; then the oldest. "Oldest" is a CONTRACT on the caller —
 * `loadPlanContext` sorts by (created_at, id) — because `EvolutionLine` carries no timestamp and
 * widening it would touch every fixture in the suite. `tests/plan/line-order-contract.test.ts` pins the
 * sort itself against a real database; this file pins the choice given an ordered list.
 *
 * Every case here is built so that the FIRST line in the list is the WRONG answer — otherwise the old
 * take-the-first behaviour would pass unchanged.
 */
import { describe, expect, it } from "vitest";
import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import type {
  Binder,
  CatalogCard,
  EvolutionLine,
  IncomingCard,
  LineSlotRecord,
} from "@/lib/engine/types";

const DRATINI_DEX = 147;
const DRAGONAIR_DEX = 148;
/** Dragon's natural band is olive; "red" is a band she picked by hand for a line. */
const MAP = { Dragon: "olive" };

const dratini: CatalogCard = {
  tcgdexId: "dratini-147",
  name: "Dratini",
  dexId: [DRATINI_DEX],
  setId: "b2",
  setName: "Base Set 2",
  localId: "147",
  rarity: "Common",
  types: ["Dragon"],
  stage: "Basic",
  evolveFrom: null,
  illustrator: null,
  hp: null,
  variants: { normal: true, holo: false, reverse: false, firstEdition: false, wPromo: false },
  artworkGroupId: "art-dratini-147",
  cardClass: "standard",
  isDigitalOnly: false,
  priceLow: null,
  priceMarket: 1,
  category: "Pokemon",
  trainerType: null,
};
const dragonair: CatalogCard = {
  ...dratini,
  tcgdexId: "dragonair-148",
  name: "Dragonair",
  dexId: [DRAGONAIR_DEX],
  localId: "148",
  stage: "Stage1",
  evolveFrom: "Dratini",
  artworkGroupId: "art-dragonair-148",
};

const KB1: Binder = { id: "KB1", name: "KB-001", type: "general", isActive: true };
const KB2: Binder = { id: "KB2", name: "KB-002", type: "general", isActive: false };

function ctx(lines: EvolutionLine[]): EngineContext {
  return {
    typeColorMap: MAP,
    catalog: [dratini, dragonair],
    owned: [],
    binders: [KB1, KB2],
    lines,
    collections: [],
    now: "2026-09-21T00:00:00.000Z",
  };
}

const incoming = (): IncomingCard => ({ id: "inc", card: dratini, variant: "normal" });

function slot(state: "placeholder" | "filled"): LineSlotRecord {
  return {
    id: `s-${state}`,
    stageIndex: 0,
    stage: "Basic",
    state,
    copyId: state === "filled" ? "some-copy" : null,
    dexId: DRATINI_DEX,
    targetCatalogCardId: "dratini-147",
  };
}

function line(
  id: string,
  colorBand: string,
  binderId: string,
  state: "placeholder" | "filled",
): EvolutionLine {
  return { id, rootDexId: DRATINI_DEX, colorBand, binderId, status: "open", slots: [slot(state)] };
}

/** Which line the cascade chose, read off the placement it produced. */
function chose(lines: EvolutionLine[]): string | undefined {
  const res = placeCard(incoming(), ctx(lines));
  return res.target.kind === "back-half-line" ? res.target.lineId : undefined;
}

describe("UIL-084 · two lines want the species: the band the card actually is wins", () => {
  it("prefers the line in the card's OWN natural band over an older one in another band", () => {
    // First in the list is the red line — the wrong answer, and the one the old code took.
    expect(
      chose([
        line("red", "red", "KB1", "placeholder"),
        line("olive", "olive", "KB2", "placeholder"),
      ]),
    ).toBe("olive");
  });

  it("prefers a natural-band line with an OPEN slot over a natural-band line whose slot is filled", () => {
    expect(
      chose([
        line("olive-full", "olive", "KB1", "filled"),
        line("olive-open", "olive", "KB2", "placeholder"),
      ]),
    ).toBe("olive-open");
  });

  it("falls back to an OPEN slot in another band when no line is in the card's own band", () => {
    expect(
      chose([
        line("red-full", "red", "KB1", "filled"),
        line("green-open", "green", "KB2", "placeholder"),
      ]),
    ).toBe("green-open");
  });

  it("falls back to the OLDEST — the first of an oldest-first list — when nothing else separates them", () => {
    // Same band, both OPEN, one per binder: her two-binder case with nothing left to prefer, so the
    // contract's order decides — and it has to be stable, because this choice picks the physical pocket.
    // (Both slots FILLED is a different branch entirely: the cascade sends the extra copy to the front
    // half and names no line, so it is not a tie to break.)
    const a = line("older", "olive", "KB1", "placeholder");
    const b = line("newer", "olive", "KB2", "placeholder");
    expect(chose([a, b])).toBe("older");
    // Reversed input gives the other answer, which is exactly why the caller must sort: the engine
    // cannot re-derive age from an EvolutionLine, so an unsorted list is an arbitrary answer.
    expect(chose([b, a])).toBe("newer");
  });

  it("one line only: unchanged, no tie-break involved", () => {
    expect(chose([line("only", "red", "KB1", "placeholder")])).toBe("only");
  });
});
