/**
 * The shared line-join derivation (UIL-070 part 1) — lifted out of `buildScreenModel` so the Haul Plan
 * can offer a draft card the same lines the Line screen offers a stranded copy. These pin the pure
 * functions directly; tests/line/unlined-cards.test.ts still pins the Line screen's use of them
 * against real Postgres, and tests/plan/line-join-options.test.ts pins the two screens agree.
 */
import { describe, expect, it } from "vitest";
import type { CatalogCard } from "@/lib/engine";
import {
  buildLineJoinIndex,
  joinOptionsFor,
  sortJoinCandidates,
  type JoinIndexLine,
  type JoinIndexSlot,
  lineKey,
} from "@/lib/line/join-options";
import type { LineJoinCandidate } from "@/lib/line/types";
import {
  CHARIZARD_BASE1_4,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  NEST_BALL_SV01_181,
} from "../engine/fixtures";

const CATALOG: CatalogCard[] = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_BASE1_4,
  NEST_BALL_SV01_181,
];
const TYPE_MAP = { Fire: "red", Water: "light_blue" };

const CHARMANDER_DEX = CHARMANDER_SV03_026.dexId[0];

function line(id: string, band: string, binderId = "b1"): JoinIndexLine {
  return { id, rootDexId: CHARMANDER_DEX, colorBand: band, binderId };
}
function slot(id: string, stageIndex: number, stage: string, state: string): JoinIndexSlot {
  return { id, stage_index: stageIndex, stage, state };
}

describe("buildLineJoinIndex", () => {
  it("offers every OPEN slot under the dexId its stage wants, with the line's own binder + band", () => {
    const index = buildLineJoinIndex(
      [line("L1", "red")],
      new Map([
        [
          "L1",
          [
            slot("s0", 0, "Basic", "filled"),
            slot("s1", 1, "Stage1", "placeholder"),
            slot("s2", 2, "Stage2", "block"),
          ],
        ],
      ]),
      CATALOG,
    );
    // Charmeleon's stage is open → a candidate; Charizard's stage is a block → also open (not filled).
    expect(index.openSlotsByDexId.get(CHARMELEON_SV03_027.dexId[0])).toEqual([
      {
        lineId: "L1",
        slotId: "s1",
        binderId: "b1",
        bandKey: "red",
        speciesLabel: "CHARMANDER LINE",
        stage: "Stage1",
        filledCount: 1,
        totalCount: 3,
      },
    ]);
    expect(index.openSlotsByDexId.get(CHARIZARD_BASE1_4.dexId[0])?.[0]).toMatchObject({
      slotId: "s2",
    });
    // The filled root is NOT offered.
    expect(index.openSlotsByDexId.has(CHARMANDER_DEX)).toBe(false);
    // Every line is indexed by its family root regardless of open slots, carrying its own binder and
    // band (UIL-084 — the key the server refuses a duplicate on), and its chain is kept.
    expect(index.linesByRoot.get(CHARMANDER_DEX)).toEqual([
      {
        speciesLabel: "CHARMANDER LINE",
        filledCount: 1,
        totalCount: 3,
        binderId: "b1",
        bandKey: "red",
      },
    ]);
    expect(index.chains.get("L1")?.map((n) => n.name)).toEqual([
      "Charmander",
      "Charmeleon",
      "Charizard",
    ]);
  });

  it("labels a line whose root the catalog no longer knows generically, and walks no chain for it", () => {
    const index = buildLineJoinIndex(
      [{ id: "L9", rootDexId: 99999, colorBand: "red", binderId: null }],
      new Map([["L9", [slot("x", 0, "Basic", "placeholder")]]]),
      CATALOG,
    );
    expect(index.linesByRoot.get(99999)?.[0].speciesLabel).toBe("EVOLUTION LINE");
    expect(index.chains.get("L9")).toEqual([]);
    // No chain → no dexId for the slot → nothing to offer it under.
    expect(index.openSlotsByDexId.size).toBe(0);
  });
});

