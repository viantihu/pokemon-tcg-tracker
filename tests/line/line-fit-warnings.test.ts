/**
 * UIL-135: the line rules a card breaks in a line's slot, as her warnings (lib/line/line-choice.ts `lineFitWarnings`,
 * the ONE check the line builder holds a write to). Karvi, 2026-10-01: "The rules should exist only for the
 * recommendation engine. Users should always be able to override all rules."
 *
 * Real TCGdex printings (2026-10-01/02) unless marked.
 */
import { describe, expect, it } from "vitest";
import type { CatalogCard } from "@/lib/engine";
import { lineFitWarnings, type LineFitInput } from "@/lib/line/line-choice";
import { LINE_WARNING } from "@/lib/line/popup";
import type { Row } from "@/lib/repo";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";

const real = (
  id: string,
  name: string,
  dex: number,
  stage: string,
  evolveFrom: string | null,
): CatalogCard => ({
  ...CHARMANDER_SV03_026,
  tcgdexId: id,
  name,
  dexId: [dex],
  stage,
  evolveFrom,
  types: ["Fighting"],
  artworkGroupId: `art-${id}`,
});
const TOEDSCOOL = real("sv03-118", "Toedscool", 948, "Basic", null);
const TOEDSCRUEL = real("sv09-089", "Toedscruel", 949, "Stage1", "Toedscool");
const ARVENS_TOEDSCOOL = real("sv10-109", "Arven's Toedscool", 948, "Basic", null);
const ARVENS_TOEDSCRUEL = real(
  "sv10-110",
  "Arven's Toedscruel",
  949,
  "Stage1",
  "Arven's Toedscool",
);
const JA_TOEDSCOOL = real("ja:SV9-087", "ノノクラゲ", 948, "Basic", null);
/** NOT a real printing: a Japanese Toedscruel whose Basic the Japanese catalog lacks, so its chain cannot walk back. */
const JA_SHORT = real("ja:XX-001", "リククラゲ", 949, "Stage1", "ノノクラゲ（未収録）");
const CATALOG = [
  TOEDSCOOL,
  TOEDSCRUEL,
  ARVENS_TOEDSCOOL,
  ARVENS_TOEDSCRUEL,
  JA_TOEDSCOOL,
  JA_SHORT,
];

const line = (form: string | null, over: Partial<Row<"evolution_line">> = {}) =>
  ({
    id: "L",
    owner_id: "o",
    root_dex_id: 948,
    color_band: "orange",
    binder_id: "kb",
    half: "back",
    status: "open",
    extra_pocket: null,
    form,
    created_at: "2026-10-02T00:00:00Z",
    ...over,
  }) as Row<"evolution_line">;
const slot = (i: number, copy: string | null, over: Partial<Row<"line_slot">> = {}) =>
  ({
    id: `s${i}`,
    owner_id: "o",
    line_id: "L",
    stage_index: i,
    stage: ["Basic", "Stage1"][i],
    state: copy ? "filled" : "placeholder",
    copy_id: copy,
    target_catalog_card_id: null,
    stage_choice: null,
    note: null,
    ...over,
  }) as Row<"line_slot">;
const input = (
  card: CatalogCard,
  slots: Row<"line_slot">[],
  over: Partial<LineFitInput> = {},
): LineFitInput => ({
  card,
  catalog: CATALOG,
  line: line("plain"),
  slots,
  slotId: "s0",
  cardOfCopy: (id) => ({ c1: "sv09-089", c2: "sv10-110", cj: "ja:SV9-087" })[id] ?? null,
  ...over,
});

describe("lineFitWarnings: what she is told before she confirms", () => {
  it("the stage's own card, of the line's form: nothing to say", () => {
    expect(lineFitWarnings(input(TOEDSCOOL, [slot(0, null), slot(1, "c1")]))).toEqual([]);
  });

  it("a card of another stage: the spot named, and the card", () => {
    expect(lineFitWarnings(input(TOEDSCRUEL, [slot(0, null), slot(1, "c1")]))).toEqual([
      { rule: "line_fit", text: "This spot is for Toedscool (Basic). This card is Toedscruel." },
    ]);
  });

  it("a card of another form than the line's stored one (UIL-133), either way round", () => {
    expect(lineFitWarnings(input(ARVENS_TOEDSCOOL, [slot(0, null), slot(1, "c1")]))).toEqual([
      { rule: "line_fit", text: "This is your Toedscool line, and this is Arven's Toedscool." },
    ]);
    expect(
      lineFitWarnings(
        input(TOEDSCOOL, [slot(0, null), slot(1, "c2")], { line: line("trainer:arven") }),
      ),
    ).toEqual([
      {
        rule: "line_fit",
        text: "This is your Arven's Toedscool line, and this is a regular Toedscool.",
      },
    ]);
  });

  it("a card the catalog cannot place: unconfirmed, not wrong", () => {
    expect(
      lineFitWarnings(
        input(
          JA_SHORT,
          // A Japanese line (its Basic chased in Japanese), with nothing known to walk its chain from.
          [slot(0, null, { target_catalog_card_id: "ja:SV9-087" }), slot(1, null)],
          { slotId: "s1", line: line(null) },
        ),
      ),
    ).toEqual([{ rule: "line_fit", text: LINE_WARNING.unconfirmed }]);
  });

  it("a swap into a filled slot is held to the slot's species, which the card there names", () => {
    expect(
      lineFitWarnings(input(TOEDSCOOL, [slot(0, "c1"), slot(1, null)], { replacing: true })),
    ).toEqual([
      { rule: "line_fit", text: "This spot is for Toedscruel (Basic). This card is Toedscool." },
    ]);
  });

  it("another language itself is never one of these: the popup asks it with its own Join anyway (the Tech Lead's review of #462)", () => {
    const foreign = input(TOEDSCRUEL, [slot(0, "cj"), slot(1, null)], {
      slotId: "s1",
      line: line(null),
    });
    expect(lineFitWarnings(foreign, false)).toEqual([]);
  });

  it("another language: a line whose language would flip is said, once she has said to join it anyway", () => {
    // An English card into a Japanese line with no English card below it: the line would read English.
    expect(
      lineFitWarnings(
        input(TOEDSCRUEL, [slot(0, "cj"), slot(1, null)], { slotId: "s1", line: line(null) }),
      ),
    ).toEqual([]);
    expect(
      lineFitWarnings(
        input(TOEDSCOOL, [slot(0, null), slot(1, null, { target_catalog_card_id: "ja:SV9-087" })], {
          line: line(null),
        }),
      ),
    ).toEqual([{ rule: "line_fit", text: LINE_WARNING.languageFlip("English") }]);
  });
});
