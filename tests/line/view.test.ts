/**
 * Line-detail view-model (scr-line; dev-spec §5 M7). The strip is one ordered horizontal line;
 * these pin the ordering, the filled/placeholder/block counts, the capped cap-plate, the terminated
 * "no page" wedge, the moveable flag (placement override on owned/shelved cards), and the info copy.
 */

import { describe, expect, it } from "vitest";
import { buildLineView, type SlotInput } from "@/lib/line/view";
import type { CardIdentity } from "@/lib/line/types";

function card(name: string, localId: string): CardIdentity {
  return {
    tcgdexId: `${name}-${localId}`,
    name,
    setId: "sv03",
    setName: "Obsidian Flames",
    localId,
    imageUrl: `https://assets.tcgdex.net/en/sv/sv03/${localId}`,
    bandKey: "red",
  };
}

function slot(
  over: Partial<SlotInput> & { stageIndex: number; state: SlotInput["state"] },
): SlotInput {
  return {
    slotId: `s${over.stageIndex}`,
    stage: over.stageIndex === 0 ? "Basic" : "Stage1",
    card: null,
    copyId: null,
    variant: null,
    copyShelved: false,
    priceMarket: null,
    willLiveInSpecialty: false,
    alternates: [],
    note: null,
    wedgeLabel: null,
    ...over,
  };
}

describe("buildLineView", () => {
  it("orders slots by stageIndex, counts states, names the line from the root", () => {
    const view = buildLineView({
      lineId: "L1",
      rootDexId: 4,
      bandKey: "red",
      binderId: "b1",
      binderLabel: "Binder 1 · BACK",
      status: "open",
      slots: [
        slot({
          stageIndex: 1,
          state: "filled",
          card: card("Charmeleon", "027"),
          copyId: "c2",
          copyShelved: true,
        }),
        slot({
          stageIndex: 0,
          state: "filled",
          card: card("Charmander", "026"),
          copyId: "c1",
          copyShelved: true,
        }),
      ],
    });
    expect(view.slots.map((s) => s.stageIndex)).toEqual([0, 1]);
    expect(view.speciesLabel).toBe("CHARMANDER LINE");
    expect(view.counts).toEqual({ filled: 2, placeholder: 0, block: 0 });
    // An owned, shelved, filled copy can be moved (placement override on ALL cards).
    expect(view.slots.every((s) => s.moveable)).toBe(true);
  });

  it("a capped line ends in a cap plate naming the specialty target; placeholders are not moveable", () => {
    const view = buildLineView({
      lineId: "L1",
      rootDexId: 4,
      bandKey: "red",
      binderId: "b1",
      binderLabel: "Binder 1 · BACK",
      status: "capped",
      slots: [
        slot({
          stageIndex: 0,
          state: "filled",
          card: card("Charmander", "026"),
          copyId: "c1",
          copyShelved: true,
        }),
        slot({
          stageIndex: 1,
          state: "filled",
          card: card("Charmeleon", "027"),
          copyId: "c2",
          copyShelved: true,
        }),
        slot({
          stageIndex: 2,
          stage: "Stage2",
          state: "placeholder",
          card: card("Charizard ex", "006"),
          priceMarket: 24.1,
          willLiveInSpecialty: true,
        }),
      ],
    });
    expect(view.status).toBe("capped");
    expect(view.cap).not.toBeNull();
    expect(view.cap?.targetLabel).toMatch(/CHARIZARD EX/);
    expect(view.slots[2].moveable).toBe(false);
    expect(view.info[0].k).toBe("CAPPED BECAUSE");
  });

  it("a terminated line reports NO LINE BECAUSE and its block keeps the no-page wedge", () => {
    const view = buildLineView({
      lineId: "L2",
      rootDexId: 123,
      bandKey: "white",
      binderId: "b1",
      binderLabel: "Binder 2 · BACK",
      status: "terminated",
      slots: [
        slot({ stageIndex: 0, state: "block", wedgeLabel: "NO PAGE, SO NO POCKET." }),
        slot({
          stageIndex: 1,
          stage: "Stage1",
          state: "filled",
          card: card("Scizor", "141"),
          copyId: "c9",
        }),
      ],
    });
    expect(view.counts.block).toBe(1);
    expect(view.info[0].k).toBe("NO LINE BECAUSE");
    expect(view.slots[0].wedgeLabel).toBe("NO PAGE, SO NO POCKET.");
  });
});

/**
 * UIL-087 — the view mapping for a slot reading `filled` whose copy was never shelved.
 *
 * `moveable` used to require `copyShelved`, which hid the one control that can release a slot for
 * exactly the slots that are wrong: the Lines page offered no Move, the "not in a line yet" list
 * excludes them (it wants a shelved copy with NO slot), and Lookup filters unshelved copies out of the
 * location it shows — so there was no route to fix them from anywhere in the app.
 */
describe("buildLineView · a filled slot whose copy is not shelved (UIL-087)", () => {
  const wrongSlot = () =>
    buildLineView({
      lineId: "L1",
      rootDexId: 4,
      bandKey: "red",
      binderId: "b1",
      binderLabel: "Binder 1 · BACK",
      status: "open",
      slots: [
        slot({
          stageIndex: 0,
          state: "filled",
          card: card("Charmander", "026"),
          copyId: "c1",
          variant: "normal",
          copyShelved: false, // the card was never shelved into this slot
        }),
      ],
    }).slots[0];

  it("is MOVEABLE, so she has a way to fix it — pre-fix the control was hidden", () => {
    expect(wrongSlot().moveable).toBe(true);
  });

  it("is flagged as not-shelved, so the screen can say which rows are wrong", () => {
    expect(wrongSlot().copyNotShelved).toBe(true);
  });

  it("a filled slot whose copy IS shelved is moveable and NOT flagged", () => {
    const ok = buildLineView({
      lineId: "L1",
      rootDexId: 4,
      bandKey: "red",
      binderId: "b1",
      binderLabel: "Binder 1 · BACK",
      status: "open",
      slots: [
        slot({
          stageIndex: 0,
          state: "filled",
          card: card("Charmander", "026"),
          copyId: "c1",
          variant: "normal",
          copyShelved: true,
        }),
      ],
    }).slots[0];
    expect(ok.moveable).toBe(true);
    expect(ok.copyNotShelved).toBe(false);
  });

  it("a slot with no copy is neither moveable nor flagged — there is no card to move", () => {
    const empty = buildLineView({
      lineId: "L1",
      rootDexId: 4,
      bandKey: "red",
      binderId: "b1",
      binderLabel: "Binder 1 · BACK",
      status: "open",
      slots: [slot({ stageIndex: 1, state: "placeholder" })],
    }).slots[0];
    expect(empty.moveable).toBe(false);
    expect(empty.copyNotShelved).toBe(false);
  });
});
