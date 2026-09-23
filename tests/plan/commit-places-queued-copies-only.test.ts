/**
 * UIL-098 part 2 — the Haul Plan's commit places a copy her Dex import made, and never creates one.
 * UIL-092 part 2 — pressing Done twice on one card places it once.
 *
 * Karvi: "If adding cards in the haul plan will cause data integrity issues, that option should not
 * exist." A card typed into the Plan became a copy in no presence group, so the next Dex import could not
 * see it and created a SECOND one when Dex listed the card. The form is gone from the screen
 * (tests/plan/plan-has-no-add-form.test.ts); these pin the SERVER half, which is the one that matters,
 * because a stale tab or a hand-built request reaches `commitCardPlacement` without the form.
 *
 * UIL-092 part 2 was fixed for typed rows by writing the copy at the row's own id, so a re-press collided
 * with itself. With typed rows gone the same failure has one shape left: Done lands, the response is lost,
 * she presses again. The second press must write nothing — not a second decision, and not a second
 * placement that re-derives against the state the first one created and MOVES the card.
 *
 * Against the REAL `apply_write_ops` RPC on real Postgres (PGlite) as the authenticated owner, the pattern
 * band-mismatch-ask.test.ts established: a hand-rolled applier would prove only that the ops match my
 * expectation, not that the function running in production accepts them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import { NOT_A_HAUL_COPY } from "@/lib/plan/commit";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  count,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";

/** Two copies of ONE printing, as a Dex row with quantity 2 leaves them in her haul. */
const FIRST = haulRow("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", CHARMANDER_SV03_026.tcgdexId);
const SECOND = haulRow("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", CHARMANDER_SV03_026.tcgdexId);

/** A row she typed on a build before UIL-098 part 2: no copy behind it. */
const TYPED: DraftItem = {
  id: "cccccccc-3333-4333-8333-cccccccccccc",
  tcgdexId: CHARMANDER_SV03_026.tcgdexId,
  variant: "normal",
} as DraftItem;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

interface CopyRow {
  id: string;
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  color_band: string | null;
  line_slot_id: string | null;
  presence_group_id: string | null;
}
async function copies(): Promise<CopyRow[]> {
  await asSuperuser(db);
  const r = await db.query<CopyRow>(
    `select id, role, binder_id, binder_half, color_band, line_slot_id, presence_group_id
       from copy order by id`,
  );
  return r.rows;
}
async function tally(table: string): Promise<number> {
  await asSuperuser(db);
  return count(db, table);
}

describe("UIL-098 · the Plan's commit refuses a row that is not a copy in her haul", () => {
  it("a hand-typed row is refused, and NOTHING is written — no copy, no decision, no haul", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    // PRE-FIX: this inserted a copy with no presence group, stamped with a freshly opened haul.
    await expect(commitCardPlacement(client, { card: TYPED })).rejects.toThrow(
      NOT_A_HAUL_COPY.notFromImport,
    );
    expect(await copies()).toEqual([]);
    expect(await tally("placement_decision")).toBe(0);
    expect(await tally("haul")).toBe(0);
  });

  it("the refusal tells her where the card has to come from", () => {
    // Her remedy, in the words the screen shows: the card is fixed in Dex, then imported.
    expect(NOT_A_HAUL_COPY.notFromImport).toContain("Dex");
    expect(NOT_A_HAUL_COPY.notFromImport).toContain("Sync page");
  });

  it("the exported payload builder refuses a typed row too, so no other caller can bypass the guard", async () => {
    await asSuperuser(db);
    const pc = await loadPlanContext(pgliteClient(db));
    const { planned } = planFromDraft(pc, [TYPED]);
    expect(() => buildHaulCommitPayload(pc, planned, { draft: [TYPED] })).toThrow(
      NOT_A_HAUL_COPY.notFromImport,
    );
  });

  it("a row whose copy has gone since the plan was run is refused, and nothing is written", async () => {
    // Removed ("Not mine", UIL-089) or merged away in another tab after she ran the plan. There is nothing
    // to place, and placing would have to invent the copy.
    const client = pgliteClient(db);
    await asOwner(db);
    await expect(commitCardPlacement(client, { card: FIRST })).rejects.toThrow(
      NOT_A_HAUL_COPY.copyGone,
    );
    expect(await copies()).toEqual([]);
    expect(await tally("placement_decision")).toBe(0);
  });

  it("a queued copy is PLACED in place: same row, same presence group, no copy created", async () => {
    await asSuperuser(db);
    await seedHaulRows(db, [FIRST]);
    const before = await copies();

    const client = pgliteClient(db);
    await asOwner(db);
    const res = await commitCardPlacement(client, { card: FIRST });

    const after = await copies();
    expect(after.map((c) => c.id)).toEqual([FIRST.id]);
    expect(after[0].role).not.toBe("haul");
    // The group is what the next import reconciles against (lib/sync/pipeline.ts loadCurrentGroups).
    expect(after[0].presence_group_id).toBe(before[0].presence_group_id);
    expect(res.counts.routed).toBe(1);
    expect(res.alreadyCommitted).toBeUndefined();
    expect(await tally("haul")).toBe(0);
  });
});

