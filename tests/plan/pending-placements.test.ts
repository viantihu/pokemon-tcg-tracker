/**
 * UIL-003 — the pending-placement queue reads exactly the copies that still need a home.
 *
 * The subtle part is not "find the unplaced copies", it is telling an untouched sync add apart from a
 * card the cascade deliberately routed TO bulk: both are `role: 'bulk'` with no binder and no slot.
 * The discriminator is the `placement_decision` row, so these tests pin that, plus the ordering and
 * the catalog join. Run against a fake `DbClient` (the pattern from tests/sync/exec-atomicity.test.ts)
 * because the logic under test is the composition, not the SQL — the SQL-level behaviour is covered on
 * real Postgres in ./route-existing-copies.test.ts.
 */
import { describe, expect, it } from "vitest";
import { loadPendingPlacements } from "@/lib/plan";
import type { DbClient } from "@/lib/repo";

/** Thenable builder over an in-memory row set: eq / is / in filtering, order ignored (rows presorted). */
class FakeQuery {
  private filters: ((r: Record<string, unknown>) => boolean)[] = [];
  private columns: string[] | null = null;
  constructor(private rows: Record<string, unknown>[]) {}
  select(cols: string) {
    this.columns = cols === "*" ? null : cols.split(",").map((c) => c.trim());
    return this;
  }
  order() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }
  private filtered() {
    const rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (!this.columns) return rows;
    return rows.map((r) => Object.fromEntries(this.columns!.map((c) => [c, r[c] ?? null])));
  }
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve({ data: this.filtered(), error: null }).then(resolve);
  }
}

function fakeDb(store: Record<string, Record<string, unknown>[]>): DbClient {
  return {
    from: (table: string) => new FakeQuery(store[table] ?? []),
  } as unknown as DbClient;
}

/** A copy row as sync leaves it: unplaced, no haul. */
function copy(id: string, cardId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    catalog_card_id: cardId,
    variant: "normal",
    dex_variant_raw: "Reverse Holo",
    role: "bulk",
    binder_id: null,
    binder_half: null,
    color_band: null,
    line_slot_id: null,
    haul_id: null,
    acquired_at: "2026-09-13T00:00:00.000Z",
    created_at: "2026-09-13T00:00:00.000Z",
    ...over,
  };
}

const CARD = (id: string, name: string) => ({
  tcgdex_id: id,
  name,
  set_id: "sv03",
  set_name: "Obsidian Flames",
  local_id: "026",
  stage: "Basic",
  types: ["Fire"],
  card_class: "standard",
  image_url: null,
  variants: { normal: true, reverse: true },
  dex_id: [4],
});

describe("loadPendingPlacements (UIL-003)", () => {
  it("returns the unplaced copies sync created, with their catalog printing", async () => {
    const db = fakeDb({
      copy: [copy("copy-a", "sv03-026")],
      placement_decision: [],
      catalog_card: [CARD("sv03-026", "Charmander")],
    });

    const pending = await loadPendingPlacements(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      copyId: "copy-a",
      tcgdexId: "sv03-026",
      variant: "normal",
      dexVariantRaw: "Reverse Holo",
    });
    expect(pending[0].card.name).toBe("Charmander");
  });

  it("EXCLUDES an unplaced copy the cascade already ruled on — a decision means it was routed to bulk", async () => {
    const db = fakeDb({
      copy: [copy("copy-a", "sv03-026"), copy("copy-b", "sv03-026")],
      // copy-b was worked through the plan and the cascade sent it to the bulk box on purpose. Its
      // placement columns look identical to copy-a's; only the audit row distinguishes them.
      placement_decision: [{ id: "d1", copy_id: "copy-b", decision: "duplicate" }],
      catalog_card: [CARD("sv03-026", "Charmander")],
    });

    const pending = await loadPendingPlacements(db);
    expect(pending.map((p) => p.copyId)).toEqual(["copy-a"]);
  });

  it("ignores copies that already hold a placement", async () => {
    const db = fakeDb({
      copy: [
        copy("shelved", "sv03-026", { role: "shelved", binder_id: "b1", binder_half: "front" }),
        copy("in-a-line", "sv03-026", { line_slot_id: "slot-1" }),
        copy("blocked", "sv03-026", { role: "block" }),
        copy("waiting", "sv03-026"),
      ],
      placement_decision: [],
      catalog_card: [CARD("sv03-026", "Charmander")],
    });

    const pending = await loadPendingPlacements(db);
    expect(pending.map((p) => p.copyId)).toEqual(["waiting"]);
  });

  it("drops a copy whose catalog row is missing rather than surfacing a card it cannot describe", async () => {
    const db = fakeDb({
      copy: [copy("copy-a", "sv03-026"), copy("copy-orphan", "not-in-the-mirror")],
      placement_decision: [],
      catalog_card: [CARD("sv03-026", "Charmander")],
    });

    const pending = await loadPendingPlacements(db);
    expect(pending.map((p) => p.copyId)).toEqual(["copy-a"]);
  });

  it("short-circuits with no queries to run when nothing is unplaced", async () => {
    const db = fakeDb({ copy: [], placement_decision: [], catalog_card: [] });
    expect(await loadPendingPlacements(db)).toEqual([]);
  });

  it("chunks the decision and catalog lookups so a big first sync does not build one huge filter", async () => {
    // 250 unplaced copies across 250 printings: 3 chunks of 100 for each lookup.
    const copies = Array.from({ length: 250 }, (_, i) =>
      copy(`copy-${String(i).padStart(3, "0")}`, `sv03-${String(i).padStart(3, "0")}`),
    );
    const cards = copies.map((c, i) => CARD(c.catalog_card_id as string, `Card ${i}`));
    let inCalls = 0;
    const store: Record<string, Record<string, unknown>[]> = {
      copy: copies,
      placement_decision: [],
      catalog_card: cards,
    };
    const db = {
      from: (table: string) => {
        const q = new FakeQuery(store[table] ?? []);
        const origIn = q.in.bind(q);
        q.in = (col: string, vals: unknown[]) => {
          inCalls += 1;
          expect(vals.length).toBeLessThanOrEqual(100);
          return origIn(col, vals);
        };
        return q;
      },
    } as unknown as DbClient;

    const pending = await loadPendingPlacements(db);
    expect(pending).toHaveLength(250);
    expect(inCalls).toBe(6); // 3 decision chunks + 3 catalog chunks
  });
});
