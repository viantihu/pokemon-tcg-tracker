/**
 * Migration 0011 — relink a shelved back-half copy to the placeholder slot that names exactly it, and
 * ONLY where the pairing is unambiguous in both directions (UIL-062 follow-up).
 *
 * The uniqueness guard is the substance of this migration, not a safety rail around it. The pre-flight
 * on Testing found 3 strictly-1:1 pairs, 2 where one placeholder is wanted by SEVERAL copies, and 3 with
 * no candidate slot at all. So the skip branch is LIVE on her real data — without it, 2 pairs would have
 * been guessed, and a wrong pairing is worse than leaving a card unlinked.
 *
 * The tests are therefore weighted the other way round from what the feature description suggests: one
 * test proves it pairs, and four prove it REFUSES to. The most important assertions here are the
 * negative ones.
 *
 * Run against a fresh database with the whole ordered chain applied, executing the migration's real SQL
 * read off disk rather than a paraphrase of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { freshRpcDb, OWNER, seedBinders, seedCatalogCards } from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const B2 = "1c000000-0000-0000-0000-0000000000b2";
const LINE = "11111111-0000-0000-0000-0000000000a1";
const LINE2 = "11111111-0000-0000-0000-0000000000a2";
const CARD = "sv03-026";
const OTHER_CARD = "sv03-027";

const RELINK = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "0011_relink_unambiguous_line_slots.sql"),
  "utf8",
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCards(db, [CARD, OTHER_CARD]);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: B2, type: "general" },
  ]);
});
afterEach(async () => {
  await db.close();
});

async function addLine(id: string, binderId: string, band: string) {
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
     values ($1,$2,4,$3,$4)`,
    [id, OWNER, band, binderId],
  );
}

/** A placeholder slot waiting for `cardId`. */
async function addPlaceholder(id: string, lineId: string, stage: number, cardId: string) {
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
     values ($1,$2,$3,$4,'Basic','placeholder',$5)`,
    [id, OWNER, lineId, stage, cardId],
  );
}

/** A shelved back-half copy with no line pointer — the shape 0010 left behind. */
async function addUnlinked(id: string, cardId: string, binderId: string, band: string) {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half,
                       color_band, line_slot_id, acquired_at)
     values ($1,$2,$3,'normal','shelved',$4,'back',$5,null, now())`,
    [id, OWNER, cardId, binderId, band],
  );
}

const slot = async (id: string) =>
  (
    await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [id],
    )
  ).rows[0];

const copyPointer = async (id: string) =>
  (
    await db.query<{ line_slot_id: string | null }>(`select line_slot_id from copy where id = $1`, [
      id,
    ])
  ).rows[0].line_slot_id;

const S1 = "22222222-0000-0000-0000-0000000000b1";
const S2 = "22222222-0000-0000-0000-0000000000b2";
const C1 = "c0000000-0000-0000-0000-00000000aa01";
const C2 = "c0000000-0000-0000-0000-00000000aa02";

