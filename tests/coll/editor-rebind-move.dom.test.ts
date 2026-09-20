// @vitest-environment jsdom
/**
 * UIL-040 step 2 — a refused binder rebind shows its remedy on the SAME bar as the refusal: one button
 * whose label is the confirmation ("Move 3 cards to Specialty B and rebind"), no second modal. Click →
 * the host moves the copies and re-points the collection in one transaction; success clears the bar and
 * the editor settles on the binder she picked; failure replaces the refusal with the server's reason and
 * the button goes away (nothing moved). A refusal without a remedy — a target drop — shows no button.
 *
 * Driven through the REAL editor in a DOM (QA's rule for a click path): the binder chip is clicked, the
 * bar is read, the button is clicked, and what the host receives and what she then sees are asserted.
 * Same opt-in harness as tests/coll/editor-inline-move.dom.test.ts.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RebindRemedy, SaveCollectionResult, SaveResult } from "@/app/(ui)/coll/coll-types";
import { CollectionEditor, rebindButtonLabel } from "@/app/(ui)/coll/CollHub";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// The editor's deliberate binder pick goes through this server action; each test scripts its answer.
// The factory returns a closure so the variable is only read at call time, after module init.
const saveCollection = vi.fn<(...a: unknown[]) => Promise<SaveCollectionResult>>();
vi.mock("@/app/(ui)/coll/actions", () => ({
  saveCollection: (...a: unknown[]) => saveCollection(...a),
}));

const REMEDY: RebindRemedy = {
  kind: "rebind-move",
  collectionId: "col-1",
  toBinderId: "spec2",
  toBinderName: "Specialty B",
  fromBinderNames: ["Specialty A"],
  copyCount: 3,
  cards: [
    { tcgdexId: "sv04-099", name: "Minior", copyCount: 2 },
    { tcgdexId: "sv03-026", name: "Charmander", copyCount: 1 },
  ],
  staying: [],
};
const REFUSAL =
  "Moving to a new binder would strand 3 shelved cards in the old one, including Minior (Specialty A), " +
  "Charmander (Specialty A). Move them with it, or keep this collection in its current binder.";

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
  ],
};

function mount(over: Partial<Parameters<typeof CollectionEditor>[0]> = {}) {
  const onRebindMove = vi.fn<(toBinderId: string) => Promise<SaveResult>>(async () => ({
    ok: true,
  }));
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(CollectionEditor, {
      state: STATE,
      binders: [
        { id: "spec", name: "Specialty A" },
        { id: "spec2", name: "Specialty B" },
      ],
      busy: false,
      onChange,
      onClose: () => {},
      onSubmit: () => {},
      moveOptions: null,
      onMoveOwned: vi.fn(async () => true),
      onRebindMove,
      ...over,
    }),
  );
  return { onRebindMove, onChange, user };
}

const chip = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const bar = () => screen.queryByRole("alert");
const remedyButton = () =>
  screen.queryByRole("button", {
    name: /and rebind$|^Rebind and leave/,
  }) as HTMLButtonElement | null;

beforeEach(() => {
  saveCollection.mockReset();
  // The autosave path (a name typed, the flush before the move) gets an ordinary accepted draft save;
  // each test scripts the ONE refusal with `mockResolvedValueOnce` ahead of it.
  saveCollection.mockResolvedValue({ ok: true, id: "col-1" });
});
afterEach(cleanup);

describe("UIL-040 step 2 · the refusal shows its remedy on the same bar", () => {
  it("pick another binder → the refusal plus a button whose label is the confirmation; the editor stays put", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    const { user, onChange } = mount();
    await user.click(chip("Specialty B"));

    await waitFor(() => expect(bar()).toBeTruthy());
    expect(bar()!.textContent).toContain("would strand 3 shelved cards");
    expect(remedyButton()?.textContent).toBe("Move 3 cards to Specialty B and rebind");
    // Refused means refused: the chip does not move until the server has actually done it.
    expect(onChange).not.toHaveBeenCalled();
    expect(chip("Specialty A").className).toContain(" on");
    expect(chip("Specialty B").className).not.toContain(" on");
  });

  it("a refusal WITHOUT a remedy shows the message and no button", async () => {
    saveCollection.mockResolvedValueOnce({
      ok: false,
      error: "You still own Minior (Specialty A). Taking a card off the list does not move it.",
    });
    const { user } = mount();
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(bar()).toBeTruthy());
    expect(remedyButton()).toBeNull();
  });

  it("click → the host is asked to move to THAT binder; Moving… and disabled meanwhile; success clears the bar and settles the editor on the new binder", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    let release!: (r: SaveResult) => void;
    const onRebindMove = vi.fn(
      () =>
        new Promise<SaveResult>((resolve) => {
          release = resolve;
        }),
    );
    const { user, onChange } = mount({ onRebindMove });
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(remedyButton()).toBeTruthy());

    await user.click(remedyButton()!);
    expect(onRebindMove).toHaveBeenCalledWith("spec2");
    await waitFor(() => expect(chip("Moving…").disabled).toBe(true));

    release({ ok: true });
    await waitFor(() => expect(bar()).toBeNull());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as typeof STATE).binderId).toBe("spec2");
  });

  it("a failed move replaces the refusal with the server's reason, drops the button, and the editor stays put", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    const onRebindMove = vi.fn(async () => ({
      ok: false as const,
      error: "That binder no longer exists — reload and pick again.",
    }));
    const { user, onChange } = mount({ onRebindMove });
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(remedyButton()).toBeTruthy());

    await user.click(remedyButton()!);
    await waitFor(() => expect(bar()!.textContent).toContain("That binder no longer exists"));
    expect(bar()!.textContent).not.toContain("would strand");
    expect(remedyButton()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names the cards that stay behind and the collection that keeps them", async () => {
    saveCollection.mockResolvedValueOnce({
      ok: false,
      error: REFUSAL,
      remedy: {
        ...REMEDY,
        copyCount: 2,
        cards: [REMEDY.cards[0]],
        staying: [
          { tcgdexId: "sv03-026", name: "Charmander", copyCount: 1, alsoChasedBy: ["Fossils"] },
        ],
      },
    });
    const { user } = mount();
    await user.click(chip("Specialty B"));
    await waitFor(() =>
      expect(remedyButton()?.textContent).toBe("Move 2 cards to Specialty B and rebind"),
    );
    expect(screen.getByText(/Stays in Specialty A/).textContent).toContain(
      "Charmander (also chased by Fossils)",
    );
  });
});

type EditorStateT = Parameters<typeof CollectionEditor>[0]["state"];

/**
 * A stateful parent, as the real hub is. The editor is a controlled component — typing only shows up in
 * the field when `onChange` flows back down as `state` — so the autosave-loop cases mount through this.
 */
