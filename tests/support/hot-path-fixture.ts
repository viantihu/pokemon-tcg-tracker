/**
 * Her collection as the hot paths read it, for the tests that drive every screen's load and write through the real
 * code on PGlite: the row cap (tests/repo/row-cap-hot-paths.test.ts) and the shared catalog cache
 * (tests/plan/catalog-cache-loaders.test.ts).
 *
 * One Emberling line in KB-001 · Back · Red: the Basic filled, the Stage 1 open and not decided, the Stage 2 a chase
 * with its wish. An Emberdrake waiting in her haul (the Haul Plan's line card) and a second printing shelved in the
 * front half (a Move into the line). A collection in her specialty binder with one card in it. A stand-in Emberdrake of
 * her own, whose `user:` id sorts between the mirror's two Emberdrakes (`sv01-002` < `user:` < `xy9-050`), so a loader
 * that reads the catalog in another order than it did cannot hide behind a family with one printing.
 *
 * `big` adds what passes PostgREST's 1,000-row cap on those paths, as an import of ~300 cards does on top of her
 * 695 copies: 1,001 more copies (in her haul), 1,001 more lines (2,002 slots) and 1,001 more open wishes. They are
 * inert: no species of theirs is in the catalog, so no screen offers them for the Emberling family.
 *
 * Seeds as the superuser and ends as the owner.
 */
import type { PGlite } from "@electric-sql/pglite";
import {
  asOwner,
  asSuperuser,
  OWNER,
  seedBinders,
  seedCollections,
  seedHaulCopies,
} from "./pglite-rpc";

export const HP = {
  GEN: "b0000000-0000-4000-8000-0000000c4c01",
  SPEC: "b0000000-0000-4000-8000-0000000c4c02",
  COL: "a0000000-0000-4000-8000-0000000c4c01",
  LINE: "10000000-0000-4000-8000-0000000c4c01",
  SL0: "20000000-0000-4000-8000-0000000c4c00",
  SL1: "20000000-0000-4000-8000-0000000c4c01",
  SL2: "20000000-0000-4000-8000-0000000c4c02",
  /** Her Emberling, in the Basic slot. */
  BASIC: "c0000000-0000-4000-8000-0000000c4c00",
  /** An Emberdrake waiting in her haul: the Haul Plan's line card. */
  HAUL_DRAKE: "c0000000-0000-4000-8000-0000000c4c01",
  /** The other Emberdrake printing, shelved in KB-001's front half: a Move into the line. */
  FRONT_DRAKE: "c0000000-0000-4000-8000-0000000c4c02",
  /** The card in her collection, shelved in its specialty binder. */
  IN_COL: "c0000000-0000-4000-8000-0000000c4c03",
  WISH: "e0000000-0000-4000-8000-0000000c4c01",
  STAND_IN: "user:en:00000000-0000-4000-8000-0000000c4c01",
  EMBERLING: "sv01-001",
  EMBERDRAKE: "sv01-002",
  EMBERDRAKE_XY: "xy9-050",
  EMBERLORD: "sv01-003",
  /** How many of each table `big` adds: one past the cap. */
  BIG: 1001,
} as const;

