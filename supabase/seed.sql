-- Deterministic seed for the TESTING database only. Reset-from-seed is allowed at any time on
-- Testing; Production is NEVER seeded after its first real import (docs/devops-strategy.md §6).
--
-- STANDING RULE: use REAL cards only. Every set code + collector number below was verified against
-- the live TCGdex API before it was written (dev-spec §0). Fabricated numbers have broken the
-- design three times already — do not invent them.
--
-- Verified 2026-09-07 against https://api.tcgdex.net/v2/en/cards/<id> :
--   sv03-026  Charmander  · Common   · DOM            · Basic  · Fire    · dexId 4   · Obsidian Flames
--   sv03-027  Charmeleon  · Uncommon · Ryota Murayama · Stage1 · Fire    · dexId 5   · Obsidian Flames  (evolveFrom Charmander)
--   sv01-084  Ralts       · Common   · Tika Matsuno   · Basic  · Psychic · dexId 280 · Scarlet & Violet
-- localIds stored EXACTLY as returned (SV era pads to 3 digits: '026','027','084').
--
-- Seed runs as the postgres superuser via `supabase db reset`, which BYPASSES RLS, so owner_id is
-- set explicitly to a fixed local owner rather than relying on the auth.uid() default.

-- Fixed local owner for owner-scoped seed rows (Testing only; no auth.users row needed — RLS keys
-- on auth.uid() and a real magic-link session supplies it in the app).
\set owner '00000000-0000-0000-0000-000000000001'

-- =============================================================================
-- Config (color_band + type_color_map) is NOT seeded here. It is environment-independent config
-- that every environment needs, so it ships via migration 0003_config.sql — the only path that
-- reaches Testing/Production (`supabase db push` never runs this seed). On `supabase db reset`
-- migrations apply before this seed, so the color_band rows the FKs below depend on already exist.
-- =============================================================================

-- =============================================================================
-- Catalog cards (real, verified above). Pricing left NULL — the M2 catalog sync fills it.
-- =============================================================================
insert into catalog_card
  (tcgdex_id, name, dex_id, set_id, set_name, set_series, local_id, rarity, types, stage,
   evolve_from, illustrator, hp, variants, card_class, is_digital_only, image_url)
values
  ('sv03-026', 'Charmander', '{4}',   'sv03', 'Obsidian Flames',  'Scarlet & Violet', '026', 'Common',
   '{Fire}', 'Basic', null, 'DOM', 60,
   '{"normal":true,"holo":true,"reverse":true,"firstEdition":false,"wPromo":false}'::jsonb,
   'standard', false, 'https://assets.tcgdex.net/en/sv/sv03/026'),
  ('sv03-027', 'Charmeleon', '{5}',   'sv03', 'Obsidian Flames',  'Scarlet & Violet', '027', 'Uncommon',
   '{Fire}', 'Stage1', 'Charmander', 'Ryota Murayama', 90,
   '{"normal":true,"holo":true,"reverse":true,"firstEdition":false,"wPromo":false}'::jsonb,
   'standard', false, 'https://assets.tcgdex.net/en/sv/sv03/027'),
  ('sv01-084', 'Ralts', '{280}', 'sv01', 'Scarlet & Violet', 'Scarlet & Violet', '084', 'Common',
   '{Psychic}', 'Basic', null, 'Tika Matsuno', 70,
   '{"normal":true,"holo":false,"reverse":true,"firstEdition":false,"wPromo":false}'::jsonb,
   'standard', false, 'https://assets.tcgdex.net/en/sv/sv01/084');

-- =============================================================================
-- Binders: one active general binder + one specialty binder shared by two collections.
-- back_half_start_page splits page ranges for the binder_section view (CAPACITY, NOT ADDRESS).
-- =============================================================================
insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page, is_active) values
  ('00000000-0000-0000-0000-0000000000b1', :'owner', 'Binder 1',          'general',   40, 9, 21, true),
  ('00000000-0000-0000-0000-0000000000b2', :'owner', 'Specialty Binder A', 'specialty', 20, 9, null, false);

-- =============================================================================
-- Two curated specialty collections that share Specialty Binder A (system-design §3). Membership
-- is enumerated later; target arrays start empty rather than fabricating collector numbers.
-- =============================================================================
insert into collection (id, owner_id, name, definition_type, current_binder_ids, status) values
  ('00000000-0000-0000-0000-0000000000a1', :'owner', 'OKUBO-illustrated cards (~31)',
   'curated', '{00000000-0000-0000-0000-0000000000b2}', 'active'),
  ('00000000-0000-0000-0000-0000000000a2', :'owner', 'Saboteri Cityscape connected art (~74)',
   'curated', '{00000000-0000-0000-0000-0000000000b2}', 'active');

-- =============================================================================
-- Copies (physical cards). Charmander + Charmeleon fill a Fire Charmander line in Binder 1 back;
-- Ralts sits shelved in Binder 1 front (Psychic → purple band). line_slot_id is wired up after the
-- slots exist (circular FK).
-- =============================================================================
insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
  ('00000000-0000-0000-0000-0000000000c1', :'owner', 'sv03-026', 'normal', 'shelved',
   '00000000-0000-0000-0000-0000000000b1', 'back', 'red'),
  ('00000000-0000-0000-0000-0000000000c2', :'owner', 'sv03-027', 'normal', 'shelved',
   '00000000-0000-0000-0000-0000000000b1', 'back', 'red'),
  ('00000000-0000-0000-0000-0000000000c3', :'owner', 'sv01-084', 'normal', 'shelved',
   '00000000-0000-0000-0000-0000000000b1', 'front', 'purple');

-- =============================================================================
-- The Fire Charmander evolution line (red, back half of Binder 1). Root + Stage 1 both filled;
-- status 'open' (the Charizard stage is not seeded — no fabricated ex card).
-- =============================================================================
insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status) values
  ('00000000-0000-0000-0000-0000000000e1', :'owner', 4, 'red',
   '00000000-0000-0000-0000-0000000000b1', 'back', 'open');

insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
  ('00000000-0000-0000-0000-0000000000f1', :'owner', '00000000-0000-0000-0000-0000000000e1',
   0, 'Basic', 'filled', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f2', :'owner', '00000000-0000-0000-0000-0000000000e1',
   1, 'Stage1', 'filled', '00000000-0000-0000-0000-0000000000c2');

-- Close the circular reference: point each filled copy back at its line slot.
update copy set line_slot_id = '00000000-0000-0000-0000-0000000000f1' where id = '00000000-0000-0000-0000-0000000000c1';
update copy set line_slot_id = '00000000-0000-0000-0000-0000000000f2' where id = '00000000-0000-0000-0000-0000000000c2';
