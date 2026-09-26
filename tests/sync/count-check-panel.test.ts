/**
 * UIL-100 — what the Sync page SAYS. Static render of the Count check panel in its three states: never
 * silent, the whole sum shown, every disagreeing card named with extra or missing, and advice that is not
 * a dead end (it must never send her to "remove" a card from her import, which records it as traded away).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountCheckPanel } from "@/app/(ui)/sync/CountCheckPanel";
import { emptyCountCheck, type CountCheckView } from "@/lib/sync/count-check";

const render = (check: CountCheckView) =>
  renderToStaticMarkup(createElement(CountCheckPanel, { check })).replace(/<!-- -->/g, "");

describe("UIL-100 · the Count check panel", () => {
  it("before her first import it says the check starts at her next one, and asks for one re-import", () => {
    expect(render(emptyCountCheck())).toContain("starts at your next import");
    expect(render(emptyCountCheck())).toContain("Re-import your Dex file once");
  });

  it("when it adds up it shows the whole sum", () => {
    const html = render({
      ...emptyCountCheck(),
      status: "ok",
      fileTotal: 710,
      inCollection: 700,
      waiting: 8,
      removed: 2,
      importedAt: "2026-09-25T00:00:00Z",
    });
    expect(html).toContain("Your collection adds up to your Dex file.");
    expect(html).toMatch(
      /Dex file <b>710<\/b> = <b>700<\/b> in your collection \+ <b>8<\/b> waiting/,
    );
    expect(html).toContain("<b>2</b> you removed");
  });

  it("when it does not, it names every card, says extra or missing, and points at re-import, not removal", () => {
    const html = render({
      ...emptyCountCheck(),
      status: "mismatch",
      fileTotal: 3,
      inCollection: 4,
      importedAt: "2026-09-25T00:00:00Z",
      mismatches: [
        {
          catalogCardId: "sv03-026",
          dexVariantRaw: "Normal",
          dex: 2,
          removed: 0,
          have: 3,
          expected: 2,
          direction: "extra",
          name: "Charmander",
          setName: "Obsidian Flames",
          localId: "026",
        },
        {
          catalogCardId: "sv03-027",
          dexVariantRaw: "Reverse Holo",
          dex: 1,
          removed: 0,
          have: 0,
          expected: 1,
          direction: "missing",
          name: "Charmeleon",
          setName: "Obsidian Flames",
          localId: "027",
        },
      ],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("does not add up");
    expect(html).toContain("Charmander · Obsidian Flames 026 · Normal");
    expect(html).toContain("Dex says 2, you have 3 (1 extra)");
    expect(html).toContain("Charmeleon · Obsidian Flames 027 · Reverse Holo");
    expect(html).toContain("Dex says 1, you have 0 (1 missing)");
    expect(html).toContain("import your Dex file again");
    // The repair path for an extra copy is a re-import (its preview takes the extra out), never "remove".
    expect(html).toContain("the preview lists the extra copies and takes them out when you apply");
    expect(html).toContain("do not remove one yourself");
    expect(html).not.toMatch(/remove a duplicate/);
  });

  it("names cards that are not linked to the import, and sends them to be reported, not to a Merge that is gone", () => {
    const html = render({
      ...emptyCountCheck(),
      status: "mismatch",
      fileTotal: 1,
      ungroupedCopies: 2,
      importedAt: "x",
    });
    expect(html).toContain("2 cards are in your collection without a link to your Dex import");
    // UIL-103 removed Lookup's Merge; since 0023 an unlinked card can only be a fault, so she reports it.
    expect(html).not.toMatch(/Merge/);
    expect(html).toContain("report it (UIL-100)");
  });
});
