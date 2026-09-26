/**
 * UIL-114 part C — the server half of the arrivals check (`loadArrivals` → `loadPendingPlacements` with
 * `except`), on real Postgres. It answers "what is waiting that the page does not already hold", and since
 * the answer is almost always "nothing" and it is asked every 30 s, it must not read the catalog then.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, loadPendingPlacements } from "@/lib/plan";
import type { DbClient } from "@/lib/repo";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027, SCIZOR_SV03_141 } from "../engine/fixtures";
import { asOwner, freshRpcDb, seedCatalogCardsFull, seedHaulCopies } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, SCIZOR_SV03_141]);
  await seedHaulCopies(db, [
    { id: A, catalogCardId: CHARMANDER_SV03_026.tcgdexId },
    { id: B, catalogCardId: CHARMELEON_SV03_027.tcgdexId },
    { id: C, catalogCardId: SCIZOR_SV03_141.tcgdexId, variant: "holo" },
  ]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

/** The client, recording every table it is asked to read. */
function recording(): { client: DbClient; tables: string[] } {
  const inner = pgliteClient(db);
  const tables: string[] = [];
  const client = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "from") {
        return (t: string) => {
          tables.push(t);
          return target.from(t as never);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { client, tables };
}

describe("UIL-114 · what arrived while the page was open", () => {
  it("returns only the waiting copies the page does not hold, with their cards", async () => {
    const { client } = recording();
    const out = await loadPendingPlacements(client, { except: new Set([A, C]) });
    expect(out.map((p) => p.copyId)).toEqual([B]);
    expect(out[0].card.name).toBe(CHARMELEON_SV03_027.name);
  });

  it("with nothing new, answers without reading the catalog", async () => {
    const { client, tables } = recording();
    expect(await loadPendingPlacements(client, { except: new Set([A, B, C]) })).toEqual([]);
    expect(tables).not.toContain("catalog_card");
  });

  it("with no `except`, is the whole queue, as the page's first read has always been", async () => {
    const { client } = recording();
    const out = await loadPendingPlacements(client);
    expect(out.map((p) => p.copyId).sort()).toEqual([A, B, C].sort());
  });
});
