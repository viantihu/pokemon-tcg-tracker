-- Config data lives in a migration, not the seed, so it reaches EVERY environment.
-- `supabase db push` (deploy.yml) applies migrations to Testing/Production but never runs
-- seed.sql, so config kept only in the seed left the remote config tables empty and cards
-- unroutable. Migrations are the single source of truth for config the whole app depends on.
--
-- The tables (band / type→band map) are created in 0002_domain.sql (frozen, already applied to
-- Production); this migration only fills them. Idempotent via `on conflict do nothing` so it is
-- safe to re-run and safe alongside any environment that was populated by hand.
--
-- Ten ordered color bands (system-design §4). Pink (#9) stays even though it is empty — its
-- position reserves physical binder space and MUST NOT be dropped or collapsed.
insert into color_band (band, display_name, position) values
  ('red',        'Red',        1),
  ('orange',     'Orange',     2),
  ('yellow',     'Yellow',     3),
  ('olive',      'Olive',      4),
  ('green',      'Green',      5),
  ('dark_blue',  'Dark blue',  6),
  ('light_blue', 'Light blue', 7),
  ('purple',     'Purple',     8),
  ('pink',       'Pink',       9),
  ('white',      'White',      10)
on conflict do nothing;

-- The confirmed type→band map (system-design §4). White absorbs Colorless/Metal/Trainer/
-- Supporter/Item. References color_band(band), so this runs after the band insert above.
insert into type_color_map (card_type, band) values
  ('Fire',      'red'),
  ('Fighting',  'orange'),
  ('Lightning', 'yellow'),
  ('Dragon',    'olive'),
  ('Grass',     'green'),
  ('Darkness',  'dark_blue'),
  ('Water',     'light_blue'),
  ('Psychic',   'purple'),
  ('Fairy',     'pink'),
  ('Colorless', 'white'),
  ('Metal',     'white'),
  ('Trainer',   'white'),
  ('Supporter', 'white'),
  ('Item',      'white')
on conflict do nothing;
