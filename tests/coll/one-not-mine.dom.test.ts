// @vitest-environment jsdom
/**
 * UIL-112 — exactly ONE "Not mine" per card she holds one copy of, in a finite collection and in an open one.
 *
 * Her report: two "Not mine" buttons on a card in Collections, on finite collections only. The finite row
 * rendered `NotMineButton` twice (a duplicated line since #311, UIL-089), and the open row rendered none,
 * though an open collection shows her copies just the same. The static tests only asked whether the words
 * appeared at all, which two buttons satisfy; this counts them, through the REAL component in a DOM, and
 * presses the one that is there.
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionCard } from "@/app/(ui)/coll/CollHub";
import type { CollectionCardView, CollectionView } from "@/app/(ui)/coll/coll-types";

const card = (n: number, copyIds: string[]): CollectionCardView => ({
  tcgdexId: `card-${n}`,
  name: `Testcard ${n}`,
  setName: "sv03",
  localId: String(n),
  setCardCountOfficial: null,
  bandKey: "red",
  imageUrl: null,
  owned: copyIds.length > 0,
  wished: false,
  copyIds,
});
const collection = (mode: "finite" | "open", cards: CollectionCardView[]): CollectionView => ({
  id: `col-${mode}`,
  name: mode === "finite" ? "Matsuno" : "Kagemaru",
  mode,
  incomplete: false,
  binderIds: ["b1"],
  binderNames: ["Specialty A"],
  cards,
  ownedCount: cards.filter((c) => c.owned).length,
  totalCount: cards.length,
});

function mount(c: CollectionView) {
  const onRemoveCopy = vi.fn();
  render(
    createElement(CollectionCard, {
      collection: c,
      busy: false,
      collapsed: false,
      onToggleCollapse: () => {},
      onEdit: () => {},
      onMode: () => {},
      onDelete: () => {},
      onLog: () => {},
      onWishlist: () => {},
      onRemove: () => {},
      onRemoveCopy,
    }),
  );
  return { onRemoveCopy, user: userEvent.setup() };
}
/** The "Not mine" buttons on one card's tile. */
const notMineOn = (name: string) => {
  const tile = screen.getByText(name).closest(".ccard") as HTMLElement;
  return within(tile).queryAllByRole("button", { name: `Remove ${name} from your collection` });
};

afterEach(cleanup);

describe("UIL-112 · one Not mine per card", () => {
  for (const mode of ["finite", "open"] as const) {
    it(`a ${mode} collection shows exactly one on each card she holds one copy of`, () => {
      mount(collection(mode, [card(1, ["copy-1"]), card(2, ["copy-2"])]));
      // PRE-FIX: finite showed 2 per card, open showed 0.
      expect(notMineOn("Testcard 1")).toHaveLength(1);
      expect(notMineOn("Testcard 2")).toHaveLength(1);
    });

    it(`in a ${mode} collection, pressing it removes that one copy`, async () => {
      const { onRemoveCopy, user } = mount(collection(mode, [card(1, ["copy-1"])]));
      await user.click(notMineOn("Testcard 1")[0]);
      await user.click(screen.getByRole("button", { name: /Yes, remove/ }));
      expect(onRemoveCopy).toHaveBeenCalledTimes(1);
      expect(onRemoveCopy).toHaveBeenCalledWith("copy-1");
    });
  }

  it("still none where it would be ambiguous (two copies) or where there is nothing to remove (a gap)", () => {
    mount(collection("finite", [card(1, ["copy-1", "copy-2"]), card(2, [])]));
    expect(notMineOn("Testcard 1")).toHaveLength(0);
    expect(notMineOn("Testcard 2")).toHaveLength(0);
  });
});
