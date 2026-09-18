/**
 * UIL-047 C3 (second half) — the Sync screen shows every learned set alias and offers to forget it, and
 * a "needs your match" entry says which alias its known set rests on.
 *
 * Static render only (`renderToStaticMarkup` never runs effects or clicks), so what is pinned here is
 * the resting state: the panel lists each alias with its provenance and its consequence count, the hint
 * lands on exactly the entries under a LEARNED alias, and the consequence copy is NOT on screen until she
 * opens it — the forget is two-step by design, and this is the half of that design a render can prove.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncScreen } from "@/app/(ui)/sync/SyncScreen";
import type { QueueEntryView, SyncState } from "@/app/(ui)/sync/sync-types";

function entry(over: Partial<QueueEntryView>): QueueEntryView {
  return {
    id: "e1",
    dexId: "jpn_m6-12",
    dexName: "Pawmi",
    dexSetName: "Battle Academy",
    dexSeries: "",
    dexNumber: "012",
    dexVariantRaw: "",
    quantity: 1,
    locale: "ja",
    reason: "UNKNOWN_CARD",
    status: "WAITING",
    firstSeenSync: "2026-09-14T21:18:56.000Z",
    lastRetrySync: null,
    retryCount: 0,
    manualMatchId: null,
    aliasKey: "ja:m6",
    ...over,
  };
}

function state(over: Partial<SyncState>): SyncState {
  return {
    waiting: { unknownSet: [], unknownCard: [] },
    dismissed: [],
    counts: { waiting: 0, dismissed: 0 },
    undo: { available: false, createdAt: null, summary: null },
    aliases: [],
    ...over,
  };
}

const LIVE = state({
  waiting: {
    unknownSet: [],
    unknownCard: [
      entry({ id: "under-alias", aliasKey: "ja:m6" }),
      entry({ id: "not-learned", dexId: "sv04-099", dexName: "Minior", aliasKey: "en:sv04" }),
    ],
  },
  counts: { waiting: 2, dismissed: 0 },
  aliases: [
    {
      locale: "ja",
      dexCode: "m6",
      tcgdexSetId: "swshp",
      source: "manual",
      createdAt: "2026-09-14T21:18:56.000Z",
      dexSetName: "Battle Academy",
      reparks: 2,
    },
    {
      locale: "en",
      dexCode: "xy7",
      tcgdexSetId: "xy7",
      source: "name-resolved",
      createdAt: "2026-09-10T00:00:00.000Z",
      dexSetName: null,
      reparks: 0,
    },
  ],
});

const render = (s: SyncState) =>
  renderToStaticMarkup(createElement(SyncScreen, { initialState: s }));

describe("UIL-047 C3 · learned aliases are visible and forgettable from the Sync screen", () => {
  it("lists each alias with where it came from, the set she knows it by, and what forgetting changes", () => {
    const html = render(LIVE);
    expect(html).toContain("LEARNED SET ALIASES");
    expect(html).toContain("2 learned");
    expect(html).toContain("m6 → swshp");
    expect(html).toContain("YOU TAUGHT IT");
    expect(html).toContain("Japanese");
    expect(html).toContain("Battle Academy");
    expect(html).toContain("2 waiting card(s) resolve through it");
    expect(html).toContain("xy7 → xy7");
    expect(html).toContain("FROM THE SET NAME");
    // One Forget control per alias.
    expect(html.match(/Forget…/g)?.length).toBe(2);
  });

  it("keeps the consequences off screen until she opens them — forgetting is two-step", () => {
    const html = render(LIVE);
    expect(html).not.toContain("go back to");
    expect(html).not.toContain("Forget alias");
  });

  it("marks exactly the 'needs your match' entries whose set rests on a learned alias", () => {
    const html = render(LIVE);
    const hint = "set known through the learned alias m6 → swshp";
    expect(html.split(hint).length - 1).toBe(1);
    // The Minior entry (en:sv04, no learned alias) gets no hint at all.
    expect(html).not.toContain("learned alias sv04");
  });

  it("says so plainly when nothing has been learned", () => {
    const html = render(state({}));
    expect(html).toContain("Nothing learned yet");
    expect(html).not.toContain("Forget…");
  });
});
