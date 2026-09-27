// @vitest-environment jsdom
/**
 * UIL-117 — the Collections editor's inline Move opens the line popup too (her answer 1: "ONE popup, on EVERY
 * screen"; the Senior BA's ruling on #385's flagged gap). Same rule as the hub's "Remove ▸": offered for a card with
 * exactly ONE copy in the collection's binder (a line slot holds one card), and her choice rides with the removal.
 * The Move sheet is stood in for (its popup behaviour is pinned in move-panel-line-popup.dom.test.ts); what is
 * pinned here is the editor's wiring.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineChoice, LineProposal } from "@/lib/line/popup";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { CollectionEditor } from "@/app/(ui)/coll/CollHub";

const DEST: MoveDestination = { kind: "shelf", binderId: "b1", half: "back", band: "red" };
const PROPOSAL: LineProposal = { kind: "start", binderId: "b1", band: "red" };
const CHOICE: LineChoice = { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} };

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(ui)/coll/actions", () => ({
  saveCollection: vi.fn(async () => ({ ok: true })),
}));
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));
vi.mock("@/app/(ui)/_components/MoveOverlay", async () => {
  const { createElement: h, useState: useS } = await import("react");
  return {
    MoveOverlay: function MoveOverlay({
      lineModel,
      onConfirm,
    }: {
      lineModel?: (p: LineProposal) => Promise<unknown>;
      onConfirm: (d: MoveDestination, c?: LineChoice) => void;
    }) {
      const [said, setSaid] = useS("");
      if (!lineModel) return h("div", { role: "dialog", "aria-label": "Move" }, "No line popup");
      return h("div", { role: "dialog", "aria-label": "Move" }, [
        h(
          "button",
          {
            key: "l",
            type: "button",
            onClick: () =>
              lineModel(PROPOSAL).then(
                () => setSaid("Line loaded"),
                (e: Error) => setSaid(e.message),
              ),
          },
          "BACK HALF",
        ),
        h(
          "button",
          { key: "c", type: "button", onClick: () => onConfirm(DEST, CHOICE) },
          "Start line",
        ),
        h("span", { key: "s" }, said),
      ]);
    },
  };
});

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: { spec: [{ id: "col-1", name: "Starters" }] },
  bands: [{ key: "red", display: "Red" }],
};
const target = (name: string, copyIds: string[]) => ({
  tcgdexId: `sv03-${name.toLowerCase()}`,
  name,
  setName: "Obsidian Flames",
  localId: "004",
  setCardCountOfficial: 197,
  owned: true,
  imageUrl: null,
  bandKey: "red",
  copyIds,
});
const STATE = {
  id: "col-1",
  isNewDraft: false,
  name: "Starters",
  mode: "finite" as const,
  binderId: "spec",
  newBinderName: "",
  targets: [target("Charmander", ["copy-1"]), target("Squirtle", ["copy-2", "copy-3"])],
};

beforeEach(() => {
  lineModelAction.mockReset().mockResolvedValue({ ok: true, model: {} });
});
afterEach(cleanup);

function mount() {
  const onMoveOwned = vi.fn(async () => true);
  const user = userEvent.setup();
  function Harness() {
    const [state, setState] = useState(STATE);
    return createElement(CollectionEditor, {
      state,
      binders: [{ id: "spec", name: "Specialty A" }],
      busy: false,
      onChange: setState as never,
      onClose: () => {},
      onSubmit: () => {},
      moveOptions: OPTIONS,
      onMoveOwned,
      onRebindMove: vi.fn(async () => ({ ok: true }) as const),
    });
  }
  render(createElement(Harness));
  return { onMoveOwned, user };
}
async function openMoveFor(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = within(document.querySelector(".celist") as HTMLElement)
    .getByText(name)
    .closest(".cerow") as HTMLElement;
  await user.click(row.querySelector("button.movebtn") as HTMLButtonElement);
  await screen.findByRole("dialog", { name: "Move" });
}

describe("UIL-117 · the Collections editor's Move opens the line popup", () => {
  it("one copy here: the popup is built for that copy", async () => {
    const { user } = mount();
    await openMoveFor(user, "Charmander");
    await user.click(screen.getByRole("button", { name: "BACK HALF" }));
    await screen.findByText("Line loaded");
    expect(lineModelAction).toHaveBeenCalledWith("copy-1", PROPOSAL);
  });

  it("her confirm reaches the removal with her choice, and the row leaves the list", async () => {
    const { onMoveOwned, user } = mount();
    await openMoveFor(user, "Charmander");
    await user.click(screen.getByRole("button", { name: "Start line" }));
    await waitFor(() => expect(onMoveOwned).toHaveBeenCalledTimes(1));
    expect(onMoveOwned).toHaveBeenCalledWith("sv03-charmander", DEST, CHOICE);
    await waitFor(() =>
      expect(
        within(document.querySelector(".celist") as HTMLElement).queryByText("Charmander"),
      ).toBeNull(),
    );
  });

  it("two copies here: no popup (a line holds one card)", async () => {
    const { user } = mount();
    await openMoveFor(user, "Squirtle");
    expect(screen.getByText("No line popup")).toBeTruthy();
    expect(lineModelAction).not.toHaveBeenCalled();
  });
});
