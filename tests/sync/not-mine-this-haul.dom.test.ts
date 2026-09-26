// @vitest-environment jsdom
/**
 * UIL-111, what she sees — "Not mine" is for this haul only, so she is told at the moment she decides, and the
 * import that brings a card back names it before she applies. Driven through the REAL components in a DOM.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOT_MINE_LASTS_THIS_HAUL,
  RemoveCopyButton,
} from "@/app/(ui)/_components/RemoveCopyButton";
import { ReturningSection } from "@/app/(ui)/sync/SyncScreen";
import { RETURNING_NOTE } from "@/lib/sync/preview";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/(ui)/sync/actions", () => ({}));

afterEach(cleanup);

describe("UIL-111 · the Not mine confirm says it lasts for this haul", () => {
  it("the second tap names what happens at the next import (the Senior BA's wording)", async () => {
    const user = userEvent.setup();
    render(
      createElement(RemoveCopyButton, { onRemove: vi.fn(), label: "Not mine", what: "Meditite" }),
    );
    await user.click(screen.getByRole("button", { name: /Remove Meditite/ }));
    expect(screen.getByText(/Remove Meditite\?/).textContent).toContain(NOT_MINE_LASTS_THIS_HAUL);
    expect(NOT_MINE_LASTS_THIS_HAUL).toBe(
      "If your Dex file still lists it, your next import brings it back.",
    );
  });
});

describe("UIL-111 · the preview names each card coming back", () => {
  it("with the note, the card, its set and number, its Dex variant and how many", () => {
    render(
      createElement(ReturningSection, {
        rows: [
          {
            catalogCardId: "sv03-026",
            name: "Charmander",
            setName: "Obsidian Flames",
            imageUrl: null,
            localId: "026",
            setCardCountOfficial: 197,
            bandKey: "red",
            dexVariantRaw: "Normal",
            count: 1,
          },
        ],
      }),
    );
    expect(screen.getByText(/Coming back · you marked these Not mine/)).toBeTruthy();
    expect(screen.getByText(RETURNING_NOTE)).toBeTruthy();
    expect(document.body.textContent).toContain("Charmander · Obsidian Flames");
    expect(document.body.textContent).toContain("026/197");
    expect(document.body.textContent).toContain("Dex: Normal · ×1");
  });
});
