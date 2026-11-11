/**
 * UIL-140 — the Sync preview, as she sees it: a removed card in two places asks where it left from, Apply waits
 * for the answer, and once she says it left a binder spot the bulk refill is offered. Rendered markup only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewPanel } from "@/app/(ui)/sync/SyncScreen";
import type { SyncOverrides, SyncPreview } from "@/lib/sync";

const KEY = "sv03-062\u0000Normal";

function preview(): SyncPreview {
  return {
    kind: "gated",
    summary: {
      removed: 1,
      variantChanges: 0,
      flagFixes: 0,
      returning: 0,
      added: 0,
      waiting: 0,
      unchanged: 0,
      summaryLine: "1 removed · 0 unchanged",
    },
    sections: {
      removals: [
        {
          copyId: "bulk-1",
          catalogCardId: "sv03-062",
          presenceKey: KEY,
          name: "Pikachu",
          imageUrl: null,
          localId: "062",
          setCardCountOfficial: 197,
          bandKey: "yellow",
          dexVariantRaw: "Normal",
          consequence: "bulk-removed",
          consequenceLabel: "was in the bulk box — removed",
          needsReview: false,
          placementLabel: "Bulk box",
        },
      ],
      variantChanges: [],
      flagFixes: [],
      returning: [],
      additions: [],
      unresolved: { newParks: [], stillWaiting: 0, forgottenDismissed: 0 },
      unchanged: 0,
    },
    retireOptions: {},
    removalAsks: {
      [KEY]: {
        ambiguous: true,
        leaving: 1,
        options: [
          { copyId: "binder-1", label: "Binder 1 · front · Yellow", refillable: true },
          { copyId: "bulk-1", label: "Bulk box", refillable: false },
        ],
      },
    },
    refillOptions: { [KEY]: [{ copyId: "bulk-1", label: "Bulk box · Normal" }] },
  };
}

const render = (overrides: SyncOverrides) =>
  renderToStaticMarkup(
    createElement(PreviewPanel, {
      preview: preview(),
      overrides,
      busy: false,
      onToggleReject: () => {},
      onChangeOverrides: () => {},
      onApply: () => {},
      onCancel: () => {},
    }),
  );
const applyButton = (html: string) => html.match(/<button[^>]*>Apply<\/button>/)?.[0] ?? "";

describe("UIL-140 · where did it leave from", () => {
  it("asks, with both places, and keeps Apply disabled until she answers", () => {
    const html = render({});
    expect(html).toContain("Where did this one leave from?");
    expect(html).toContain("Binder 1 · front · Yellow");
    expect(html).toContain(">Bulk box<");
    expect(html).toContain("1 removed card needs you to pick where it left from.");
    expect(applyButton(html)).toContain("disabled");
    // Not guessed: no refill offer before she says it left the binder.
    expect(html).not.toContain("Pull it into your haul plan");
  });

  it("answered with the binder: Apply is enabled and the bulk refill is offered, defaulting to no", () => {
    const html = render({ retireChoice: { [KEY]: ["binder-1"] } });
    expect(applyButton(html)).not.toContain("disabled");
    expect(html).toContain("Pull it into your haul plan to fill this spot?");
    expect(html).toContain("No, leave it in the box");
    expect(html).toContain("Yes · Bulk box · Normal");
  });

  it("answered with the bulk box: nothing to refill", () => {
    const html = render({ retireChoice: { [KEY]: ["bulk-1"] } });
    expect(applyButton(html)).not.toContain("disabled");
    expect(html).not.toContain("Pull it into your haul plan");
  });
});
