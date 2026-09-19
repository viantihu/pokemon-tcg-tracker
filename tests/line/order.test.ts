/**
 * The Lines screen's two orders (UIL-074), pinned on the pure function `buildScreenModel` calls after
 * its line-building loop. Karvi's words: "grouped by binder" or "colour + alphabetical".
 */
import { describe, expect, it } from "vitest";
import type { LineView } from "@/lib/line/types";
import { binderGroups, orderLineViews } from "@/lib/line/order";

const BANDS = ["red", "orange", "yellow", "olive", "green"];
const BINDERS = ["b-first", "b-second"];

function line(id: string, species: string, bandKey: string, binderId: string | null): LineView {
  return {
    lineId: id,
    rootDexId: 1,
    speciesLabel: species,
    bandKey,
    binderId,
    binderLabel: binderId ? `${binderId.toUpperCase()} · BACK` : "Binder · BACK",
    status: "open",
    counts: { filled: 0, placeholder: 0, block: 0 },
    slots: [],
    cap: null,
    info: [],
  };
}

// Deliberately scrambled: neither by band, nor by name, nor by binder.
const LINES = [
  line("l1", "ZUBAT LINE", "green", "b-second"),
  line("l2", "CHARMANDER LINE", "red", "b-first"),
  line("l3", "ABRA LINE", "red", "b-second"),
  line("l4", "MANKEY LINE", "orange", null),
  line("l5", "flabébé line", "green", "b-first"),
];
const ctx = { bandOrder: BANDS, binderOrder: BINDERS };
const ids = (l: LineView[]) => l.map((x) => x.lineId);

describe("orderLineViews · colour + alphabetical (the default)", () => {
  it("rainbow band first, then species A to Z, regardless of binder", () => {
    expect(ids(orderLineViews(LINES, "color", ctx))).toEqual(["l3", "l2", "l4", "l5", "l1"]);
  });

  it("is case- and accent-insensitive on the species label", () => {
    const out = orderLineViews(LINES, "color", ctx);
    // "flabébé line" (green) sorts before "ZUBAT LINE" (green) on the base letters, not on case.
    expect(ids(out.filter((l) => l.bandKey === "green"))).toEqual(["l5", "l1"]);
  });

  it("does not mutate its input", () => {
    const before = ids(LINES);
    orderLineViews(LINES, "color", ctx);
    expect(ids(LINES)).toEqual(before);
  });

  it("an unknown band sorts last rather than being dropped", () => {
    const out = orderLineViews(
      [...LINES, line("l9", "AAA LINE", "chartreuse", null)],
      "color",
      ctx,
    );
    expect(ids(out).at(-1)).toBe("l9");
    expect(out).toHaveLength(6);
  });

  it("breaks a full tie on lineId so the order is deterministic", () => {
    const twins = [line("l-b", "X LINE", "red", null), line("l-a", "X LINE", "red", null)];
    expect(ids(orderLineViews(twins, "color", ctx))).toEqual(["l-a", "l-b"]);
  });
});

describe("orderLineViews · grouped by binder", () => {
  it("binders in display order, colour + alphabetical inside each, lines with no binder last", () => {
    expect(ids(orderLineViews(LINES, "binder", ctx))).toEqual([
      "l2", // b-first: red CHARMANDER
      "l5", // b-first: green flabébé
      "l3", // b-second: red ABRA
      "l1", // b-second: green ZUBAT
      "l4", // no binder
    ]);
  });

  it("a binder missing from the display order sorts after the known ones, before none", () => {
    const out = orderLineViews(
      [...LINES, line("l8", "EKANS LINE", "red", "b-unknown")],
      "binder",
      ctx,
    );
    expect(ids(out)).toEqual(["l2", "l5", "l3", "l1", "l8", "l4"]);
  });
});

describe("binderGroups · consecutive runs for the strip's headings", () => {
  it("one group per binder run, labelled by the line's binder label, 'NO BINDER' for none", () => {
    const groups = binderGroups(orderLineViews(LINES, "binder", ctx));
    expect(groups.map((g) => [g.key, g.label, ids(g.lines)])).toEqual([
      ["b-first", "B-FIRST · BACK", ["l2", "l5"]],
      ["b-second", "B-SECOND · BACK", ["l3", "l1"]],
      ["none", "NO BINDER", ["l4"]],
    ]);
  });

  it("groups what it is given and never re-sorts", () => {
    // Colour order interleaves binders → the same binder appears as two separate runs.
    const groups = binderGroups(orderLineViews(LINES, "color", ctx));
    expect(groups.map((g) => g.key)).toEqual([
      "b-second",
      "b-first",
      "none",
      "b-first",
      "b-second",
    ]);
  });
});
