// @vitest-environment jsdom
/**
 * UIL-087's remedy — a slot that reads `filled` for a card which was never shelved says so, and offers
 * the Move that fixes it.
 *
 * The catch-22 this closes: `moveable` required the slot's copy to be SHELVED, so the one control that
 * can release a slot was hidden for exactly the slots that are wrong. The Lines page's "not in a line
 * yet" list could not help either (it wants a shelved copy with NO slot), and Lookup filters unshelved
 * copies out of the location it shows — so Karvi had no route to fix her three rows from anywhere in the
 * app. That is why she reported being unable to fix the record rather than merely seeing a wrong one.
 *
 * Driven through the real `Slot` in a DOM (QA's rule for a click path): the control is clicked and the
 * host is asserted to have been asked to move that card.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineView, SlotView } from "@/lib/line/types";
import { Slot } from "@/app/(ui)/line/LineScreen";

const LINE: LineView = {
  lineId: "L1",
  rootDexId: 9481,
  speciesLabel: "TOEDSCOOL LINE",
  bandKey: "orange",
  binderId: "kb1",
  binderLabel: "KB-001 · BACK",
  status: "open",
  counts: { filled: 2, placeholder: 0, block: 0 },
  slots: [],
  cap: null,
  info: [],
};

function slot(over: Partial<SlotView> = {}): SlotView {
  return {
    slotId: "s1",
    stageIndex: 1,
    stage: "Stage1",
    state: "filled",
    card: {
      tcgdexId: "toedscruel",
      name: "Toedscruel",
      setId: "sv09",
      setName: "Journey Together",
      localId: "089",
      setCardCountOfficial: 159,
      imageUrl: null,
      bandKey: "orange",
    },
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
  };
}

function mount(s: SlotView) {
  const onMove = vi.fn();
  render(createElement(Slot, { line: LINE, slot: s, onMove }));
  return { onMove, user: userEvent.setup() };
}

const moveButton = () => screen.queryByRole("button", { name: /Move/ });

afterEach(cleanup);

describe("UIL-087 · a filled slot whose card is not shelved", () => {
  it("labels itself honestly instead of looking like every other filled stage", () => {
    mount(slot({ copyNotShelved: true }));
    expect(screen.getByText("FILLED · CARD NOT SHELVED")).toBeTruthy();
    expect(screen.queryByText(/^FILLED$/)).toBeNull();
    expect(
      screen.getByText(
        /reads as filled but the card is not shelved here. Move it to put the record/,
      ),
    ).toBeTruthy();
  });

  it("offers Move, and clicking it asks the host to move that card — the route she did not have", async () => {
    const { onMove, user } = mount(slot({ copyNotShelved: true }));
    expect(moveButton()).toBeTruthy(); // pre-fix: null, because `moveable` required a shelved copy
    await user.click(moveButton()!);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("a healthy filled slot is unchanged: plain FILLED, no warning, Move still offered", () => {
    mount(slot());
    expect(screen.getByText("FILLED")).toBeTruthy();
    expect(screen.queryByText(/not shelved/)).toBeNull();
    expect(moveButton()).toBeTruthy();
  });

  it("a slot with NO copy offers no Move: there is no card to move, so the remedy is not this one", () => {
    mount(
      slot({
        copyId: null,
        moveable: false,
        copyNotShelved: false,
        state: "placeholder",
        card: null,
      }),
    );
    expect(moveButton()).toBeNull();
    expect(screen.queryByText(/not shelved/)).toBeNull();
  });
});