function Host(props: {
  onChange: (s: EditorStateT) => void;
  onRebindMove: (toBinderId: string) => Promise<SaveResult>;
}) {
  const [state, setState] = useState<EditorStateT>(STATE);
  return createElement(CollectionEditor, {
    state,
    binders: [
      { id: "spec", name: "Specialty A" },
      { id: "spec2", name: "Specialty B" },
    ],
    busy: false,
    onChange: (s) => {
      setState(s);
      props.onChange(s);
    },
    onClose: () => {},
    onSubmit: () => {},
    moveOptions: null,
    onMoveOwned: vi.fn(async () => true),
    onRebindMove: props.onRebindMove,
  });
}

function mountLive(onRebindMove?: (toBinderId: string) => Promise<SaveResult>) {
  const rebind =
    onRebindMove ?? vi.fn<(toBinderId: string) => Promise<SaveResult>>(async () => ({ ok: true }));
  const onChange = vi.fn<(s: EditorStateT) => void>();
  render(createElement(Host, { onChange, onRebindMove: rebind }));
  return { onRebindMove: rebind as ReturnType<typeof vi.fn>, onChange, user: userEvent.setup() };
}

describe("UIL-040 step 2 · the remedy and the autosave loop do not cross (FSD-1's review)", () => {
  const nameField = () => screen.getByPlaceholderText(/Matsuno illustrations/) as HTMLInputElement;

  it("(a) typing while the remedy is shown goes to the ordinary draft save and NEVER to the move", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    const { user, onRebindMove } = mountLive();
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(remedyButton()).toBeTruthy());
    const callsAfterRefusal = saveCollection.mock.calls.length;

    await user.type(nameField(), " 2");
    expect(nameField().value).toBe("Starters 2");
    // The debounce is 600 ms; the passive save lands on its own, carrying the OLD binder.
    await waitFor(
      () => expect(saveCollection.mock.calls.length).toBeGreaterThan(callsAfterRefusal),
      { timeout: 2000 },
    );
    const last = saveCollection.mock.calls.at(-1)![0] as { binderId: string; name: string };
    expect(last).toMatchObject({ binderId: "spec", name: "Starters 2" });
    expect(onRebindMove).not.toHaveBeenCalled();
    // Typing does not withdraw the offer.
    expect(remedyButton()).toBeTruthy();
  });

  it("(b) the click flushes the pending draft save FIRST, asks the host exactly once, and on success the new binder is picked while the typed name survives", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    const { user, onRebindMove, onChange } = mountLive();
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(remedyButton()).toBeTruthy());

    // Type, then click within the 600 ms debounce: that draft save (old binder, new name) must go out
    // ahead of the move, not land after it and undo the rebind.
    await user.type(nameField(), "!");
    const beforeClick = saveCollection.mock.calls.length;
    await user.click(remedyButton()!);

    await waitFor(() => expect(onRebindMove).toHaveBeenCalledTimes(1));
    expect(onRebindMove).toHaveBeenCalledWith("spec2");
    expect(saveCollection.mock.calls.length).toBeGreaterThanOrEqual(beforeClick + 1);
    const flushed = saveCollection.mock.calls[beforeClick][0] as { binderId: string; name: string };
    expect(flushed).toMatchObject({ binderId: "spec", name: "Starters!" });
    expect(saveCollection.mock.invocationCallOrder[beforeClick]).toBeLessThan(
      onRebindMove.mock.invocationCallOrder[0],
    );

    // Success: the editor's CURRENT state with only the binder changed — the typed name survives.
    await waitFor(() => expect(bar()).toBeNull());
    expect(chip("Specialty B").className).toContain(" on");
    expect(nameField().value).toBe("Starters!");
    const settled = onChange.mock.calls.at(-1)![0];
    expect(settled).toMatchObject({ binderId: "spec2", name: "Starters!" });
  });

  it("(c) Close is disabled while the move is in flight, so its outcome lands on an open editor", async () => {
    saveCollection.mockResolvedValueOnce({ ok: false, error: REFUSAL, remedy: REMEDY });
    let release!: (r: SaveResult) => void;
    const onRebindMove = vi.fn(
      () =>
        new Promise<SaveResult>((resolve) => {
          release = resolve;
        }),
    );
    const { user } = mount({ onRebindMove });
    await user.click(chip("Specialty B"));
    await waitFor(() => expect(remedyButton()).toBeTruthy());
    await user.click(remedyButton()!);
    await waitFor(() => expect(chip("Close").disabled).toBe(true));
    release({ ok: true });
    await waitFor(() => expect(chip("Close").disabled).toBe(false));
  });
});

describe("rebindButtonLabel", () => {
  it("counts and names the destination; singular; and when everything stays it says nothing moves", () => {
    expect(rebindButtonLabel(REMEDY)).toBe("Move 3 cards to Specialty B and rebind");
    expect(rebindButtonLabel({ ...REMEDY, copyCount: 1 })).toBe(
      "Move 1 card to Specialty B and rebind",
    );
    expect(
      rebindButtonLabel({
        ...REMEDY,
        copyCount: 0,
        cards: [],
        staying: [{ tcgdexId: "x", name: "X", copyCount: 2, alsoChasedBy: ["Fossils"] }],
      }),
    ).toBe("Rebind and leave 2 cards in Specialty A");
  });
});
