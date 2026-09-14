/**
 * Card artwork reaches the Haul Plan's worklist and spotlight (UIL-016).
 *
 * The defect was not a missing URL — it was a missing FIELD. `imageUrl` was never threaded through
 * `PlanItem`, so both `CardFace` call sites on the post-run screen were hard-coded to `null` and the
 * initials fallback was the only reachable state. Two layers of assertion, because either one alone
 * would have passed while the bug was live:
 *
 *   1. the adapter carries the row's `image_url` onto `PlanItem`, and
 *   2. the rendered row and spotlight actually emit an `<img>` for it.
 *
 * (2) is the one that pins the fix: (1) passed for the draft list all along, and the bug was that the
 * plan's own components ignored it. Rendering happens through `react-dom/server`, which needs no DOM
 * and so runs in this suite's plain node environment.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CascadeResult, IncomingCard } from "@/lib/engine";
import { toPlanItem, type AssembleLookups, type PlanItem } from "@/lib/plan";
import { PlanRow, Spotlight } from "@/app/(ui)/plan/PlanScreen";
import { CHARMELEON_SV03_027 } from "../engine/fixtures";

const ART = "https://assets.tcgdex.net/en/sv/sv03/27";

const LOOKUPS: AssembleLookups = {
  binderNameById: new Map(),
  bandDisplayByKey: new Map([["red", "Red fire"]]),
  collectionNameById: new Map(),
  imageUrlByTcgdexId: new Map([[CHARMELEON_SV03_027.tcgdexId, ART]]),
};

const RESULT: CascadeResult = {
  incomingId: "d1",
  step: "duplicate",
  reason: "Duplicate; to the bulk box.",
  resolvedBy: "auto",
  target: { kind: "bulk" },
};

function incoming(): IncomingCard {
  return { id: "d1", card: CHARMELEON_SV03_027, variant: "normal" };
}

/** A plan row as the screen receives it, with `imageUrl` overridable per test. */
function row(imageUrl: string | null): PlanItem {
  return {
    incomingId: "d1",
    tcgdexId: CHARMELEON_SV03_027.tcgdexId,
    name: "Charmeleon",
    setId: "sv03",
    localId: "27",
    imageUrl,
    variant: "normal",
    stage: "Stage1",
    isBasic: false,
    bandKey: "red",
    action: "BULK",
    destination: "Bulk box",
    reason: "Duplicate; to the bulk box.",
    needsDecision: false,
  };
}

describe("UIL-016 · the adapter carries artwork onto PlanItem", () => {
  it("resolves imageUrl from the catalog row, which the engine's CatalogCard does not carry", () => {
    // The premise of the fix: the engine type genuinely has no image field, so the value can only
    // come from the row-derived lookup. If this ever stops being true, the indirection is dead weight.
    expect("imageUrl" in CHARMELEON_SV03_027).toBe(false);

    const item = toPlanItem(incoming(), RESULT, "red", LOOKUPS);
    expect(item.imageUrl).toBe(ART);
  });

  it("yields null — not undefined — when the mirror has no artwork for the printing", () => {
    const item = toPlanItem(incoming(), RESULT, "red", {
      ...LOOKUPS,
      imageUrlByTcgdexId: new Map(),
    });
    expect(item.imageUrl).toBeNull();
  });
});

describe("UIL-016 · the plan screen renders it", () => {
  it("emits an <img> for a worklist row instead of the initials fallback", () => {
    const html = renderToStaticMarkup(
      createElement(PlanRow, {
        item: row(ART),
        current: false,
        done: false,
        onSelect: () => {},
        onToggle: () => {},
      }),
    );
    // CardFace appends the quality + extension to the stored base path.
    expect(html).toContain(`src="${ART}/low.webp"`);
    expect(html).not.toContain("fallback");
  });

  it("emits an <img> in the NOW HANDLING spotlight too", () => {
    const html = renderToStaticMarkup(
      createElement(Spotlight, {
        item: row(ART),
        done: false,
        onToggle: () => {},
        advance: () => {},
        onBackCard: () => {},
        onSkip: () => {},
        onCommit: () => {},
        committing: false,
        override: undefined,
        onMove: () => {},
      }),
    );
    expect(html).toContain(`src="${ART}/low.webp"`);
    expect(html).not.toContain("fallback");
  });

  it("still falls back to initials when the printing has no artwork", () => {
    const html = renderToStaticMarkup(
      createElement(PlanRow, {
        item: row(null),
        current: false,
        done: false,
        onSelect: () => {},
        onToggle: () => {},
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("CHA");
  });

  it("defers the fetch, so 702 rows are not 702 requests on first paint", () => {
    const html = renderToStaticMarkup(
      createElement(PlanRow, {
        item: row(ART),
        current: false,
        done: false,
        onSelect: () => {},
        onToggle: () => {},
      }),
    );
    expect(html).toContain('loading="lazy"');
  });

  it("survives a plan parked before this fix, whose rows have no imageUrl at all", () => {
    // The resume cache is keyed on a stamp of DB state (lib/plan/fingerprint.ts), not on the shape of
    // PlanItem, so a plan parked under the old shape resumes with the field absent. It must degrade
    // to initials, not throw and not emit `src="undefined/low.webp"`.
    const stale: Partial<PlanItem> = { ...row(ART) };
    delete stale.imageUrl;
    const html = renderToStaticMarkup(
      createElement(PlanRow, {
        item: stale as PlanItem,
        current: false,
        done: false,
        onSelect: () => {},
        onToggle: () => {},
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("CHA");
  });
});
