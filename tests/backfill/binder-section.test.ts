/**
 * M5 acceptance (dev-spec §5): "a binder can be fully entered and its `binder_section` view reports
 * correct capacity/blocks/placeholders."
 *
 * End-to-end at the SQL level, no live stack: the pure backfill planners produce the exact rows a
 * fully-entered binder writes, and this suite applies them to a REAL Postgres (PGlite/WASM) with the
 * frozen migrations 0001–0004 (config included), then reads the derived view back. Drives the view
 * from planner output so the two never drift. Uses the same Supabase shims as
 * `tests/catalog/migration.test.ts` (PGlite lacks `auth.uid()` and the anon/authenticated roles).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { TypeColorMap } from "@/lib/engine";
import { planBackLine, planFrontHalf, type BackfillWrites, type PlanDeps } from "@/lib/backfill";
import {
  ARVEN_SV03_186,
  CHARIZARD_BASE1_4,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  SCIZOR_SV03_141,
} from "../engine/fixtures";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_domain.sql",
  "0003_config.sql",
  "0004_catalog_artwork.sql",
];

const SUPABASE_SHIMS = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
`;

const OWNER = "00000000-0000-0000-0000-000000000001";
const BINDER = "00000000-0000-0000-0000-0000000000b1";

const MAP: TypeColorMap = {
  Fire: "red",
  Grass: "green",
  Metal: "white",
  Colorless: "white",
  Trainer: "white",
};

function migrationSql(file: string): string {
  return readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
}

const FIXTURES = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_BASE1_4,
  SCIZOR_SV03_141,
  ARVEN_SV03_186,
];

function makeDeps(): PlanDeps {
  return {
    ownerId: OWNER,
    catalogById: new Map(FIXTURES.map((c) => [c.tcgdexId, c])),
    typeColorMap: MAP,
    binderNameById: new Map([[BINDER, "Binder 1"]]),
    bandDisplayByKey: new Map([
      ["red", "Red"],
      ["white", "White"],
    ]),
    collectionNameById: new Map(),
    // Real uuids — the id columns are uuid in the schema.
    newId: () => crypto.randomUUID(),
    now: "2026-09-08T00:00:00.000Z",
  };
}

/** Build the writes for a fully-entered general binder: 2 front cards + one back line. */
function buildWrites(): BackfillWrites {
  const deps = makeDeps();
  const front = planFrontHalf(
    {
      binderId: BINDER,
      half: "front",
      cards: [
        { tcgdexId: CHARMANDER_SV03_026.tcgdexId, variant: "normal" }, // Fire → red
        { tcgdexId: ARVEN_SV03_186.tcgdexId, variant: "normal" }, // Trainer → white
      ],
    },
    deps,
  );
  const back = planBackLine(
    {
      binderId: BINDER,
      bandKey: "red",
      rootDexId: 4,
      requiredType: "Fire",
      terminated: false,
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          dexId: 4,
          decision: "filled",
          filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
          filledVariant: "normal",
        },
        {
          stageIndex: 1,
          stage: "Stage1",
          dexId: 5,
          decision: "placeholder",
          targetCatalogCardId: CHARMELEON_SV03_027.tcgdexId,
          alternateCatalogCardIds: [],
          specialtyOnly: false,
        },
        {
          stageIndex: 2,
          stage: "Stage2",
          dexId: 6,
          decision: "block",
          blockMaterial: "repurposedDuplicate",
          blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
          blockCopyVariant: "holo",
          pocketCount: 2,
        },
      ],
    },
    deps,
  );
  // Merge the two write sets (front has no lines/slots/blocks/wishlist).
  return {
    lines: [...front.lines, ...back.lines],
    copies: [...front.copies, ...back.copies],
    slots: [...front.slots, ...back.slots],
    blocks: [...front.blocks, ...back.blocks],
    wishlist: [...front.wishlist, ...back.wishlist],
    decisions: [...front.decisions, ...back.decisions],
    copyLineSlotLinks: [...front.copyLineSlotLinks, ...back.copyLineSlotLinks],
    collectionTags: [...front.collectionTags, ...back.collectionTags],
  };
}

/** Apply the planner's rows in FK-safe order (copy.line_slot_id deferred — circular FK). */
async function applyWrites(db: PGlite, w: BackfillWrites) {
  // Catalog rows every FK depends on.
  const catalogIds = new Set<string>();
  for (const c of w.copies) catalogIds.add(c.catalog_card_id);
  for (const s of w.slots) if (s.target_catalog_card_id) catalogIds.add(s.target_catalog_card_id);
  for (const id of catalogIds) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name) values ($1, $2) on conflict do nothing`,
      [id, id],
    );
  }

  for (const l of w.lines) {
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [l.id, l.owner_id, l.root_dex_id, l.color_band, l.binder_id, l.half, l.status],
    );
  }
  for (const c of w.copies) {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, line_slot_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8, null)`,
      [
        c.id,
        c.owner_id,
        c.catalog_card_id,
        c.variant,
        c.role,
        c.binder_id,
        c.binder_half,
        c.color_band,
      ],
    );
  }
  for (const s of w.slots) {
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        s.id,
        s.owner_id,
        s.line_id,
        s.stage_index,
        s.stage,
        s.state,
        s.copy_id,
        s.target_catalog_card_id,
        s.note,
      ],
    );
  }
  for (const link of w.copyLineSlotLinks) {
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [link.slotId, link.copyId]);
  }
  for (const b of w.blocks) {
    await db.query(
      `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id, line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        b.id,
        b.owner_id,
        b.binder_id,
        b.half,
        b.pocket_count,
        b.purpose,
        b.material,
        b.copy_id,
        b.line_id,
      ],
    );
  }
}

interface SectionRow {
  half: string;
  capacity: number;
  shelved_count: number;
  block_pockets: number;
  open_placeholders: number;
  free_pockets: number;
}

describe("binder_section after a full backfill (PGlite)", () => {
  let sections: Record<string, SectionRow>;

  beforeAll(async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(SUPABASE_SHIMS);
    for (const f of MIGRATIONS) await db.exec(migrationSql(f));

    // A general binder: 20 pages × 9 pockets, front = pages 1..10, back = 11..20 → 90 each.
    await db.query(
      `insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page, is_active)
       values ($1,$2,'Binder 1','general',20,9,11,true)`,
      [BINDER, OWNER],
    );

    await applyWrites(db, buildWrites());

    const res = await db.query<SectionRow>(
      `select half, capacity::int, shelved_count::int, block_pockets::int,
              open_placeholders::int, free_pockets::int
       from binder_section where binder_id = $1`,
      [BINDER],
    );
    sections = Object.fromEntries(res.rows.map((r) => [r.half, r]));
  }, 30_000);

  it("front half counts only the two shelved front copies", () => {
    const front = sections.front;
    expect(front.capacity).toBe(90);
    expect(front.shelved_count).toBe(2);
    expect(front.block_pockets).toBe(0);
    expect(front.open_placeholders).toBe(0);
    expect(front.free_pockets).toBe(88);
  });

  it("back half reports the filled copy, the block pockets, and the open placeholder", () => {
    const back = sections.back;
    expect(back.capacity).toBe(90);
    // Only the FILLED copy is shelved; the repurposed-duplicate block copy is role='block'.
    expect(back.shelved_count).toBe(1);
    expect(back.block_pockets).toBe(2); // the 2-pocket repurposed-duplicate block
    expect(back.open_placeholders).toBe(1); // the Charmeleon placeholder slot
    expect(back.free_pockets).toBe(86); // 90 − 1 − 2 − 1
  });
});
