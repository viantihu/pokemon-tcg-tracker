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
  candidateKey,
  joinOptionsFor,
  sortJoinCandidates,
  type JoinIndexLine,
  type JoinIndexSlot,
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
  // A target on every slot so the line's locale derives (UIL-090) without needing copy ids: these
  // fixtures are all English printings.
  return { id, stage_index: stageIndex, stage, state, target_catalog_card_id: "sv03-027" };
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
      () => null, // no filled-copy ids in these fixtures
    );
    // Charmeleon's stage is open → a candidate; Charizard's stage is a block → also open (not filled).
    expect(index.openSlotsByDexId.get(candidateKey("en", CHARMELEON_SV03_027.dexId[0]))).toEqual([
      {
        lineId: "L1",
        slotId: "s1",
        binderId: "b1",
        bandKey: "red",
        speciesLabel: "CHARMANDER LINE",
        stage: "Stage1",
        filledCount: 1,
        totalCount: 3,
        // UIL-133: the line's form (plain), and no chase at this stage.
        form: null,
        chasedCatalogCardId: null,
      },
    ]);
    expect(
      index.openSlotsByDexId.get(candidateKey("en", CHARIZARD_BASE1_4.dexId[0]))?.[0],
    ).toMatchObject({
      slotId: "s2",
    });
    // The filled root is NOT offered.
    expect(index.openSlotsByDexId.has(candidateKey("en", CHARMANDER_DEX))).toBe(false);
    // Every line is indexed by its family root regardless of open slots, carrying its own id, binder and
    // band — the id so a warning can offer to join that exact line (UIL-096) — and its chain is kept.
    expect(index.linesByRoot.get(CHARMANDER_DEX)).toEqual([
      {
        lineId: "L1",
        speciesLabel: "CHARMANDER LINE",
        filledCount: 1,
        totalCount: 3,
        binderId: "b1",
        bandKey: "red",
        locale: "en",
        form: null,
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
      () => null, // no filled-copy ids in these fixtures
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
    () => null, // no filled-copy ids in these fixtures
  );

  it("a Stage1 with an open slot in red and a filled one in green: red is a candidate, and BOTH lines are reported where they live", () => {
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.dexId).toBe(CHARMELEON_SV03_027.dexId[0]);
    expect(opts.naturalBandKey).toBe("red");
    expect(opts.joinCandidates.map((c) => c.lineId)).toEqual(["L1"]);
    // NOT filtered to bands without a candidate (UIL-084), and now a LIST of every line the family has
    // anywhere (UIL-096) rather than a record keyed by binder + band: once a second line CAN share a key,
    // a record silently drops one of them, and the warning has to name all of them.
    expect(opts.existingLines).toEqual([
      {
        lineId: "L1",
        speciesLabel: "CHARMANDER LINE",
        filledCount: 1,
        totalCount: 2,
        binderId: "b1",
        bandKey: "red",
        // UIL-090: each line carries the regional variant it belongs to.
        locale: "en",
        // UIL-133: and its form, and whether this card is of it.
        form: null,
        sameForm: true,
      },
      {
        lineId: "L2",
        speciesLabel: "CHARMANDER LINE",
        filledCount: 2,
        totalCount: 2,
        binderId: "b2",
        bandKey: "green",
        locale: "en",
        form: null,
        sameForm: true,
      },
    ]);
  });

  it("names lines in EVERY binder and band — the whole collection, not the one she picked (UIL-096)", () => {
    // Her words: "a line existing in my ENTIRE collection (not just the binder)". The list is not narrowed
    // to any destination; the panel decides what to say about each.
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.existingLines.map((l) => [l.binderId, l.bandKey])).toEqual([
      ["b1", "red"],
      ["b2", "green"],
    ]);
  });

  it("keys on the CHAIN ROOT, not the card's own dexId (a Stage1 is not its own root)", () => {
    // Charmeleon's dexId is 5; the lines are rooted at Charmander (4). Keying on 5 would find nothing.
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.existingLines.map((l) => l.lineId)).toEqual(["L1", "L2"]);
  });

  it("a duplicate of the filled root gets no candidate, and both existing lines are still reported", () => {
    const opts = joinOptionsFor(CHARMANDER_SV03_026, index, TYPE_MAP, CATALOG)!;
    expect(opts.joinCandidates).toEqual([]);
    expect(opts.existingLines.map((l) => l.lineId)).toEqual(["L1", "L2"]);
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

/**
 * UIL-096, QA's survivor. The shape this entry CREATES: two lines of one family in the same binder, band
 * and locale — the second made by "Start a new line anyway". A structure keyed on binder + band + locale
 * collapses them to one, and every fixture above had at most one line per key, so collapsing passed the
 * whole suite. The product consequence: once she has started a second line, the next such card sees one
 * line, and if the dropped one is the line with the open slot, "Join that line" is never offered.
 */
describe("joinOptionsFor · two lines of one family sharing binder, band and locale (UIL-096)", () => {
  // L1: Basic filled AND Stage 1 filled — nothing to join. L2 (the second, newer line): Stage 1 OPEN.
  const index = buildLineJoinIndex(
    [line("L1", "red", "b1"), line("L2", "red", "b1")],
    new Map([
      ["L1", [slot("a0", 0, "Basic", "filled"), slot("a1", 1, "Stage1", "filled")]],
      ["L2", [slot("b0", 0, "Basic", "filled"), slot("b1", 1, "Stage1", "placeholder")]],
    ]),
    CATALOG,
    () => null,
  );

  it("reports BOTH lines, not one per key", () => {
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    expect(opts.existingLines.map((l) => l.lineId)).toEqual(["L1", "L2"]);
    expect(
      new Set(opts.existingLines.map((l) => `${l.binderId}|${l.bandKey}|${l.locale}`)).size,
    ).toBe(1);
  });

  it("the open slot is in the SECOND of the two — and it is still the one offered to join", () => {
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, TYPE_MAP, CATALOG)!;
    // The join candidate comes from L2 …
    expect(opts.joinCandidates.map((c) => c.lineId)).toEqual(["L2"]);
    // … and L2 is present in the list the warning reads, so the panel can pair them. Collapsed to one line
    // per key, only L1 survives here and the suggested join has nothing to match (see the DOM case in
    // move-panel-line-per-binder.dom.test.ts, which drives this very output through the real panel).
    const joinable = opts.existingLines.filter((l) =>
      opts.joinCandidates.some((c) => c.lineId === l.lineId),
    );
    expect(joinable.map((l) => l.lineId)).toEqual(["L2"]);
  });
});

/**
 * Branching families (the TL's finding, the Senior BA's ruling): a line's chain rebuilt from its root stops at a
 * branch, so an open slot past it was named by no species and offered to NO card. An Eevee or Charcadet line with an
 * open Stage 1 was never offered as a join on any screen, and the popup proposed starting a second line instead.
 * Now such a slot is offered by the family and the depth: to a card whose own chain has the line's root and puts it
 * at that depth, and whose neighbours agree (the rule the one line builder holds it to, `isOwnStageOfLine`).
 */
describe("joinOptionsFor · an open slot past a branch", () => {
  const mk = (tcgdexId: string, name: string, dex: number, stage: string, from: string | null) => ({
    ...CHARMANDER_SV03_026,
    tcgdexId,
    name,
    dexId: [dex],
    localId: tcgdexId.split("-")[1],
    stage,
    evolveFrom: from,
    types: ["Fire"],
  });
  const EEVEE = mk("sv08-1330", "Eevee", 133, "Basic", null);
  const VAPOREON = mk("sv08-1340", "Vaporeon", 134, "Stage1", "Eevee");
  const JOLTEON = mk("sv08-1350", "Jolteon", 135, "Stage1", "Eevee");
  const CHARCADET = mk("sv04-9350", "Charcadet", 935, "Basic", null);
  const ARMAROUGE = mk("sv04-9360", "Armarouge", 936, "Stage1", "Charcadet");
  const CERULEDGE = mk("sv04-9370", "Ceruledge", 937, "Stage1", "Charcadet");
  const TWIGLING = mk("sv05-9500", "Twigling", 950, "Basic", null);
  const TWIGLEAF = mk("sv05-9510", "Twigleaf", 951, "Stage1", "Twigling");
  const TWIGTREE = mk("sv05-9520", "Twigtree", 952, "Stage2", "Twigleaf");
  const TWIGTHORN = mk("sv05-9530", "Twigthorn", 953, "Stage1", "Twigling");
  const THORNKING = mk("sv05-9540", "Thornking", 954, "Stage2", "Twigthorn");
  const BRANCHING = [
    ...CATALOG,
    EEVEE,
    VAPOREON,
    JOLTEON,
    CHARCADET,
    ARMAROUGE,
    CERULEDGE,
    TWIGLING,
    TWIGLEAF,
    TWIGTREE,
    TWIGTHORN,
    THORNKING,
  ];
  /** Copy ids name their card: `copy:<tcgdexId>`. */
  const copyCardId = (id: string) => id.replace(/^copy:/, "");
  const filledBy = (id: string, i: number, stage: string, card: CatalogCard): JoinIndexSlot => ({
    id,
    stage_index: i,
    stage,
    state: "filled",
    copy_id: `copy:${card.tcgdexId}`,
  });
  const open = (id: string, i: number, stage: string, extra: Partial<JoinIndexSlot> = {}) => ({
    id,
    stage_index: i,
    stage,
    state: "placeholder",
    ...extra,
  });
  const indexOf = (root: number, slots: JoinIndexSlot[]) =>
    buildLineJoinIndex(
      [{ id: "L", rootDexId: root, colorBand: "red", binderId: "b1" }],
      new Map([["L", slots]]),
      BRANCHING,
      copyCardId,
    );
  const offered = (card: CatalogCard, index: ReturnType<typeof indexOf>) =>
    joinOptionsFor(card, index, TYPE_MAP, BRANCHING)!.joinCandidates.map((c) => c.slotId);

  it("an Eevee line with an open Stage 1 is offered for Vaporeon AND for Jolteon", () => {
    const index = indexOf(133, [filledBy("e0", 0, "Basic", EEVEE), open("e1", 1, "Stage1")]);
    // PRE-FIX: [] for both; the popup then proposed starting a second Eevee line.
    expect(offered(VAPOREON, index)).toEqual(["e1"]);
    expect(offered(JOLTEON, index)).toEqual(["e1"]);
  });

  it("a Charcadet line with an open Stage 1 is offered for Armarouge (936) and Ceruledge (937)", () => {
    const index = indexOf(935, [filledBy("c0", 0, "Basic", CHARCADET), open("c1", 1, "Stage1")]);
    expect(offered(ARMAROUGE, index)).toEqual(["c1"]);
    expect(offered(CERULEDGE, index)).toEqual(["c1"]);
  });

  it("a card of another family, or of this family at another depth, is not offered it", () => {
    const index = indexOf(133, [filledBy("e0", 0, "Basic", EEVEE), open("e1", 1, "Stage1")]);
    expect(offered(CHARMELEON_SV03_027, index)).toEqual([]);
    expect(offered(ARMAROUGE, index)).toEqual([]);
    expect(offered(EEVEE, index)).toEqual([]);
  });

  it("its neighbours agree: between Twigling and Twigtree only Twigleaf, and after Twigleaf only Twigtree", () => {
    const middle = indexOf(950, [
      filledBy("t0", 0, "Basic", TWIGLING),
      open("t1", 1, "Stage1"),
      filledBy("t2", 2, "Stage2", TWIGTREE),
    ]);
    expect(offered(TWIGLEAF, middle)).toEqual(["t1"]);
    expect(offered(TWIGTHORN, middle)).toEqual([]);
    const top = indexOf(950, [
      filledBy("u0", 0, "Basic", TWIGLING),
      filledBy("u1", 1, "Stage1", TWIGLEAF),
      open("u2", 2, "Stage2"),
    ]);
    expect(offered(TWIGTREE, top)).toEqual(["u2"]);
    expect(offered(THORNKING, top)).toEqual([]);
  });

  it("a chased card counts as known; a leftover target on an undecided slot does not", () => {
    const chased = indexOf(950, [
      filledBy("v0", 0, "Basic", TWIGLING),
      open("v1", 1, "Stage1"),
      open("v2", 2, "Stage2", { stage_choice: "chase", target_catalog_card_id: TWIGTREE.tcgdexId }),
    ]);
    expect(offered(TWIGTHORN, chased)).toEqual([]);
    const leftover = indexOf(950, [
      filledBy("w0", 0, "Basic", TWIGLING),
      open("w1", 1, "Stage1"),
      open("w2", 2, "Stage2", { target_catalog_card_id: TWIGTREE.tcgdexId }),
    ]);
    expect(offered(TWIGTHORN, leftover)).toEqual(["w1"]);
    // …and the stage before too (QA's F6): a leftover Twigleaf target on Stage 1 does not refuse Thornking at Stage 2.
    const before = indexOf(950, [
      filledBy("x0", 0, "Basic", TWIGLING),
      open("x1", 1, "Stage1", { target_catalog_card_id: TWIGLEAF.tcgdexId }),
      open("x2", 2, "Stage2"),
    ]);
    expect(offered(THORNKING, before)).toEqual(["x2"]);
  });
});
