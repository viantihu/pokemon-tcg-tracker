/**
 * UIL-098 — the pure half of "Backfill places what is waiting": grouping the Haul Plan's queue by
 * (printing, Dex variant), the type-ahead over it, the copy taker, and the refusal's wording.
 */
import { describe, expect, it } from "vitest";
import {
  demandsOf,
  groupWaiting,
  matchWaiting,
  notWaitingMessage,
  shortagesOf,
  takerFor,
} from "@/lib/backfill";
import type { PendingPlacement } from "@/lib/plan/pending";
import type { Row } from "@/lib/repo";

const row = (tcgdexId: string, name: string, localId: string, setName = "Obsidian Flames") =>
  ({ tcgdex_id: tcgdexId, name, local_id: localId, set_name: setName }) as Row<"catalog_card">;

const CHARMANDER = row("sv03-026", "Charmander", "026");
const CHARMELEON = row("sv03-027", "Charmeleon", "027");
const ARVEN = row("sv03-186", "Arven", "186");

const pending = (
  copyId: string,
  card: Row<"catalog_card">,
  raw: string | null,
): PendingPlacement => ({
  copyId,
  tcgdexId: card.tcgdex_id,
  variant: "normal",
  dexVariantRaw: raw,
  acquiredAt: null,
  card,
});

// The queue's own order (oldest first), which grouping must keep within a key.
const QUEUE = [
  pending("c1", CHARMANDER, "Normal"),
  pending("c2", CHARMELEON, "Normal"),
  pending("c3", CHARMANDER, "Reverse Holo"),
  pending("c4", CHARMANDER, "Normal"),
  pending("c5", ARVEN, null),
];

describe("groupWaiting · the Haul Plan's queue, by key", () => {
  it("one entry per (printing, Dex variant), copies in the queue's order", () => {
    const pool = groupWaiting(QUEUE);
    const keys = [...pool.values()].map((w) => [w.tcgdexId, w.dexVariantRaw, w.copyIds]);
    expect(keys).toEqual([
      ["sv03-026", "Normal", ["c1", "c4"]],
      ["sv03-027", "Normal", ["c2"]],
      ["sv03-026", "Reverse Holo", ["c3"]],
      ["sv03-186", "normal", ["c5"]], // no Dex variant stored → keyed by its app variant, not dropped
    ]);
  });
});

describe("matchWaiting · the type-ahead over her haul", () => {
  const pool = groupWaiting(QUEUE);

  it("a printed number finds that number exactly, every variant of it", () => {
    const hits = matchWaiting("026", pool).map((w) => `${w.tcgdexId} ${w.dexVariantRaw}`);
    expect(hits).toEqual(["sv03-026 Normal", "sv03-026 Reverse Holo"]);
  });

  it("a printed number with its set total works the same (the catalog search's grammar)", () => {
    expect(matchWaiting("026/197", pool).map((w) => w.tcgdexId)).toEqual(["sv03-026", "sv03-026"]);
  });

  it("an exact printed number ranks above a card whose number merely contains it", () => {
    // Abra sorts first by name, and "126" contains "26"; the exact 026 must still come first.
    const withAbra = groupWaiting([
      ...QUEUE,
      pending("c6", row("sv03-126", "Abra", "126"), "Normal"),
    ]);
    expect(matchWaiting("26", withAbra).map((w) => w.card.name)).toEqual([
      "Charmander",
      "Charmander",
      "Abra",
    ]);
  });

  it("a name matches by substring, case-insensitively", () => {
    expect(matchWaiting("CHARM", pool).map((w) => w.card.name)).toEqual([
      "Charmander",
      "Charmander",
      "Charmeleon",
    ]);
  });

  it("finds nothing for a card that is not waiting, and nothing for a one-letter query", () => {
    expect(matchWaiting("Pikachu", pool)).toEqual([]);
    expect(matchWaiting(" ", pool)).toEqual([]);
  });
});

describe("takerFor · hands out each key's copies oldest first", () => {
  it("in the queue's order, and says so when a key runs dry", () => {
    const take = takerFor(groupWaiting(QUEUE));
    expect(take("sv03-026", "Normal")).toBe("c1");
    expect(take("sv03-026", "Normal")).toBe("c4");
    expect(() => take("sv03-026", "Normal")).toThrow(/ran out of waiting copies/);
    expect(take("sv03-026", "Reverse Holo")).toBe("c3");
  });
});

describe("shortagesOf + notWaitingMessage · the refusal", () => {
  const pool = groupWaiting(QUEUE);
  const name = (id: string) => ({ "sv03-026": "Charmander", "sv03-999": "Mew" })[id] ?? id;

  it("counts pockets per key, and flags only the keys asked for beyond what waits", () => {
    const d = demandsOf([
      { tcgdexId: "sv03-026", dexVariantRaw: "Normal" },
      { tcgdexId: "sv03-026", dexVariantRaw: "Normal" },
      { tcgdexId: "sv03-026", dexVariantRaw: "Normal" },
      { tcgdexId: "sv03-026", dexVariantRaw: "Reverse Holo" },
    ]);
    expect(shortagesOf(d, pool)).toEqual([
      { tcgdexId: "sv03-026", dexVariantRaw: "Normal", asked: 3, waiting: 2 },
    ]);
  });

  it("names the card and variant, and gives the line's remedy for a line", () => {
    expect(
      notWaitingMessage(
        [{ tcgdexId: "sv03-999", dexVariantRaw: "Holo", asked: 1, waiting: 0 }],
        name,
        "line",
      ),
    ).toBe(
      "Mew (Holo) is not waiting in your haul. Add it in Dex, import it on the Sync page, then save this line.",
    );
  });

  it("says how many were placed and how many wait, and 'them' for more than one card", () => {
    expect(
      notWaitingMessage(
        [{ tcgdexId: "sv03-026", dexVariantRaw: "Normal", asked: 4, waiting: 2 }],
        name,
        "list",
      ),
    ).toBe(
      "You placed 4 Charmander (Normal), but only 2 are waiting in your haul. Add them in Dex, import " +
        "them on the Sync page, then save again.",
    );
  });
});
