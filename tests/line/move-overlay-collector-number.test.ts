/**
 * UIL-077, last site: the Move sheet's card header showed the bare collector number ("099") while every
 * other surface had moved to the full printed form ("099/182"). MoveOverlay now renders
 * `formatCollectorNumber(localId, setCardCountOfficial)` with the same null fallback the other sites use:
 * no total → the bare number, no number → nothing. `setCardCountOfficial` is optional on MoveTargetCard
 * so callers that cannot supply it yet (the Line and Lookup screens build theirs from `CardIdentity`,
 * which carries no total) keep working unchanged and show the bare number, exactly as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoveOptions } from "@/lib/line/types";
import { MoveOverlay, type MoveTargetCard } from "@/app/(ui)/_components/MoveOverlay";

const OPTIONS: MoveOptions = {
  binders: [{ id: "b1", name: "Binder 1", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red fire" }],
};

function render(card: Partial<MoveTargetCard>): string {
  return renderToStaticMarkup(
    createElement(MoveOverlay, {
      card: {
        copyId: "c1",
        name: "Charmeleon",
        localId: "099",
        imageUrl: null,
        bandKey: "red",
        currentLabel: "Binder 1 · Front · Red",
        ...card,
      },
      options: OPTIONS,
      onConfirm: () => {},
      onClose: () => {},
    }),
  );
}

const numberSpan = (html: string) => /<span class="no">([^<]*)<\/span>/.exec(html)?.[1] ?? null;

describe("UIL-077 · the Move sheet shows the full printed collector number", () => {
  it('renders "099/182" when the set total is known', () => {
    expect(numberSpan(render({ localId: "099", setCardCountOfficial: 182 }))).toBe("099/182");
  });

  it("falls back to the bare number when the total is null (TCGdex reports none) or absent (caller cannot supply it)", () => {
    expect(numberSpan(render({ localId: "099", setCardCountOfficial: null }))).toBe("099");
    expect(numberSpan(render({ localId: "099" }))).toBe("099");
  });

  it("does not render a zero total as a denominator", () => {
    expect(numberSpan(render({ localId: "099", setCardCountOfficial: 0 }))).toBe("099");
  });

  it("renders no number at all when the printing has none", () => {
    expect(numberSpan(render({ localId: null, setCardCountOfficial: 182 }))).toBeNull();
  });
});
