/**
 * UIL-077, the last three bare sites: the Sync preview's removal, variant-change and addition rows
 * showed the bare digits. The set total now rides on `CardMeta` (joined in `loadEnrichment`) through the
 * three row types, and each row renders through `formatCollectorNumber` — "099/182", or the bare number
 * when TCGdex reports no total, never "099/".
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewPanel } from "@/app/(ui)/sync/SyncScreen";
import type { SyncPreview } from "@/lib/sync";

function preview(total: number | null): SyncPreview {
  const card = {
    catalogCardId: "sv04-099",
    name: "Minior",
    imageUrl: null,
    localId: "099",
    setCardCountOfficial: total,
    bandKey: "olive",
  };
  return {
    kind: "gated",
    summary: {
      removed: 1,
      variantChanges: 1,
      added: 1,
      waiting: 0,
      unchanged: 3,
      summaryLine: "1 removed · 1 variant change · 1 added",
    },
    sections: {
      removals: [
        {
          ...card,
          copyId: "c-1",
          presenceKey: "sv04-099 ",
          dexVariantRaw: "",
          consequence: "bulk-removed",
          consequenceLabel: "was in the bulk box — removed",
          needsReview: false,
          placementLabel: "bulk box",
        },
      ],
      variantChanges: [
        {
          ...card,
          copyId: "c-2",
          migrationKey: "sv04-099|normal|holo",
          fromVariantRaw: "Normal",
          toVariantRaw: "Holo",
        },
      ],
      additions: [{ ...card, dexVariantRaw: "Normal", count: 2 }],
      unresolved: { newParks: [], stillWaiting: 0 },
      unchanged: 3,
    },
    retireOptions: {},
  } as unknown as SyncPreview;
}

const render = (p: SyncPreview) =>
  renderToStaticMarkup(
    createElement(PreviewPanel, {
      preview: p,
      overrides: {},
      busy: false,
      onToggleReject: () => {},
      onChooseRetire: () => {},
      onApply: () => {},
      onCancel: () => {},
    }),
  );

describe("UIL-077 · the Sync preview shows the full printed collector number on all three row kinds", () => {
  it("099/182 on the removal, the variant change and the addition", () => {
    const html = render(preview(182));
    expect(html.match(/class="no">099\/182</g)?.length).toBe(3);
    expect(html).not.toContain('class="no">099<');
  });

  it("the bare number when the set has no printed total — never 099/", () => {
    const html = render(preview(null));
    expect(html.match(/class="no">099</g)?.length).toBe(3);
    expect(html).not.toContain("099/");
  });
});
