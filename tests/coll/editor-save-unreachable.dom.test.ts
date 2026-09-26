// @vitest-environment jsdom
/**
 * UIL-106 (1) — the Collections editor when a save cannot reach the server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped. The
 * autosave chain had no rejection handler, so after one thrown save every later autosave was skipped
 * silently and every flush rejected: Close and Esc did nothing, "Search & add cards" stuck on "Saving…",
 * "Save collection" did nothing, and a deliberate change failed with no word. Driven through the REAL
 * editor in a DOM, with `saveCollection` scripted to reject.
 *
 * What must hold: a message says the change may not have been saved (never "nothing was saved" — a thrown
 * call may have landed); the queue recovers and the NEXT edit saves; Close is never stranded.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveCollectionResult } from "@/app/(ui)/coll/coll-types";
import { COLL_LOST, CollectionEditor } from "@/app/(ui)/coll/CollHub";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const saveCollection = vi.fn<(...a: unknown[]) => Promise<SaveCollectionResult>>();
vi.mock("@/app/(ui)/coll/actions", () => ({
  saveCollection: (...a: unknown[]) => saveCollection(...a),
}));

const LOST = () => new TypeError("Failed to fetch");

const STATE = {
  id: "col-1",
  isNewDraft: false,
  name: "Starters",
  mode: "finite" as const,
  binderId: "spec",
  newBinderName: "",
  targets: [],
};

type EditorProps = Parameters<typeof CollectionEditor>[0];

/** The editor under a host that owns its state, as CollHub does, so typing flows. */
function mount(over: Partial<EditorProps> = {}) {
  const onClose = vi.fn();
  const onSubmit = vi.fn();
  const onChangeSpy = vi.fn();
  function Host() {
    const [state, setState] = useState(STATE);
    return createElement(CollectionEditor, {
      state,
      binders: [
        { id: "spec", name: "Specialty A" },
        { id: "spec2", name: "Specialty B" },
      ],
      busy: false,
      onChange: (s: typeof STATE) => {
        onChangeSpy(s);
        setState(s);
      },
      onClose,
      onSubmit,
      moveOptions: null,
      onMoveOwned: vi.fn(async () => true),
      onRebindMove: vi.fn(async () => ({ ok: true as const })),
      ...over,
    } as EditorProps);
  }
  const user = userEvent.setup();
  render(createElement(Host));
  return { user, onClose, onSubmit, onChangeSpy };
}

const nameBox = () => screen.getByPlaceholderText("e.g. Matsuno illustrations");
const bar = () => screen.queryByRole("alert")?.textContent ?? null;
const savedNames = () => saveCollection.mock.calls.map((c) => (c[0] as { name: string }).name);

beforeEach(() => {
  saveCollection.mockReset();
  saveCollection.mockResolvedValue({ ok: true, id: "col-1" });
  push.mockReset();
});
afterEach(cleanup);

describe("UIL-106 · a Collections save that cannot reach the server", () => {
  it("one failure, then the NEXT edit saves — and the message clears when it does", async () => {
    saveCollection.mockRejectedValueOnce(LOST());
    const { user } = mount();

    await user.type(nameBox(), "X");
    await waitFor(() => expect(bar()).toContain(COLL_LOST.autosave), { timeout: 2000 });

    await user.type(nameBox(), "Y");
    await waitFor(() => expect(savedNames()).toContain("StartersXY"), { timeout: 2000 });
    // PRE-FIX: the second save never ran, and nothing said so.
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("Close over an unsaved edit says so and stays open; a second press closes", async () => {
    saveCollection.mockRejectedValue(LOST());
    const { user, onClose } = mount();
    await user.type(nameBox(), "X");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(bar()).toBe(`!${COLL_LOST.close}`));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Esc takes the same path: never stranded", async () => {
    saveCollection.mockRejectedValue(LOST());
    const { user, onClose } = mount();
    await user.type(nameBox(), "X");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(bar()).toContain(COLL_LOST.close));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("'Search & add cards' does not leave over an unsaved edit, and is not stuck on 'Saving…'", async () => {
    saveCollection.mockRejectedValue(LOST());
    const { user } = mount();
    await user.type(nameBox(), "X");
    await user.click(screen.getByRole("button", { name: /Search & add cards/ }));

    await waitFor(() => expect(bar()).toContain("may not have been saved"));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Search & add cards/ }).textContent).toContain(
      "Search & add cards",
    );
  });

  it("'Save collection' does not confirm over an unsaved edit; pressing again once it saves does", async () => {
    saveCollection.mockRejectedValueOnce(LOST());
    const { user, onSubmit } = mount();
    await user.type(nameBox(), "X");
    await user.click(screen.getByRole("button", { name: "Save collection" }));
    await waitFor(() => expect(bar()).toContain(COLL_LOST.autosave));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save collection" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(savedNames()).toContain("StartersX");
  });

  it("a deliberate change that cannot reach the server says so, and the editor does not move", async () => {
    saveCollection.mockRejectedValue(LOST());
    const { user, onChangeSpy } = mount();
    await user.click(screen.getByRole("button", { name: "Specialty B" }));
    await waitFor(() => expect(bar()).toBe(`!${COLL_LOST.change}`));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});
