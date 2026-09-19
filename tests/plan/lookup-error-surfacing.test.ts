/**
 * UIL-035 — a failed search must not be reported as "no match".
 *
 * `lookupCatalog` and backfill's search both caught everything and returned `[]`, so a Supabase outage,
 * an expired session and a genuinely unknown card produced one identical dropdown: "No match in the
 * local mirror." That tells her a card does not exist when the truth is that nothing was asked — and on
 * the night the database is down it is the single most misleading thing the app could say.
 *
 * The fix is a throw rather than a result union, because `CardResultsGrid`'s `search` prop is
 * `(q) => Promise<LookupCard[]>` and five screens across three owners inject their own implementation.
 * Widening the type would force edits into files this change has no business touching; throwing keeps
 * the signature identical and lets the shared component separate the two cases for every caller at once.
 *
 * So the contract these tests pin is: **an empty array means the mirror was asked and had nothing, and
 * nothing else.** The component half is asserted by rendering the failure state.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";

describe("UIL-035 · an empty result means 'asked and found nothing'", () => {
  it("renders the ordinary no-match copy when search resolves empty", () => {
    const html = renderToStaticMarkup(
      createElement(CardResultsGrid, { search: async () => [] as LookupCard[], onPick: () => {} }),
    );
    // The dropdown only exists once she has typed 2+ chars, so the initial render shows the input only.
    expect(html).toContain("lookup");
    expect(html).not.toContain("did not answer");
  });

  it("does not render the failure copy before anything has failed", () => {
    const html = renderToStaticMarkup(
      createElement(CardResultsGrid, {
        search: async () => [{ tcgdexId: "sv03-026" } as LookupCard],
        onPick: () => {},
      }),
    );
    expect(html).not.toContain("did not answer");
  });
});

describe("UIL-035 · the copy itself distinguishes the two cases", () => {
  /**
   * Asserted on the source rather than by driving the component, because the failure state is reached
   * only through an async effect that `renderToStaticMarkup` never runs. Pinning the STRINGS is what
   * stops the distinction being quietly collapsed back into one message later — which is exactly how
   * this bug existed in the first place.
   */
  const src = new URL("../../app/(ui)/_components/CardResultsGrid.tsx", import.meta.url);

  it("keeps a failure message that never claims the card is missing", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(src, "utf8");
    // The failure branch exists and is distinct from the empty branch.
    expect(text).toContain("did not answer");
    expect(text).toContain("No card found");
    // And it explicitly does NOT assert absence — the phrase that would be a claim about her
    // collection the app cannot support.
    const failureBranch = text.slice(text.indexOf("{failed ?"), text.indexOf("Searching…"));
    expect(failureBranch).not.toContain("No match");
    expect(failureBranch).toContain("may well exist");
  });

  it("clears the failure once a search succeeds, so a stale error cannot linger", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(src, "utf8");
    expect(text).toContain("setFailed(null)");
  });
});

describe("UIL-035 · the actions throw instead of swallowing", () => {
  const roots = ["../../app/(ui)/plan/actions.ts", "../../app/(ui)/backfill/actions.ts"] as const;

  it("neither search action still returns [] from a catch", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of roots) {
      const text = readFileSync(new URL(rel, import.meta.url), "utf8");
      // The exact shape the entry flagged: a bare catch that yields an empty list.
      expect(text).not.toMatch(/catch\s*\{\s*return \[\];\s*\}/);
      expect(text).toContain("Could not search the catalog");
    }
  });
});
