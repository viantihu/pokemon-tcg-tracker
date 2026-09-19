/**
 * UIL-011 — Karvi: "I want to remove all language about pull from catalog mirror. The end user does not
 * need to know these things." The mirror, the sync run, "self-heal": implementation, not something the
 * reader of an empty state should have to reason about — and "needs a sync run" told her to act on a
 * search that had simply missed (UIL-010's exact moment).
 *
 * Two layers. The RENDERED layer drives the states a static render can reach — the grid's searching and
 * no-match states, the Lookup tab's NO MATCH notice — and asserts the words are gone from what she sees.
 * The SOURCE layer scans every touched screen's non-comment lines, because three of the six strings live
 * in states a static render cannot reach (an error banner set inside an action handler, the sync
 * preview's unresolved summary, the wishlist footer). Code comments and module docs keep "mirror": there
 * it is the precise term for what the code does; only what renders is in scope. "catalog" alone stays
 * where it means the set of cards that exist ("Waiting on catalog").
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardResultTiles } from "@/app/(ui)/_components/CardResultsGrid";
import { LookupNotice } from "@/app/(ui)/look/LookupScreen";

const PLUMBING = /mirror|sync run|self-heal/i;

describe("UIL-011 · what she reads never mentions the plumbing", () => {
  it("the type-ahead's searching state", () => {
    const html = renderToStaticMarkup(
      createElement(CardResultTiles, {
        results: [],
        loading: true,
        failed: null,
        onPick: () => {},
      }),
    );
    expect(html).toContain("Searching…");
    expect(html).not.toMatch(PLUMBING);
  });

  it("the type-ahead's no-match state says what to try, not what to run", () => {
    const html = renderToStaticMarkup(
      createElement(CardResultTiles, {
        results: [],
        loading: false,
        failed: null,
        onPick: () => {},
      }),
    );
    expect(html).toContain("No card found — check the number or try the card name.");
    expect(html).not.toMatch(PLUMBING);
  });

  it("the Lookup tab's NO MATCH notice", () => {
    const html = renderToStaticMarkup(createElement(LookupNotice, { kind: "notfound" }));
    expect(html).toContain("NO MATCH");
    expect(html).toContain("No card found — check the number or try the card name.");
    expect(html).not.toMatch(PLUMBING);
  });
});

describe("UIL-011 · every touched screen, non-comment source: no rendered string can say it either", () => {
  const screens = [
    "../../app/(ui)/_components/CardResultsGrid.tsx",
    "../../app/(ui)/look/LookupScreen.tsx",
    "../../app/(ui)/backfill/BackfillScreen.tsx",
    "../../app/(ui)/sync/SyncScreen.tsx",
    "../../app/(ui)/coll/CollHub.tsx",
  ];
  /** Lines that are code or JSX text, not comments: line comments, block-comment bodies, JSX comment wrappers. */
  const renderable = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l));

  for (const file of screens) {
    it(file.split("/").pop()!, () => {
      const offenders = renderable(file).filter((l) => PLUMBING.test(l));
      expect(offenders).toEqual([]);
    });
  }

  it("the three strings a static render cannot reach are the new words", () => {
    const backfill = renderable(screens[2]).join("\n");
    const sync = renderable(screens[3]).join("\n");
    const coll = renderable(screens[4]).join("\n");
    expect(backfill).toContain("Could not find that species' evolution line.");
    // JSX text, so prettier may wrap it anywhere: match across whitespace.
    expect(sync).toMatch(
      /they\s+resolve\s+automatically\s+once\s+the\s+card\s+is\s+in\s+the\s+catalog\./,
    );
    expect(coll).toContain("CSV EXPORTS BACK INTO DEX FOR SCANNING");
  });
});
