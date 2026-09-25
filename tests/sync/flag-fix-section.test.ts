/**
 * UIL-102 — the Sync preview's "Variant flags corrected" section names every card, so she can find the
 * ones placed under the wrong flag (the Actions log cannot carry card names). Static render of the section.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(ui)/sync/actions", () => ({}));

import { FlagFixSection } from "@/app/(ui)/sync/SyncScreen";

const row = (over: Record<string, unknown> = {}) => ({
  copyId: "c1",
  catalogCardId: "xy7-012",
  name: "Card A",
  setName: "Ancient Origins",
  imageUrl: null,
  localId: "012",
  setCardCountOfficial: 98,
  bandKey: "red",
  dexVariantRaw: "Holo",
  change: "recorded as Normal, now Holo",
  placedNote: "was placed while recorded as Normal; check its pocket (Binder 1 · front · Red)",
  ...over,
});

describe("UIL-102 · the preview names each corrected card", () => {
  it("name, set, number, Dex variant and the change, with the placed note", () => {
    const html = renderToStaticMarkup(createElement(FlagFixSection, { rows: [row()] }));
    expect(html).toContain("Variant flags corrected · nothing moved");
    expect(html).toContain("Card A · Ancient Origins");
    expect(html).toContain("012/98");
    expect(html).toContain("Dex: Holo · recorded as Normal, now Holo");
    expect(html).toContain("check its pocket (Binder 1 · front · Red)");
  });

  it("a card still in her haul has no pocket note", () => {
    const html = renderToStaticMarkup(
      createElement(FlagFixSection, { rows: [row({ placedNote: null })] }),
    );
    expect(html).not.toContain("check its pocket");
  });
});
