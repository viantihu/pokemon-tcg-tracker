/**
 * UIL-130 — wherever a screen says where a bulk card is, or where one is going, it names her box. Until she had more
 * than one box, "Bulk box" was the only answer; with several, it is the box's own name ("Shoebox"). A screen that
 * has no boxes to hand still says "Bulk box".
 *
 * Real Postgres (PGlite, every migration) for the loaders that read her boxes (the spare-card tiles, the popup's
 * "where is it now", a Sync removal); the pure labels directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { describeMove } from "@/lib/line/move";
import { loadBulkFillers } from "@/lib/line/stage-options-load";
import { describeTarget } from "@/lib/plan/assemble";
import { describeFormerPlacement } from "@/lib/copy/remove";
import { copyHomeDestination, copyHomeLabel } from "@/app/(ui)/look/lookup-copies";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { executeApply } from "@/lib/sync";
import type { Row } from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const BOX = (n: number) => `d0000000-0000-4000-8000-00000000013${n}`;

describe("the pure labels name the box", () => {
  it("a Move to bulk: the box she named, else her default box; with no boxes, 'Bulk box'", () => {
    const names = {
      binderName: () => "KB-001",
      collectionName: () => null,
      bandDisplay: (k: string) => k,
      bulkBoxName: (id: string | undefined) => (id === "s" ? "Shoebox" : "Bulk box"),
    };
    expect(describeMove({ kind: "bulk", unitId: "s" }, names)).toBe("Shoebox (not shelved)");
    expect(describeMove({ kind: "bulk" }, names)).toBe("Bulk box (not shelved)");
    expect(describeMove({ kind: "bulk" }, { ...names, bulkBoxName: undefined })).toBe(
      "Bulk box (not shelved)",
    );
  });

  it("the Haul Plan's row: the box it sends the card to", () => {
    const l = {
      binderNameById: new Map(),
      bandDisplayByKey: new Map(),
      collectionNameById: new Map(),
      imageUrlByTcgdexId: new Map(),
    };
    expect(describeTarget({ kind: "bulk" }, { ...l, bulkBoxName: () => "Shoebox" })).toBe(
      "Bulk · Shoebox",
    );
    expect(describeTarget({ kind: "bulk" }, { ...l, bulkBoxName: () => "Bulk box" })).toBe(
      "Bulk box",
    );
    expect(describeTarget({ kind: "bulk" }, l)).toBe("Bulk box");
  });

  it("Lookup: where the card is now, and the Move opens on that box", () => {
    const c = {
      id: "c1",
      role: "bulk" as const,
      binderId: null,
      binderHalf: null,
      colorBand: null,
      lineSlotId: null,
    };
    const names = {
      binderName: () => undefined,
      bandDisplay: () => undefined,
      collectionIn: () => null,
      bulkBoxOf: () => ({ id: "s", name: "Shoebox" }),
    };
    expect(copyHomeLabel(c, names)).toBe("Shoebox (not shelved)");
    expect(copyHomeDestination(c, names)).toEqual({ kind: "bulk", unitId: "s" });
  });

  it("a removed card's former place", () => {
    const copy = { role: "bulk", bulk_unit_id: "s" } as Row<"copy">;
    expect(
      describeFormerPlacement(
        copy,
        () => undefined,
        () => "Shoebox",
      ),
    ).toBe("Shoebox");
    expect(describeFormerPlacement(copy, () => undefined)).toBe("the bulk box");
  });
});

describe("the loaders name the box", () => {
  let db: PGlite;
  const GEN = "1c000000-0000-0000-0000-0000000000b1";
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedBinders(db, [{ id: GEN, type: "general", name: "B1" }]);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id) values
        ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}'),
        ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1', '{5}');
      insert into bulk_unit (id, owner_id, name, is_default) values
        ('${BOX(1)}', '${OWNER}', 'Bulk box', true), ('${BOX(2)}', '${OWNER}', 'Shoebox', false);
    `);
  });
  afterEach(async () => {
    await db.close();
  });

  it("the spare-card tiles: one per printing per box, each tagged with its box", async () => {
    await db.exec(`
      insert into copy (owner_id, catalog_card_id, role, bulk_unit_id) values
        ('${OWNER}', 'sv03-026', 'bulk', '${BOX(1)}'), ('${OWNER}', 'sv03-026', 'bulk', '${BOX(2)}'),
        ('${OWNER}', 'sv03-026', 'bulk', '${BOX(2)}');
    `);
    await asOwner(db);
    const tiles = await loadBulkFillers(pgliteClient(db));
    expect(tiles.map((t) => [t.where, t.count]).sort()).toEqual([
      ["Bulk box", 1],
      ["Shoebox", 2],
    ]);
  });

  it("Sync: a removal says the box the card was in", async () => {
    const HEADER =
      "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
    const row = (id: string, n: string, name: string) =>
      `collection;Pokemon;English;SV;Obsidian Flames;${id};${n};${name};Normal;Common;;1;;`;
    const bytes = (...rows: string[]) =>
      Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);
    await asOwner(db);
    const first = await runSyncPipeline(
      pgliteClient(db),
      bytes(row("sv03-026", "026", "Charmander")),
    );
    await executeApply(pgliteClient(db), first.bundle, OWNER);
    // She files it in her Shoebox.
    await asSuperuser(db);
    await db.query(
      `update copy set role = 'bulk', bulk_unit_id = $1 where catalog_card_id = 'sv03-026'`,
      [BOX(2)],
    );
    await asOwner(db);
    // The next export no longer lists it.
    const next = await runSyncPipeline(
      pgliteClient(db),
      bytes(row("sv03-027", "027", "Charmeleon")),
    );
    expect(next.preview.sections.removals.map((r) => r.placementLabel)).toEqual(["Shoebox"]);
  });
});