describe("UIL-092 · pressing Done twice places the card once", () => {
  it("a re-press after a lost response writes nothing and reports success", async () => {
    await asSuperuser(db);
    await seedHaulRows(db, [FIRST]);
    const client = pgliteClient(db);
    await asOwner(db);
    await commitCardPlacement(client, { card: FIRST });
    const placed = await copies();
    const decisions = await tally("placement_decision");

    // Exactly what the screen does when the response never arrived: same row, pressed again.
    await asOwner(db);
    const second = await commitCardPlacement(client, { card: FIRST });

    expect(second.alreadyCommitted).toBe(true);
    expect(second.counts).toEqual({ routed: 0, lines: 0, slots: 0, wishlist: 0, decisions: 0 });
    expect(await tally("placement_decision")).toBe(decisions);
    // Not re-derived: the card stays in the pocket the first press put it in.
    expect(await copies()).toEqual(placed);
  });

  it("a card the cascade sent to the BULK BOX is placed too — a re-press does not re-route it", async () => {
    // "Placed" is every role but 'haul' (`isPlaced`), not only 'shelved'. A duplicate goes to bulk, and a
    // re-press that read bulk as "still waiting" would run the cascade again and audit it twice.
    await asSuperuser(db);
    await seedHaulRows(db, [FIRST, SECOND]);
    const client = pgliteClient(db);
    await asOwner(db);
    await commitCardPlacement(client, { card: FIRST });
    await asOwner(db);
    await commitCardPlacement(client, { card: SECOND });
    const placed = await copies();
    // The fixture has to reach the predicate: the second copy of one printing is a duplicate.
    expect(placed.find((c) => c.id === SECOND.id)?.role).toBe("bulk");
    const decisions = await tally("placement_decision");

    await asOwner(db);
    const again = await commitCardPlacement(client, { card: SECOND });

    expect(again.alreadyCommitted).toBe(true);
    expect(await tally("placement_decision")).toBe(decisions);
    expect(await copies()).toEqual(placed);
  });

  it("TWO queued copies of the SAME printing both place — the key is the copy, never the card", async () => {
    // She legitimately owns duplicates. Deduplicating by catalog card would strand the second one.
    await asSuperuser(db);
    await seedHaulRows(db, [FIRST, SECOND]);
    const client = pgliteClient(db);
    await asOwner(db);
    const a = await commitCardPlacement(client, { card: FIRST });
    await asOwner(db);
    const b = await commitCardPlacement(client, { card: SECOND });

    expect(a.alreadyCommitted).toBeUndefined();
    expect(b.alreadyCommitted).toBeUndefined();
    expect((await copies()).filter((c) => c.role === "haul")).toEqual([]);
    expect(await tally("copy")).toBe(2);
    expect(await tally("placement_decision")).toBe(2);
  });
});
