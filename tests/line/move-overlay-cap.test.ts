/**
 * UIL-070 part 2 — the Move sheet's header reflows at phone width so Close keeps the top-right
 * corner and the card name drops to a second row. That reflow is CSS, scoped by the `movecap` class
 * so the other `.dsheet .cap` users (Collections, DecisionCard, Sync) are untouched. The geometry was
 * verified in the static harness (numbers in the PR); what a unit test CAN pin is the scoping hook:
 * if the class ever falls off this header, the media rule silently stops applying and the button
 * wraps under the name again.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoveOptions } from "@/lib/line/types";
import { MoveOverlay } from "@/app/(ui)/_components/MoveOverlay";

const OPTIONS: MoveOptions = {
  binders: [{ id: "b1", name: "Binder 1", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red fire" }],
};

describe("UIL-070 · the Move sheet header carries the phone-width reflow hook", () => {
  it("renders its .cap with the movecap class, title first, name, then Close", () => {
    const html = renderToStaticMarkup(
      createElement(MoveOverlay, {
        card: {
          copyId: "c1",
          name: "Charmeleon",
          localId: "005/165",
          imageUrl: null,
          bandKey: "red",
          currentLabel: "Binder 1 · Front · Red",
        },
        options: OPTIONS,
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    const cap = /<div class="cap movecap">(.*?)<\/div>/.exec(html);
    expect(cap).not.toBeNull();
    // DOM order is what the CSS `order` reflow works against: title, name, button.
    const inner = cap![1];
    expect(inner.indexOf('class="t"')).toBeGreaterThan(-1);
    expect(inner.indexOf('class="n"')).toBeGreaterThan(inner.indexOf('class="t"'));
    expect(inner.indexOf("<button")).toBeGreaterThan(inner.indexOf('class="n"'));
  });
});
