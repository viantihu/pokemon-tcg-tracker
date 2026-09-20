// @vitest-environment jsdom
/**
 * UIL-043 — the collection editor's OWNED-target row offers the move inline, so she no longer has to
 * close the editor and find the card in the grid to give it a new home. Additive on UIL-014 exactly as
 * Karvi chose it: the owned row still has no "✕" (and the server still refuses the drop), the unowned row
 * still has its "✕"; a Move button sits beside the Owned pill and opens the SAME shared move sheet the
 * card's Remove button uses, seeded on the collection's own binder (Senior BA's call).
 *
 * Driven through the REAL editor in a DOM (QA's rule for a click path): the button is clicked, the sheet
 * is read, a destination is picked, Confirm is clicked, and what the host receives and what she then
 * sees are both asserted. Same opt-in harness as tests/line/move-panel-picker.dom.test.ts.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoveOptions } from "@/lib/line/types";
import { CollectionEditor } from "@/app/(ui)/coll/CollHub";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// The editor autosaves passive edits through a server action; nothing here is passive, but the import
// must not reach a server context.
vi.mock("@/app/(ui)/coll/actions", () => ({
  saveCollection: vi.fn(async () => ({ ok: true })),
}));

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: {
    spec: [
      { id: "col-1", name: "Starters" },
      { id: "col-2", name: "Fossils" },
    ],
  },
  bands: [{ key: "red", display: "Red fire" }],
};

const STATE = {
  id: "col-1",
  isNewDraft: false,
  name: "Starters",
  mode: "finite" as const,
  binderId: "spec",
  newBinderName: "",
  targets: [
    {
      tcgdexId: "sv04-099",
      name: "Minior",
      setName: "Paradox Rift",
      localId: "099",
      setCardCountOfficial: 182,
      owned: true,
      imageUrl: null,
      bandKey: "red",
    },
    {
      tcgdexId: "sv03-026",
      name: "Charmander",
      setName: "Obsidian Flames",
      localId: "026",
      setCardCountOfficial: 197,
      owned: false,
      imageUrl: null,
      bandKey: "red",
    },
  ],
};

function mount(over: Partial<Parameters<typeof CollectionEditor>[0]> = {}) {
  const onMoveOwned = vi.fn(async () => true);
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(CollectionEditor, {
      state: STATE,
      binders: [{ id: "spec", name: "Specialty A" }],
      busy: false,
      onChange,
      onClose: () => {},
      onSubmit: () => {},
      moveOptions: OPTIONS,
      onMoveOwned,
      onRebindMove: vi.fn(async () => ({ ok: true }) as const),
      ...over,
    }),
  );
  return { onMoveOwned, onChange, user };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
/** A target row in the editor's list (the open move sheet repeats the card's name, so scope to the list). */
const row = (name: string) =>
  within(document.querySelector(".celist") as HTMLElement)
    .getByText(name)
    .closest(".cerow") as HTMLElement;
/** The move sheet (a second dialog above the editor's), so its chips are not confused with the editor's. */
const sheet = () => within(screen.getByText(/NOW · /).closest('[role="dialog"]') as HTMLElement);
const chip = (name: string | RegExp) => sheet().getByRole("button", { name }) as HTMLButtonElement;

afterEach(cleanup);

describe("UIL-043 · the owned row: Move beside Owned, still no ✕; the unowned row unchanged", () => {
  it("renders exactly as UIL-014 shipped, plus the shortcut", () => {
    mount();
    const owned = row("Minior");
    expect(owned.querySelector(".cpill.have")?.textContent).toBe("Owned");
    expect(owned.querySelector("button.cex")).toBeNull();
    expect(owned.querySelector("button.movebtn")?.textContent).toContain("Move");
    const unowned = row("Charmander");
    expect(unowned.querySelector("button.cex")).not.toBeNull();
    expect(unowned.querySelector("button.movebtn")).toBeNull();
    expect(screen.getByText(/Use Move on its row to give it a new home/)).toBeTruthy();
  });

  it("is disabled, not hidden, when the sheet has nothing to offer yet (options not loaded, or a draft with no binder)", () => {
    mount({ moveOptions: null });
    expect((row("Minior").querySelector("button.movebtn") as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    mount({ state: { ...STATE, binderId: "__new" } });
    expect((row("Minior").querySelector("button.movebtn") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("UIL-043 · click Move → the shared move sheet, seeded on the collection's binder", () => {
  it("opens with the card, NOW · its binder and collection, the collection's binder pre-selected, and nothing confirmable yet", async () => {
    const { user } = mount();
    await user.click(button(/Move/));
    expect(screen.getByText(/NOW · Specialty A · Starters/)).toBeTruthy();
    expect(pressed(chip(/Specialty A/))).toBe(true);
    // A specialty binder is collection mode: she must still pick where it goes.
    expect(chip("Place it here ▶").disabled).toBe(true);
  });

  it("pick the bulk box, confirm → the host gets (tcgdexId, { kind: 'bulk' }), the row leaves the list, the sheet closes", async () => {
    const { user, onMoveOwned, onChange } = mount();
    await user.click(button(/Move/));
    await user.click(chip(/Bulk box/));
    expect(chip("Place it here ▶").disabled).toBe(false);
    await user.click(chip("Place it here ▶"));
    expect(onMoveOwned).toHaveBeenCalledWith("sv04-099", { kind: "bulk" });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const next = onChange.mock.calls[0][0] as typeof STATE;
    expect(next.targets.map((t) => t.tcgdexId)).toEqual(["sv03-026"]);
    await waitFor(() => expect(screen.queryByText(/NOW · Specialty A/)).toBeNull());
  });

  it("pick another collection in the same binder, confirm → a collection destination", async () => {
    const { user, onMoveOwned } = mount();
    await user.click(button(/Move/));
    await user.click(chip(/Fossils/));
    await user.click(chip("Place it here ▶"));
    expect(onMoveOwned).toHaveBeenCalledWith("sv04-099", {
      kind: "collection",
      binderId: "spec",
      collectionId: "col-2",
    });
  });

  it("a refused move keeps the sheet open and the row on the list", async () => {
    const { user, onChange } = mount({ onMoveOwned: vi.fn(async () => false) });
    await user.click(button(/Move/));
    await user.click(chip(/Bulk box/));
    await user.click(chip("Place it here ▶"));
    await waitFor(() => expect(screen.getByText(/NOW · Specialty A/)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
    expect(row("Minior")).toBeTruthy();
  });
});
