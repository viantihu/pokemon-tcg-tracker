import { describe, it, expect } from "vitest";
import { buildPreview, type PreviewEnrichment } from "@/lib/sync/preview";
import {
  reconcile,
  type CopySnapshot,
  type CurrentGroup,
  type ResolvedRow,
  type UnresolvedRow,
} from "@/lib/sync/reconcile";
import { presenceKey } from "@/lib/sync/diff";

/**
 * Preview view-model (sync-ui-spec §B.2): the sectioned, most-consequential-first diff. Pure test of
 * the section shaping, addition aggregation, summary line, and the fast-path/gated/no-op classification.
 */

const AMPHAROS = "me04-29";
const GABITE = "sv10-103";

function row(catalogCardId: string | null, dexVariantRaw: string, quantity = 1): ResolvedRow {
  return {
    type: "collection",
    catalogCardId,
    dexVariantRaw,
    quantity,
    raw: { dexId: "x", setName: "s", series: "e", number: "1", name: "n", locale: "English" },
  };
}
function copy(copyId: string, o: Partial<CopySnapshot> = {}): CopySnapshot {
  return {
    copyId,
    role: "shelved",
    binderId: null,
    binderHalf: null,
    colorBand: null,
    lineSlotId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}
function group(catalogCardId: string, dexVariantRaw: string, copies: CopySnapshot[]): CurrentGroup {
  return { catalogCardId, dexVariantRaw, copies };
}

function enrichment(over: Partial<PreviewEnrichment> = {}): PreviewEnrichment {
  return {
    cardMetaById: {
      [AMPHAROS]: { name: "Ampharos", imageUrl: null, localId: "29", bandKey: "yellow" },
      [GABITE]: { name: "Cynthia's Gabite", imageUrl: null, localId: "103", bandKey: "navy" },
    },
    placementByCopyId: {},
    groupCopies: {},
    newParks: [],
    stillWaiting: 0,
    counts: {
      creates: 0,
      retires: 0,
      variantUpdates: 0,
      parks: 0,
      drops: 0,
      promotions: 0,
      dedupeUpdates: 0,
      unchanged: 0,
    },
    ...over,
  };
}

describe("buildPreview", () => {
  it("aggregates additions per (card, variant) into a single ×N row and is fast-path", () => {
    const plan = reconcile({
      rows: [row(GABITE, "Normal", 3)],
      current: [],
      clock: () => new Date(),
    });
    const preview = buildPreview(
      plan,
      enrichment({
        counts: {
          creates: 3,
          retires: 0,
          variantUpdates: 0,
          parks: 0,
          drops: 0,
          promotions: 0,
          dedupeUpdates: 0,
          unchanged: 0,
        },
      }),
    );
    expect(preview.kind).toBe("fastpath");
    expect(preview.sections.additions).toHaveLength(1);
    expect(preview.sections.additions[0]).toMatchObject({ name: "Cynthia's Gabite", count: 3 });
  });

  it("phrases removals with their consequence + placement, and gates", () => {
    const current = [
      group(AMPHAROS, "Holo", [
        copy("c1", { role: "shelved", binderId: "b1", binderHalf: "front", lineSlotId: "s1" }),
      ]),
    ];
    const plan = reconcile({ rows: [], current, clock: () => new Date() });
    const preview = buildPreview(
      plan,
      enrichment({
        placementByCopyId: { c1: "Binder 1 · front · line slot" },
        groupCopies: {
          [presenceKey(AMPHAROS, "Holo")]: [
            { copyId: "c1", label: "Binder 1 · front · line slot" },
          ],
        },
        counts: {
          creates: 0,
          retires: 1,
          variantUpdates: 0,
          parks: 0,
          drops: 0,
          promotions: 0,
          dedupeUpdates: 0,
          unchanged: 0,
        },
      }),
    );
    expect(preview.kind).toBe("gated");
    expect(preview.sections.removals).toHaveLength(1);
    expect(preview.sections.removals[0]).toMatchObject({
      name: "Ampharos",
      consequence: "line-slot-freed",
      consequenceLabel: "frees a line slot → placeholder",
      placementLabel: "Binder 1 · front · line slot",
    });
    // The removal's group is offered as a which-copy-left option set.
    expect(preview.retireOptions[presenceKey(AMPHAROS, "Holo")]).toEqual([
      { copyId: "c1", label: "Binder 1 · front · line slot" },
    ]);
  });

  it("summary line lists only non-empty sections and always the unchanged count", () => {
    const plan = reconcile({
      rows: [row(GABITE, "Normal", 1)],
      current: [group(GABITE, "Normal", [copy("c1")])],
      clock: () => new Date(),
    });
    const preview = buildPreview(
      plan,
      enrichment({
        newParks: [
          {
            dexId: "me6-14",
            dexSetName: "New Set",
            dexSeries: "ME",
            dexNumber: "14",
            dexName: "Mystery",
            dexVariantRaw: "Normal",
            quantity: 1,
            locale: "English",
            reason: "UNKNOWN_SET",
          } as UnresolvedRow,
        ],
        stillWaiting: 1,
        counts: {
          creates: 0,
          retires: 0,
          variantUpdates: 0,
          parks: 1,
          drops: 0,
          promotions: 0,
          dedupeUpdates: 0,
          unchanged: 1,
        },
      }),
    );
    expect(preview.summary.summaryLine).toBe("1 waiting on catalog · 1 unchanged");
    expect(preview.sections.unresolved.newParks).toHaveLength(1);
  });

  it("classifies a truly empty plan as a no-op", () => {
    const plan = reconcile({
      rows: [row(GABITE, "Normal", 1)],
      current: [group(GABITE, "Normal", [copy("c1")])],
      clock: () => new Date(),
    });
    const preview = buildPreview(plan, enrichment());
    expect(preview.kind).toBe("noop");
  });
});
