/**
 * UIL-117 — the Haul Plan's line proposals (lib/plan/line-proposal.ts): which back-half cards get which badge.
 * The engine fields it reads are pinned in tests/engine (filledStage: basic-joins-existing-line.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { CascadeResult } from "@/lib/engine";
import {
  extraCopyOfFor,
  isLineCard,
  lineProposalFor,
  type LineLookups,
} from "@/lib/plan/line-proposal";

const SLOTS: Record<string, string[]> = { "line-char": ["s0", "s1", "s2"] };
const lookups: LineLookups = {
  slotIdAt: (lineId, i) => SLOTS[lineId]?.[i] ?? null,
  lineOfSlot: (slotId) =>
    Object.entries(SLOTS).find(([, ids]) => ids.includes(slotId))?.[0] ?? null,
};
const base = { incomingId: "inc", reason: "", resolvedBy: "auto" as const };
const front = { kind: "front-half" as const, binderId: "B1", band: "red" as never };
const back = (lineId: string, stageIndex: number) => ({
  kind: "back-half-line" as const,
  binderId: "B1",
  band: "red" as never,
  lineId,
  stageIndex,
});

describe("UIL-117 · which back-half cards get which badge", () => {
  it("a new line is a green START, in the binder and band the engine chose", () => {
    const r: CascadeResult = {
      ...base,
      step: "line-new",
      target: back("new", 1),
      newLine: {
        rootDexId: 4,
        colorBand: "red" as never,
        binderId: "B1",
        status: "open",
        slots: [],
      },
    };
    expect(lineProposalFor(r, lookups)).toEqual({ kind: "start", binderId: "B1", band: "red" });
  });

  it("an existing line's open slot is a yellow ADD, naming the slot", () => {
    const r: CascadeResult = {
      ...base,
      step: "line-existing",
      target: back("line-char", 1),
      filledExistingSlot: { lineId: "line-char", stageIndex: 1 },
    };
    expect(lineProposalFor(r, lookups)).toEqual({ kind: "add", lineId: "line-char", slotId: "s1" });
  });

  it("a PLAIN extra copy for a filled stage is no line card: no badge, and the spotlight names its line (UIL-126)", () => {
    const r: CascadeResult = {
      ...base,
      step: "line-existing",
      target: front,
      filledStage: { lineId: "line-char", stageIndex: 1 },
    };
    // PRE-FIX (#392): a pink REPLACE opening on Keep, and a line card her Done could not shelve without the popup.
    expect(lineProposalFor(r, lookups)).toBeNull();
    expect(isLineCard(r)).toBe(false);
    expect(
      extraCopyOfFor(r, {
        ...lookups,
        lineName: () => "Charizard",
        lineWhere: () => "KB-003 · Back · Red",
        heldAt: (slotId) => (slotId === "s1" ? "Charmeleon 027/197" : null),
      }),
    ).toEqual({
      lineId: "line-char",
      slotId: "s1",
      lineName: "Charizard",
      where: "KB-003 · Back · Red",
      held: "Charmeleon 027/197",
    });
  });

  it("a holo over a copy in a line slot is a pink REPLACE pre-set to Swap", () => {
    const r: CascadeResult = {
      ...base,
      step: "duplicate",
      target: back("inherited", -1),
      swap: {
        incomingInherits: {
          binderId: "B1",
          binderHalf: "back",
          colorBand: "red",
          lineSlotId: "s2",
        },
        displacedCopyId: "normal-1",
      },
    };
    expect(lineProposalFor(r, lookups)).toEqual({
      kind: "replace",
      lineId: "line-char",
      slotId: "s2",
      defaultKeep: false,
    });
  });

  it("everything with no line asks nothing: front, bulk, specialty, a holo over a front-half copy", () => {
    const cases: CascadeResult[] = [
      { ...base, step: "basic-no-line", target: front },
      { ...base, step: "line-nonviable", target: front },
      { ...base, step: "duplicate", target: { kind: "bulk" } },
      {
        ...base,
        step: "card-class",
        target: { kind: "specialty", binderId: "S1", collectionId: null },
      },
      {
        ...base,
        step: "duplicate",
        target: front,
        swap: {
          incomingInherits: {
            binderId: "B1",
            binderHalf: "front",
            colorBand: "red",
            lineSlotId: null,
          },
          displacedCopyId: "normal-2",
        },
      },
    ];
    for (const r of cases) expect(lineProposalFor(r, lookups)).toBeNull();
  });

  it("a line or slot that has gone since the plan ran proposes nothing, rather than a slot that isn't there", () => {
    const gone: CascadeResult = {
      ...base,
      step: "line-existing",
      target: back("line-gone", 0),
      filledExistingSlot: { lineId: "line-gone", stageIndex: 0 },
    };
    expect(lineProposalFor(gone, lookups)).toBeNull();
  });
});
