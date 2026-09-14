/**
 * The Haul Plan shows the OVERRIDDEN destination, not the cascade's suggestion (UIL-037).
 *
 * Her complaint: after moving Infernape from the specialty binder to bulk, both the spotlight
 * panel's destination block AND the worklist row's chip continued to read "specialty binder". So
 * the one screen built for verifying her placement decisions was showing her the wrong ones for
 * every card she had deliberately corrected. The commit itself was already correct — this is a
 * display bug in front of a right-writing action.
 *
 * The fix has two independent halves and this pins both, so a regression in either surfaces here
 * rather than in a screenshot:
 *
 *   1. SPOTLIGHT PANEL — had `override` in scope and did not read it. Assertions: the big line and
 *      the sentence under it name the override's destination, not the suggestion, AND the "MOVED"
 *      badge names the destination rather than reading generically.
 *
 *   2. WORKLIST ROW — never received `override` at all; the chain from `PlanView` through
 *      `BandSection` did not carry the map down. Assertions: the row's chip label and its meta
 *      text both name the override's destination, not the suggestion.
 *
 * A third test proves the surfaces cannot silently disagree: given the same item + override, the
 * `.destination` sentence rendered by the row and by the spotlight is the same string. That is the
 * shape of the bug — two paths, one truth — and asserting the shared derivation rather than either
 * path individually is what makes a re-divergence a test failure.
 *
 * Rendered through `react-dom/server`, so this runs in the suite's plain node environment.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { moveNameLookups } from "@/lib/line/move";
import type { PlanItem } from "@/lib/plan";
import { PlanRow, Spotlight } from "@/app/(ui)/plan/PlanScreen";

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: { spec: [{ id: "coll", name: "Starters" }] },
  bands: [
    { key: "red", display: "Red fire" },
    { key: "green", display: "Green grass" },
  ],
};

const NAMES = moveNameLookups(OPTIONS);

/** An item whose cascade suggestion is "Specialty A" — same shape as her screenshot. */
function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    incomingId: "d1",
    tcgdexId: "sv03-027",
    name: "Infernape",
    setId: "sv03",
    localId: "27",
    imageUrl: null,
    variant: "normal",
    stage: "Stage2",
    isBasic: false,
    bandKey: "red",
    action: "SPEC",
    destination: "Specialty A",
    reason: "Chase target; to the specialty binder.",
    needsDecision: false,
    ...over,
  };
}

/** Same shape the screen passes to the row. */
function renderRow(over: MoveDestination | undefined) {
  return renderToStaticMarkup(
    createElement(PlanRow, {
      item: item(),
      current: false,
      done: false,
      onSelect: () => {},
      onShelve: () => {},
      override: over,
      overrideNames: NAMES,
    }),
  );
}

function renderSpotlight(over: MoveDestination | undefined) {
  return renderToStaticMarkup(
    createElement(Spotlight, {
      item: item(),
      done: false,
      onShelve: () => {},
      onBackCard: () => {},
      onSkip: () => {},
      override: over,
      overrideNames: NAMES,
      onMove: () => {},
    }),
  );
}

describe("UIL-037 · the spotlight panel names the OVERRIDE, not the suggestion", () => {
  const BULK: MoveDestination = { kind: "bulk" };

  it("without an override, the spotlight still reads the cascade's suggestion", () => {
    const html = renderSpotlight(undefined);
    expect(html).toContain("Specialty A"); // suggestion
    expect(html).not.toContain("Bulk box");
    expect(html).not.toContain('class="movedtag u"'); // no override badge either
  });

  it("with an override, the spotlight replaces the destination sentence AND the big line", () => {
    const html = renderSpotlight(BULK);
    // The destination line: no longer the suggestion.
    expect(html).toContain("Bulk box");
    // The big instruction shifted with it — "To the specialty binder" is gone.
    expect(html).not.toContain("To the specialty binder");
    // The "MOVED" badge exists AND names the destination (was generic before the fix).
    expect(html).toMatch(/class="movedtag u"[^>]*>Moved · Bulk box/);
  });

  it("with a shelf override into a general binder, the sentence carries binder · half · band", () => {
    const html = renderSpotlight({ kind: "shelf", binderId: "b1", half: "back", band: "green" });
    expect(html).toContain("Binder 1 · Back · Green grass");
    expect(html).not.toContain("Specialty A");
  });
});

