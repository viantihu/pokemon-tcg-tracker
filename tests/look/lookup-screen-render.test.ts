/**
 * Lookup screen, rendered statically:
 *
 *  UIL-035 (third site) — the screen has three distinct things to say after a pick, and only one of them
 *  ("NO MATCH") is a claim about her collection. A failed lookup must never render as a missing card.
 *
 *  UIL-051 — every one of her copies gets a row, and every copy the picker can take gets a Move. The one
 *  refusal (a binder block) names its condition and its remedy on the row.
 *
 * `renderToStaticMarkup` runs no effects and no clicks, so the overlay itself (imported, not owned here)
 * is out of scope; what is pinned is what she sees before touching anything.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerPanel, LookupNotice } from "@/app/(ui)/look/LookupScreen";
import type { LookupMovableCopy } from "@/app/(ui)/look/lookup-copies";
import type { LookupAnswer } from "@/lib/surfaces";

function answer(over: Partial<LookupAnswer>): LookupAnswer {
  return {
    card: {
      tcgdexId: "sv03-027",
      name: "Charmeleon",
      setName: "Obsidian Flames",
      localId: "027/197",
      rarity: "Uncommon",
      types: ["Fire"],
      stage: "Stage1",
      cardClass: "standard",
      imageUrl: null,
    },
    subtitle: "Uncommon · Fire · Stage1",
    bandKey: "red",
    bandDisplay: "Red",
    bandStack: [{ key: "red", active: true }],
    owned: true,
    ownedCount: 2,
    location: { binderName: "Main", half: "BACK HALF", bandDisplay: "Red" },
    facts: [],
    ...over,
  };
}

const COPIES: LookupMovableCopy[] = [
  {
    copyId: "c-shelf",
    role: "shelved",
    currentLabel: "Main · Back · Red",
    initial: { kind: "shelf", binderId: "b1", half: "back", band: "red" },
    // Both Dex-tracked, so no "Same card" merge is offered here — that is its own case below (UIL-089).
    dexTracked: true,
  },
  { copyId: "c-block", role: "block", currentLabel: "Main · binder block", dexTracked: true },
];

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("UIL-035 · a failed lookup never reads as a missing card", () => {
  it("NO MATCH is its own notice and says nothing about failure", () => {
    const html = render(createElement(LookupNotice, { kind: "notfound" }));
    expect(html).toContain("NO MATCH");
    expect(html).not.toContain("COULD NOT");
  });

  it("a failed lookup names the failure and says the card may well exist", () => {
    const html = render(
      createElement(LookupNotice, { kind: "failed", message: "Could not reach the database" }),
    );
    expect(html).toContain("COULD NOT LOOK THIS UP");
    expect(html).toContain("Could not reach the database");
    expect(html).toContain("may well be on your shelf");
    expect(html).not.toContain("NO MATCH");
    expect(html).toContain('role="alert"');
  });

  it("a failed move says nothing changed, and does not pretend the card moved", () => {
    const html = render(
      createElement(LookupNotice, {
        kind: "moveFailed",
        message: "That card is no longer in the collection.",
      }),
    );
    expect(html).toContain("COULD NOT MOVE IT");
    expect(html).toContain("nothing changed");
    expect(html).not.toContain("Moved ·");
  });
});

describe("UIL-051 · every copy is on screen, every movable copy has a Move", () => {
  it("renders one row per copy, numbered, with a Move on the shelved copy only", () => {
    const html = render(
      createElement(AnswerPanel, {
        answer: answer({}),
        copies: COPIES,
        busy: false,
        onMove: () => {},
        onRemove: () => {},
        onMerge: () => {},
      }),
    );
    expect(html).toContain("COPY 1 OF 2");
    expect(html).toContain("COPY 2 OF 2");
    expect(html).toContain("Main · Back · Red");
    expect(html).toContain("Main · binder block");
    expect(html.match(/>Move</g)?.length).toBe(1);
  });

  it("a binder block's row names the condition and the remedy instead of a Move", () => {
    const html = render(
      createElement(AnswerPanel, {
        answer: answer({}),
        copies: [COPIES[1]],
        busy: false,
        onMove: () => {},
        onRemove: () => {},
        onMerge: () => {},
      }),
    );
    expect(html).toContain("YOUR COPY");
    expect(html).toContain("A binder block holds its pockets");
    expect(html).toContain("line detail");
    expect(html).not.toContain(">Move<");
  });

  it("an unowned printing has no copy rows and no Move", () => {
    const html = render(
      createElement(AnswerPanel, {
        answer: answer({ owned: false, ownedCount: 0, location: null }),
        copies: [],
        busy: false,
        onMove: () => {},
        onRemove: () => {},
        onMerge: () => {},
      }),
    );
    expect(html).toContain("NOT OWNED");
    expect(html).not.toContain(">Move<");
    expect(html).not.toContain("YOUR COPY");
  });

  it("Move is disabled while a move is in flight", () => {
    const html = render(
      createElement(AnswerPanel, {
        answer: answer({}),
        copies: [COPIES[0]],
        busy: true,
        onMove: () => {},
        onRemove: () => {},
        onMerge: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Move<\/button>/);
  });
});

describe("UIL-077 · the answer header shows the full printed collector number", () => {
  // QA's #234 note: the Move sheet's number was pinned, this on-screen label was not. Same component,
  // same `formatCollectorNumber`, same fallback — pinned on the static markup she actually reads.
  const withTotal = (setCardCountOfficial: number | null) =>
    render(
      createElement(AnswerPanel, {
        answer: answer({
          card: {
            tcgdexId: "sv03-099",
            name: "Charmeleon",
            setName: "Obsidian Flames",
            localId: "099",
            setCardCountOfficial,
            rarity: "Uncommon",
            types: ["Fire"],
            stage: "Stage1",
            cardClass: "standard",
            imageUrl: null,
          },
        }),
        copies: COPIES,
        busy: false,
        onMove: () => {},
        onRemove: () => {},
        onMerge: () => {},
      }),
    );

  it('renders "099/182" when the set total is known', () => {
    expect(withTotal(182)).toContain('<span class="no">099/182</span>');
  });

  it("falls back to the bare number when TCGdex reports no total", () => {
    const html = withTotal(null);
    expect(html).toContain('<span class="no">099</span>');
    expect(html).not.toContain("099/");
  });
});