export async function seedHotPaths(db: PGlite, opts: { big?: boolean } = {}): Promise<void> {
  await asSuperuser(db);
  await seedBinders(db, [
    { id: HP.GEN, type: "general", name: "KB-001" },
    { id: HP.SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await db.query(
    `insert into catalog_card
       (tcgdex_id, name, dex_id, types, stage, evolve_from, set_id, set_name, local_id, card_class, price_market, locale, image_url)
     values
       ('sv01-001', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'sv01', 'Set One', '001', 'standard', 0.5, 'en', 'img/sv01-001'),
       ('sv01-002', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'sv01', 'Set One', '002', 'standard', 1.2, 'en', 'img/sv01-002'),
       ('xy9-050', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'xy9', 'Set XY9', '050', 'standard', 0.8, 'en', 'img/xy9-050'),
       ('sv01-003', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'sv01', 'Set One', '003', 'standard', 4, 'en', 'img/sv01-003'),
       ('ja:SV1-001', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'ja:SV1', 'Set One (ja)', '001', 'standard', 0.3, 'ja', null),
       ('ja:SV1-002', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'ja:SV1', 'Set One (ja)', '002', 'standard', 0.6, 'ja', null),
       ('sv02-025', 'Sparkmouse', '{9501}', '{Lightning}', 'Basic', null, 'sv02', 'Set Two', '025', 'standard', 2, 'en', 'img/sv02-025'),
       ('sv02-026', 'Sparkmouse', '{9501}', '{Lightning}', 'Basic', null, 'sv02', 'Set Two', '026', 'specialty', 9, 'en', null),
       ('sv02-100', 'Pokégear', '{}', '{}', null, null, 'sv02', 'Set Two', '100', 'standard', 0.1, 'en', null)`,
  );
  // Her own stand-in (0033: hers alone; the fixture trigger gives it the test owner).
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, source)
       values ($1, 'Emberdrake Promo', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard', 'user')`,
    [HP.STAND_IN],
  );
  await seedCollections(db, [
    {
      id: HP.COL,
      name: "Sparkmice",
      targetCatalogCardIds: ["sv02-025", "sv02-026"],
      currentBinderIds: [HP.SPEC],
    },
  ]);
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $4, 'sv01-001', 'shelved', $5, 'back', 'red'),
       ($2, $4, 'xy9-050', 'shelved', $5, 'front', 'red'),
       ($3, $4, 'sv02-025', 'shelved', $6, null, null)`,
    [HP.BASIC, HP.FRONT_DRAKE, HP.IN_COL, OWNER, HP.GEN, HP.SPEC],
  );
  await seedHaulCopies(db, [{ id: HP.HAUL_DRAKE, catalogCardId: HP.EMBERDRAKE }]);
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [HP.LINE, OWNER, HP.GEN],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id, stage_choice) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6, null, null),
       ($2, $4, $5, 1, 'Stage1', 'placeholder', null, null, null),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null, 'sv01-003', 'chase')`,
    [HP.SL0, HP.SL1, HP.SL2, OWNER, HP.LINE, HP.BASIC],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [HP.SL0, HP.BASIC]);
  await db.query(
    `insert into wishlist_item (id, owner_id, line_slot_id, required_dex_id, required_type, required_stage,
                                chosen_catalog_card_id, alternate_catalog_card_ids)
       values ($1, $2, $3, 9303, 'Fire', 'Stage2', 'sv01-003', '{}')`,
    [HP.WISH, OWNER, HP.SL2],
  );

  if (opts.big) {
    // Copies her import made, waiting in her haul (one presence group, as one Dex row of 1,001 would be).
    await db.query(
      `insert into presence_group (owner_id, catalog_card_id, dex_variant_raw, desired_count)
         values ($1, 'sv02-100', 'Normal', $2)`,
      [OWNER, HP.BIG],
    );
    await db.query(
      `insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
         select $1, 'sv02-100', 'normal', 'Normal',
                (select id from presence_group where owner_id = $1 and catalog_card_id = 'sv02-100'), 'haul'
           from generate_series(1, $2)`,
      [OWNER, HP.BIG],
    );
    // Lines of species the catalog does not hold, two open stages each.
    await db.query(
      `insert into evolution_line (owner_id, root_dex_id, color_band, binder_id, half, status)
         select $1, 20000 + g, 'red', $2, 'back', 'open' from generate_series(1, $3) g`,
      [OWNER, HP.GEN, HP.BIG],
    );
    await db.query(
      `insert into line_slot (owner_id, line_id, stage_index, stage, state)
         select $1, l.id, s.i, (array['Basic', 'Stage1'])[s.i + 1], 'placeholder'
           from evolution_line l, generate_series(0, 1) s(i)
          where l.root_dex_id > 20000`,
      [OWNER],
    );
    // Open wishes held for no slot.
    await db.query(
      `insert into wishlist_item (owner_id, required_dex_id, alternate_catalog_card_ids)
         select $1, 20000 + g, '{}' from generate_series(1, $2) g`,
      [OWNER, HP.BIG],
    );
  }
  await asOwner(db);
}