describe("UIL-037 · the worklist row names the OVERRIDE too", () => {
  const BULK: MoveDestination = { kind: "bulk" };

  it("without an override, the row's chip and meta text hold the cascade suggestion", () => {
    const html = renderRow(undefined);
    expect(html).toContain("Specialty A");
    expect(html).toContain("SPECIALTY BINDER"); // ACTION_META.SPEC.label
    expect(html).not.toContain("SEND TO BULK BOX");
    expect(html).not.toContain(">Moved<"); // no override badge on the row
  });

  it("with an override, the chip label AND the meta sentence both switch", () => {
    const html = renderRow(BULK);
    // The chip is now the bulk action's label, not the cascade action's.
    expect(html).toContain("SEND TO BULK BOX");
    expect(html).not.toContain("SPECIALTY BINDER");
    // And the row's meta line follows — this was the gap that made the row lie to her.
    expect(html).toContain("Bulk box");
    expect(html).not.toContain(">Specialty A<");
    // A short "Moved" pill so a scroll picks out her decisions from the cascade-proposed ones.
    expect(html).toContain(">Moved<");
  });

  it("a shelf override into the back half labels the row as a back-half placement", () => {
    const html = renderRow({ kind: "shelf", binderId: "b1", half: "back", band: "green" });
    // Not a front-half chip, and not the specialty chip. Manual moves to the back half never
    // auto-join a line, so they must not read as FILL/NEWLINE/PULL either.
    expect(html).toContain("PLACE IN BACK HALF");
    expect(html).not.toContain("PLACE IN FRONT HALF");
    expect(html).not.toContain("SPECIALTY BINDER");
    expect(html).toContain("Binder 1 · Back · Green grass");
  });
});

describe("UIL-037 · the two surfaces cannot silently disagree", () => {
  const OVER: MoveDestination = { kind: "shelf", binderId: "b1", half: "front", band: "red" };

  it("row and spotlight render the SAME override destination string", () => {
    const rowHtml = renderRow(OVER);
    const spotHtml = renderSpotlight(OVER);
    const label = "Binder 1 · Front · Red fire";
    expect(rowHtml).toContain(label);
    expect(spotHtml).toContain(label);
    expect(rowHtml).not.toContain("Specialty A");
    expect(spotHtml).not.toContain("Specialty A");
  });
});

describe("UIL-037 · when the name maps have not loaded yet", () => {
  it("the row's chip KIND is still correct (moveMeta reads only the destination kind)", () => {
    const html = renderToStaticMarkup(
      createElement(PlanRow, {
        item: item(),
        current: false,
        done: false,
        onSelect: () => {},
        onShelve: () => {},
        override: { kind: "bulk" } satisfies MoveDestination,
        overrideNames: null,
      }),
    );
    expect(html).toContain("SEND TO BULK BOX");
    expect(html).not.toContain("SPECIALTY BINDER");
  });

  it("the sentence falls back to the suggestion rather than showing a raw uuid", () => {
    const html = renderToStaticMarkup(
      createElement(Spotlight, {
        item: item(),
        done: false,
        onShelve: () => {},
        onBackCard: () => {},
        onSkip: () => {},
        override: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
        overrideNames: null,
        onMove: () => {},
      }),
    );
    // No half-resolved "b1 · Front · red" — better to keep the old sentence than to leak an id.
    expect(html).not.toMatch(/b1[^A-Za-z0-9]/);
    expect(html).toContain("Specialty A"); // the fallback sentence
  });
});
