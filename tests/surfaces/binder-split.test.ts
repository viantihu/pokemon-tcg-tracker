/**
 * `binderSplit` must agree with the `binder_section` view EXACTLY (UIL-001, UIL-002).
 *
 * The point of the helper is to show a collector, while she types, what her page/pocket/divider
 * numbers will actually mean. A preview that disagreed with the DB would be worse than no preview —
 * it would teach her a wrong model of her own binders. So the equivalence is not asserted in prose:
 * every case below is run through BOTH the TS helper and the real view on a real Postgres (PGlite,
 * migrations applied), and the numbers must match.
 *
 * It also pins the trap behind UIL-001: a general binder with no divider gets ZERO back-half pockets,
 * so it cannot hold a single evolution line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { binderSplit } from "@/lib/surfaces";
import { asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";

interface Case {
  label: string;
  type: "general" | "specialty";
  pages: number;
  pocketsPerPage: number;
  backHalfStartPage: number | null;
}

const CASES: Case[] = [
  {
    label: "her stated default",
    type: "general",
    pages: 40,
    pocketsPerPage: 9,
    backHalfStartPage: 21,
  },
  // UIL-002: the same physical binder described two ways must total the same pockets.
  {
    label: "40x9 sheets-as-sides",
    type: "general",
    pages: 40,
    pocketsPerPage: 9,
    backHalfStartPage: 21,
  },
  {
    label: "20x18 whole-sheets",
    type: "general",
    pages: 20,
    pocketsPerPage: 18,
    backHalfStartPage: 11,
  },
  // UIL-001: the blank-divider trap.
  {
    label: "no divider set",
    type: "general",
    pages: 40,
    pocketsPerPage: 9,
    backHalfStartPage: null,
  },
  {
    label: "divider on page 1 (all back)",
    type: "general",
    pages: 40,
    pocketsPerPage: 9,
    backHalfStartPage: 1,
  },
  {
    label: "divider past the last page",
    type: "general",
    pages: 40,
    pocketsPerPage: 9,
    backHalfStartPage: 41,
  },
  {
    label: "divider far past the end",
    type: "general",
    pages: 10,
    pocketsPerPage: 9,
    backHalfStartPage: 99,
  },
  {
    label: "divider on the last page",
    type: "general",
    pages: 10,
    pocketsPerPage: 9,
    backHalfStartPage: 10,
  },
  { label: "zero pages", type: "general", pages: 0, pocketsPerPage: 9, backHalfStartPage: null },
  { label: "one page", type: "general", pages: 1, pocketsPerPage: 9, backHalfStartPage: 1 },
  {
    label: "specialty binder",
    type: "specialty",
    pages: 30,
    pocketsPerPage: 9,
    backHalfStartPage: null,
  },
  {
    label: "specialty, divider ignored",
    type: "specialty",
    pages: 30,
    pocketsPerPage: 9,
    backHalfStartPage: 15,
  },
];

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await asSuperuser(db);
});
afterEach(async () => {
  await db.close();
});

/** Insert a binder and read its capacities back out of the real view. */
async function viewCapacities(c: Case): Promise<Record<string, number>> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, OWNER, c.label, c.type, c.pages, c.pocketsPerPage, c.backHalfStartPage],
  );
  const r = await db.query<{ half: string; capacity: number }>(
    `select half, capacity::int as capacity from binder_section where binder_id = $1`,
    [id],
  );
  return Object.fromEntries(r.rows.map((row) => [row.half, row.capacity]));
}

describe("binderSplit agrees with the binder_section view", () => {
  for (const c of CASES) {
    it(`${c.label}: ${c.type} ${c.pages}p x ${c.pocketsPerPage}, divider ${c.backHalfStartPage ?? "(unset)"}`, async () => {
      const fromView = await viewCapacities(c);
      const split = binderSplit(c);

      if (c.type === "specialty") {
        expect(fromView.single).toBe(split.totalPockets);
        expect(fromView.front).toBeUndefined();
        expect(fromView.back).toBeUndefined();
      } else {
        expect(split.frontPockets).toBe(fromView.front);
        expect(split.backPockets).toBe(fromView.back);
        expect(split.totalPockets).toBe(fromView.front + fromView.back);
      }
    });
  }
});

describe("what the split tells the collector", () => {
  it("UIL-001: a general binder with no divider has NO back half, so it can hold no line", async () => {
    const c = CASES.find((x) => x.label === "no divider set")!;
    const split = binderSplit(c);
    expect(split.backPockets).toBe(0);
    expect(split.noBackHalf).toBe(true);
    // Not a rounding artefact of the helper — the view says the same thing.
    expect((await viewCapacities(c)).back).toBe(0);
    // And every pocket silently became front half.
    expect(split.frontPockets).toBe(360);
  });

  it("UIL-002: the same physical binder described two ways totals the same pockets", () => {
    const sides = binderSplit(CASES.find((x) => x.label === "40x9 sheets-as-sides")!);
    const sheets = binderSplit(CASES.find((x) => x.label === "20x18 whole-sheets")!);
    expect(sides.totalPockets).toBe(360);
    expect(sheets.totalPockets).toBe(360);
    // Showing the total live is what makes a 2x mistake visible before it misroutes real cards.
    expect(sides.totalPockets).toBe(sheets.totalPockets);
  });

  it("a specialty binder is one section and is not flagged for having no back half", () => {
    const split = binderSplit(CASES.find((x) => x.label === "specialty binder")!);
    expect(split.totalPockets).toBe(270);
    expect(split.backPockets).toBe(0);
    expect(split.noBackHalf).toBe(false);
  });

  it("survives the junk a number input produces mid-typing", () => {
    const bad = binderSplit({
      type: "general",
      pages: Number.NaN,
      pocketsPerPage: Number.NaN,
      backHalfStartPage: Number.NaN,
    });
    expect(bad).toMatchObject({ frontPockets: 0, backPockets: 0, totalPockets: 0 });
    const negative = binderSplit({
      type: "general",
      pages: -5,
      pocketsPerPage: -9,
      backHalfStartPage: -1,
    });
    expect(negative.totalPockets).toBe(0);
  });
});