describe("migration 0011 · pairs the unambiguous case, both sides", () => {
  it("relinks a 1:1 copy and placeholder, writing BOTH pointers", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B1, "red");

    await db.exec(RELINK);

    expect(await slot(S1)).toEqual({ state: "filled", copy_id: C1 });
    // One fact stored twice: half of it is the defect this whole line of work is about.
    expect(await copyPointer(C1)).toBe(S1);
  });

  it("is idempotent — a second run pairs nothing further", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B1, "red");
    await db.exec(RELINK);
    const after = await slot(S1);
    await db.exec(RELINK);
    expect(await slot(S1)).toEqual(after);
  });

  it("is a no-op on empty tables (Production at cutover)", async () => {
    await db.exec(RELINK);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from line_slot`);
    expect(n.rows[0].n).toBe(0);
  });
});

describe("migration 0011 · REFUSES to guess — the assertions that matter", () => {
  it("skips when TWO copies want one placeholder (her live case, 2 of 8)", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B1, "red");
    await addUnlinked(C2, CARD, B1, "red"); // she owns two of this printing here

    await db.exec(RELINK);

    // Leaving both unlinked is the correct outcome: which copy belongs in the line is her decision,
    // and `target_catalog_card_id` cannot distinguish a normal from a reverse holo.
    expect(await slot(S1)).toEqual({ state: "placeholder", copy_id: null });
    expect(await copyPointer(C1)).toBeNull();
    expect(await copyPointer(C2)).toBeNull();
  });

  it("skips when one copy matches TWO placeholders", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addPlaceholder(S2, LINE, 1, CARD);
    await addUnlinked(C1, CARD, B1, "red");

    await db.exec(RELINK);

    expect((await slot(S1)).state).toBe("placeholder");
    expect((await slot(S2)).state).toBe("placeholder");
    expect(await copyPointer(C1)).toBeNull();
  });

  it("does not pair across a different BINDER", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B2, "red"); // right card, wrong binder

    await db.exec(RELINK);
    expect((await slot(S1)).state).toBe("placeholder");
    expect(await copyPointer(C1)).toBeNull();
  });

  it("does not pair across a different COLOUR BAND", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B1, "green"); // right card and binder, wrong band

    await db.exec(RELINK);
    expect((await slot(S1)).state).toBe("placeholder");
    expect(await copyPointer(C1)).toBeNull();
  });

  it("does not pair a copy for a DIFFERENT card", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, OTHER_CARD, B1, "red");

    await db.exec(RELINK);
    expect((await slot(S1)).state).toBe("placeholder");
    expect(await copyPointer(C1)).toBeNull();
  });

  it("leaves a front-half copy alone — only the stranded back-half shape is in scope", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half,
                         color_band, line_slot_id, acquired_at)
       values ($1,$2,$3,'normal','shelved',$4,'front','red',null, now())`,
      [C1, OWNER, CARD, B1],
    );

    await db.exec(RELINK);
    expect((await slot(S1)).state).toBe("placeholder");
  });

  it("never touches a slot that is already filled, or a copy that already points somewhere", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addUnlinked(C1, CARD, B1, "red");
    await db.exec(RELINK); // pairs them
    // A second unlinked copy of the same card arrives afterwards.
    await addUnlinked(C2, CARD, B1, "red");
    await db.exec(RELINK);

    // The established pair is undisturbed and the newcomer stays unlinked.
    expect(await slot(S1)).toEqual({ state: "filled", copy_id: C1 });
    expect(await copyPointer(C2)).toBeNull();
  });
});

describe("migration 0011 · does not disturb an unrelated correct pairing", () => {
  it("pairs one line's slot without reaching into another line", async () => {
    await addLine(LINE, B1, "red");
    await addLine(LINE2, B1, "green");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addPlaceholder(S2, LINE2, 0, OTHER_CARD);
    await addUnlinked(C1, CARD, B1, "red");
    await addUnlinked(C2, OTHER_CARD, B1, "green");

    await db.exec(RELINK);

    // Two independent 1:1 pairs, both made, neither crossed.
    expect(await slot(S1)).toEqual({ state: "filled", copy_id: C1 });
    expect(await slot(S2)).toEqual({ state: "filled", copy_id: C2 });
    expect(await copyPointer(C1)).toBe(S1);
    expect(await copyPointer(C2)).toBe(S2);
  });

  it("leaves no pointer disagreement anywhere after running", async () => {
    await addLine(LINE, B1, "red");
    await addPlaceholder(S1, LINE, 0, CARD);
    await addPlaceholder(S2, LINE, 1, OTHER_CARD);
    await addUnlinked(C1, CARD, B1, "red");
    await addUnlinked(C2, OTHER_CARD, B1, "red");
    await addUnlinked("c0000000-0000-0000-0000-00000000aa03", CARD, B1, "red"); // makes S1 ambiguous

    await db.exec(RELINK);

    const bad = await db.query<{ n: number }>(
      `select
         (select count(*) from line_slot s
            where s.state = 'filled' and s.copy_id is not null
              and not exists (select 1 from copy c where c.id = s.copy_id and c.line_slot_id = s.id))
       + (select count(*) from copy c
            where c.line_slot_id is not null
              and not exists (select 1 from line_slot s where s.id = c.line_slot_id and s.copy_id = c.id))
         as n`,
    );
    expect(Number(bad.rows[0].n)).toBe(0);
  });
});
