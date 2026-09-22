/**
 * UIL-077 — the labels she reads on a line's slot: the printed collector number under a filled card,
 * and the priced alternates line under a placeholder. QA's #234 note: the Move sheet's number was
 * pinned (via the card handed to MoveOverlay), these on-screen labels were correct by reading only.
 * `Slot` is exported so this pins the static markup itself.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AlternateView, CardIdentity, LineView, SlotView } from "@/lib/line/types";
import { Slot } from "@/app/(ui)/line/LineScreen";

const identity = (localId: string, setCardCountOfficial: number | null): CardIdentity => ({
  tcgdexId: `sv03-${localId}`,
  name: "Charmeleon",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId,
  setCardCountOfficial,
  imageUrl: null,
  bandKey: "red",
});
const alt = (
  localId: string,
  setCardCountOfficial: number | null,
  price: number,
): AlternateView => ({
  tcgdexId: `sv03-${localId}`,
  name: "Charizard ex",
  localId,
  setCardCountOfficial,
  priceMarket: price,
});
const LINE: LineView = {
  lineId: "L1",
  rootDexId: 4,
  speciesLabel: "CHARMANDER LINE",
  bandKey: "red",
  binderId: "b1",
  binderLabel: "BINDER 1 · BACK",
  status: "open",
  counts: { filled: 1, placeholder: 1, block: 0 },
  slots: [],
  cap: null,
  info: [],
};
const slot = (over: Partial<SlotView>): SlotView => ({
  slotId: "s1",
  stageIndex: 1,
  stage: "Stage1",
  state: "filled",
  card: identity("099", 182),
  copyId: "c1",
  variant: "normal",
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  note: null,
  wedgeLabel: null,
  moveable: true,
  copyNotShelved: false,
  ...over,
});
const render = (s: SlotView) =>
  renderToStaticMarkup(createElement(Slot, { line: LINE, slot: s, onMove: () => {} }));
const numberOn = (html: string) =>
  /<span class="no">([^<]*)<\/span>/.exec(html)?.[1]?.trim() ?? null;
const altsLine = (html: string) => /<div class="alts">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;

describe("UIL-077 · a slot's on-screen labels show the full printed collector number", () => {
  it("a filled slot: 099/182 under the card", () => {
    expect(numberOn(render(slot({})))).toBe("099/182");
  });

  it("a filled slot whose set has no total: the bare 099", () => {
    expect(numberOn(render(slot({ card: identity("099", null) })))).toBe("099");
  });

  it("a placeholder's alternates line: full numbers where the set has a total, bare where it does not", () => {
    const html = render(
      slot({
        state: "placeholder",
        copyId: null,
        moveable: false,
        card: identity("099", 182),
        priceMarket: 12.5,
        alternates: [alt("010", 182, 12.5), alt("025", null, 3)],
      }),
    );
    const alts = altsLine(html);
    expect(alts).not.toBeNull();
    expect(alts).toContain("010/182 $12.50");
    expect(alts).toContain("025 $3.00");
    expect(alts).not.toContain("025/");
  });

  it("a block shows no number at all", () => {
    expect(
      numberOn(render(slot({ state: "block", card: null, copyId: null, moveable: false }))),
    ).toBeNull();
  });
});