describe("joinOptionsFor", () => {
  const index = buildLineJoinIndex(
    [line("L1", "red"), line("L2", "green", "b2")],
    new Map([
      ["L1", [slot("a0", 0, "Basic", "filled"), slot("a1", 1, "Stage1", "placeholder")]],
      ["L2", [slot("b0", 0, "Basic", "filled"), slot("b1", 1, "Stage1", "filled")]],
    ]),
    CATALOG,
  );

  it("a Stage1 with an open slot in red and a filled one in green: red is a candidate, and BOTH lines are reported where they live", () => {
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.dexId).toBe(CHARMELEON_SV03_027.dexId[0]);
    expect(opts.naturalBandKey).toBe("red");
    expect(opts.joinCandidates.map((c) => c.lineId)).toEqual(["L1"]);
    // UIL-084: keyed by BINDER AND BAND, and NOT filtered to bands without a candidate — the server
    // refuses a second line per (binder, band) whether or not this card could join the one there, so
    // filtering red out here is what let the panel recommend a new line the write would reject.
    expect(opts.existingLineByBinderBand).toEqual({
      [lineKey("b1", "red")]: {
        speciesLabel: "CHARMANDER LINE",
        filledCount: 1,
        totalCount: 2,
        binderId: "b1",
        bandKey: "red",
      },
      [lineKey("b2", "green")]: {
        speciesLabel: "CHARMANDER LINE",
        filledCount: 2,
        totalCount: 2,
        binderId: "b2",
        bandKey: "green",
      },
    });
    // A binder with no line for this family at all is absent, in every band.
    expect(opts.existingLineByBinderBand[lineKey("b3", "red")]).toBeUndefined();
    expect(opts.existingLineByBinderBand[lineKey("b1", "light_blue")]).toBeUndefined();
  });

  it("the SAME band in a DIFFERENT binder is not reported as taken — the whole of UIL-084", () => {
    // Red is taken in b1. b2 in red is free, and the server would accept a new line there.
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.existingLineByBinderBand[lineKey("b1", "red")]).toBeDefined();
    expect(opts.existingLineByBinderBand[lineKey("b2", "red")]).toBeUndefined();
  });

  it("keys on the CHAIN ROOT, not the card's own dexId (a Stage1 is not its own root)", () => {
    // Charmeleon's dexId is 5; the lines are rooted at Charmander (4). Keying on 5 would find nothing.
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(Object.keys(opts.existingLineByBinderBand).sort()).toEqual(
      [lineKey("b1", "red"), lineKey("b2", "green")].sort(),
    );
  });

  it("a duplicate of the filled root gets no candidate, and both existing lines are still reported", () => {
    const opts = joinOptionsFor(CHARMANDER_SV03_026, index, TYPE_MAP, CATALOG)!;
    expect(opts.joinCandidates).toEqual([]);
    expect(Object.keys(opts.existingLineByBinderBand).sort()).toEqual(
      [lineKey("b1", "red"), lineKey("b2", "green")].sort(),
    );
  });

  it("returns null for a Trainer — no species, no line concept", () => {
    expect(joinOptionsFor(NEST_BALL_SV01_181, index, TYPE_MAP, CATALOG)).toBeNull();
  });
});

describe("sortJoinCandidates", () => {
  it("closest-to-complete first, then by species label", () => {
    const c = (
      lineId: string,
      filled: number,
      total: number,
      label = "X LINE",
    ): LineJoinCandidate => ({
      lineId,
      slotId: `${lineId}-s`,
      binderId: null,
      bandKey: "red",
      speciesLabel: label,
      stage: "Stage1",
      filledCount: filled,
      totalCount: total,
    });
    const sorted = sortJoinCandidates([
      c("half", 1, 2),
      c("empty", 0, 3),
      c("nearly", 2, 3),
      c("half-b", 1, 2, "A LINE"),
    ]);
    expect(sorted.map((x) => x.lineId)).toEqual(["nearly", "half-b", "half", "empty"]);
  });
});
