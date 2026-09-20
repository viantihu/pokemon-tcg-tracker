/**
 * UIL-038 — a new collection must persist as she builds it, not only on an explicit "Save collection"
 * click. Before this, there was no way to save anything before it had a name and a resolved binder —
 * `saveCollection` refused an empty name outright — so any interruption before that final click lost
 * everything typed, no matter how far along she was.
 *
 * `applyCollectionSave`'s `draft: true` is the fix: it tolerates the two things a still-being-built
 * draft is allowed to be missing (a name, a resolved binder) so autosave can persist every field
 * change as it happens. Every stranding guard (UIL-014, UIL-040) still runs unconditionally — `draft`
 * widens what an empty field looks like, never what a write is allowed to do.
 *
 * Real Postgres via PGlite, same harness as the other `tests/coll/*` suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCollectionSave, type CollectionSaveOutcome } from "@/lib/coll";
import { collectionRepo } from "@/lib/repo";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCards,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-000000000011";
const SPEC2 = "b0000000-0000-0000-0000-000000000012";
const COL = "a0000000-0000-0000-0000-000000000001";
const CA1 = "c0000000-0000-0000-0000-000000000a01";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

function idOf(res: CollectionSaveOutcome): string {
  if (!res.ok) throw new Error(`expected ok, got refusal: ${res.error}`);
  return res.id;
}

describe("applyCollectionSave draft mode", () => {
  it("creates a row with an empty name — the non-draft path refuses this outright, which is the defect", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const input = {
      id: null,
      name: "",
      mode: "finite" as const,
      binderId: "__new",
      newBinderName: "",
      targetTcgdexIds: [],
    };

    // Without draft mode, there is no way to persist anything before a name exists — exactly why an
    // interruption before typing one used to lose everything.
    expect(await applyCollectionSave(client, OWNER, input)).toEqual({
      ok: false,
      error: "A collection needs a name.",
    });

    const draft = await applyCollectionSave(client, OWNER, input, { draft: true });
    expect(draft.ok).toBe(true);
  });

  it("tolerates an unresolved __new binder pick, leaving current_binder_ids empty rather than erroring", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const res = await applyCollectionSave(
      client,
      OWNER,
      {
        id: null,
        name: "",
        mode: "finite",
        binderId: "__new",
        newBinderName: "",
        targetTcgdexIds: [],
      },
      { draft: true },
    );
    expect(res.ok).toBe(true);

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), idOf(res));
    expect(row?.current_binder_ids).toEqual([]);
  });

  it("still creates a real binder in draft mode once a new-binder name IS given", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const res = await applyCollectionSave(
      client,
      OWNER,
      {
        id: null,
        name: "",
        mode: "finite",
        binderId: "__new",
        newBinderName: "Specialty C",
        targetTcgdexIds: [],
      },
      { draft: true },
    );
    expect(res.ok).toBe(true);

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), idOf(res));
    expect(row?.current_binder_ids).toHaveLength(1);
  });

  it("the required scenario — typed a name, added two targets, closed without an explicit Save: the row has both, from autosave calls alone", async () => {
    await seedCatalogCards(db, ["cardA", "cardB"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await asOwner(db);
    const client = pgliteClient(db);

    // Step 1: she opens "+ New collection" — the draft is created immediately, before anything is typed.
    const created = await applyCollectionSave(
      client,
      OWNER,
      {
        id: null,
        name: "",
        mode: "finite",
        binderId: SPEC,
        newBinderName: "",
        targetTcgdexIds: [],
      },
      { draft: true },
    );
    const id = idOf(created);

    // Step 2: she types a name.
    await applyCollectionSave(
      client,
      OWNER,
      {
        id,
        name: "Matsuno",
        mode: "finite",
        binderId: SPEC,
        newBinderName: "",
        targetTcgdexIds: [],
      },
      { draft: true },
    );

    // Step 3: she adds cardA.
    await applyCollectionSave(
      client,
      OWNER,
      {
        id,
        name: "Matsuno",
        mode: "finite",
        binderId: SPEC,
        newBinderName: "",
        targetTcgdexIds: ["cardA"],
      },
      { draft: true },
    );

    // Step 4: she adds cardB, then closes the editor. No non-draft (explicit "Save collection") call
    // is ever made in this test — the row's final state is entirely autosave's doing.
    await applyCollectionSave(
      client,
      OWNER,
      {
        id,
        name: "Matsuno",
        mode: "finite",
        binderId: SPEC,
        newBinderName: "",
        targetTcgdexIds: ["cardA", "cardB"],
      },
      { draft: true },
    );

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), id);
    expect(row?.name).toBe("Matsuno");
    expect(row?.target_catalog_card_ids).toEqual(["cardA", "cardB"]);
    expect(row?.current_binder_ids).toEqual([SPEC]);
  });

  it("still refuses a target drop that would strand an owned copy (UIL-014) even in draft mode", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    await asOwner(db);
    const client = pgliteClient(db);

    const res = await applyCollectionSave(
      client,
      OWNER,
      {
        id: COL,
        name: "Matsuno",
        mode: "finite",
        binderId: SPEC,
        newBinderName: "",
        targetTcgdexIds: [],
      },
      { draft: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cardA");

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(row?.target_catalog_card_ids).toEqual(["cardA"]); // refused — untouched
  });

  it("still refuses a binder rebind that would strand shelved copies (UIL-040) even in draft mode", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: SPEC2, type: "specialty", name: "Specialty B" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    await asOwner(db);
    const client = pgliteClient(db);

    const res = await applyCollectionSave(
      client,
      OWNER,
      {
        id: COL,
        name: "Matsuno",
        mode: "finite",
        binderId: SPEC2,
        newBinderName: "",
        targetTcgdexIds: ["cardA"],
      },
      { draft: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/move them with it/i);
      // Step 2 (UIL-040): the refusal carries its remedy even in draft mode — the guard and the offer
      // travel together, or the draft path would be a dead end the deliberate path is not.
      expect(res.remedy).toMatchObject({ kind: "rebind-move", toBinderId: SPEC2, copyCount: 1 });
    }

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(row?.current_binder_ids).toEqual([SPEC]); // refused — untouched
  });

  it("an unresolved __new pick on an EXISTING collection keeps its current binder, not null (QA)", async () => {
    // The defect: passiveChange always sends the FULL state, including whatever binderId/
    // newBinderName currently sit at — so an unrelated passive edit (she typed a name, toggled
    // mode, added a target) after clicking "+ New binder" but before naming it carries binderId
    // "__new" alongside it. Pre-fix, draft mode resolved that to null unconditionally, silently
    // clearing an EXISTING collection's real binder even though nothing about the binder was
    // actually confirmed.
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    const res = await applyCollectionSave(
      client,
      OWNER,
      {
        id: COL,
        name: "Matsuno renamed",
        mode: "finite",
        binderId: "__new",
        newBinderName: "",
        targetTcgdexIds: [],
      },
      { draft: true },
    );
    expect(res.ok).toBe(true);

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(row?.current_binder_ids).toEqual([SPEC]);
    expect(row?.name).toBe("Matsuno renamed"); // the actual edit still landed
  });
});
