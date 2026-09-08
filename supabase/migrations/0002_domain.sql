-- 0002_domain — the Phase 1 domain schema.
--
-- Authoritative shape: docs/system-design.md §4 (entities, config) + docs/sync-ui-spec.md §C
-- (sync tables). Build contract: docs/dev-spec.md §5 (M1).
--
-- Migrations are FORWARD-ONLY and ordered. Never edit this file once merged; add 000N_*.sql
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- Cross-cutting rules honored here:
--   * RLS on EVERY table from the first domain table (dev-spec decision §4). Owner-scoped
--     tables carry owner_id = auth.uid(); shared catalog/config tables are authenticated-read.
--   * Coarse location only: binder + half + derived color band. NO pocket/page slot addressing
--     anywhere (system-design §12). `pockets_per_page` exists only to size capacity, not to address.
--   * dexId is the species key (int[]), never the card name.
--   * TCGdex ids/localIds stored EXACTLY as returned (padding varies by era) — plain text, no
--     normalization (dev-spec §0, design/rationale §9).
--
-- Controlled vocabularies use CHECK constraints (not PG enums) so they stay forward-only-friendly.

-- =============================================================================
-- Configuration: color bands + type→band map (system-design §4)
-- =============================================================================

-- Ten ordered bands. Order is the physical rainbow sort in both halves of every general binder
-- and resets between halves. Bands are first-class and orderable even at zero cards: Pink is
-- currently empty (she owns no Fairy) and MUST keep its slot — its position reserves physical
-- space (system-design §4, design/rationale §3).
create table color_band (
  band         text primary key,               -- stable key used by the engine (e.g. 'dark_blue')
  display_name text not null,                   -- human label (e.g. 'Dark blue')
  position     integer not null unique          -- 1..N rainbow order; edited in Settings (M8)
);

-- Energy type / card class → band. The confirmed map (system-design §4). White absorbs
-- Colorless, Metal, and every Trainer/Supporter/Item.
create table type_color_map (
  card_type text primary key,                   -- 'Fire','Fighting',...,'Trainer','Supporter','Item'
  band      text not null references color_band (band)
);

-- =============================================================================
-- Catalog: a printing that exists in the world, mirrored from TCGdex (read-only to the app;
-- written only by the M2 catalog sync via the service role). system-design §4.
-- =============================================================================
create table catalog_card (
  tcgdex_id        text primary key,            -- stored EXACTLY as TCGdex returns (e.g. 'sv03-027')
  name             text not null,
  dex_id           integer[] not null default '{}',   -- species key; regional forms share a dexId
  set_id           text,
  set_name         text,
  set_series       text,
  local_id         text,                        -- printed collector number, EXACT padding ('027','82')
  rarity           text,
  types            text[] not null default '{}',
  stage            text,                         -- 'Basic','Stage1','Stage2', ... (TCGdex verbatim)
  evolve_from      text,                         -- NULL for basics; species name of the prior stage
  illustrator      text,
  hp               integer,
  variants         jsonb not null default '{}'::jsonb,  -- {normal,holo,reverse,firstEdition,wPromo}
  artwork_group_id text,                         -- perceptual-hash cluster (M2); NULL until synced
  card_class       text not null default 'standard' check (card_class in ('standard', 'specialty')),
  is_digital_only  boolean not null default false,      -- TCG Pocket digital-only cards excluded downstream
  image_url        text,                         -- TCGdex base image path, verbatim (append /<quality>.<ext>)
  price_low        numeric(10, 2),
  price_market     numeric(10, 2)
);

create index catalog_card_dex_id_idx on catalog_card using gin (dex_id);
create index catalog_card_set_local_idx on catalog_card (set_id, local_id);
create index catalog_card_artwork_group_idx on catalog_card (artwork_group_id);

-- =============================================================================
-- Owner-scoped domain (system-design §4). owner_id = auth.uid() (dev-spec decision §4).
-- =============================================================================

-- A physical acquisition event.
create table haul (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  date       date not null default current_date,
  source     text not null check (source in ('bulk-bin', 'pack-rip', 'show', 'trade')),
  notes      text,
  created_at timestamptz not null default now()
);

-- A configurable binder. `pockets_per_page` sizes capacity only (CAPACITY, NOT ADDRESS).
create table binder (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid(),
  name                 text not null,
  type                 text not null check (type in ('general', 'specialty')),
  pages                integer not null default 0 check (pages >= 0),
  pockets_per_page     integer not null default 9 check (pockets_per_page > 0),
  back_half_start_page integer check (back_half_start_page is null or back_half_start_page >= 1),
  is_active            boolean not null default false,
  notes                text,
  created_at           timestamptz not null default now()
);

-- A running custom set. COLLS is the single source of truth for its membership (system-design §4;
-- M8 adds finite/open mode). Collection membership beats everything in the cascade.
create table collection (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null default auth.uid(),
  name                   text not null,
  definition_type        text not null default 'curated' check (definition_type in ('curated', 'rule')),
  current_binder_ids     uuid[] not null default '{}',
  target_catalog_card_ids text[] not null default '{}',
  status                 text not null default 'active',
  created_at             timestamptz not null default now()
);

-- The state of an evolution line: one line per species chain per color, back half only.
-- Color is set by the first card placed. Binder chosen at creation (decision §3: active binder);
-- stored here so a later policy change is a re-place, not a migration.
create table evolution_line (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  root_dex_id integer not null,
  color_band  text not null references color_band (band),
  binder_id   uuid references binder (id) on delete set null,
  half        text not null default 'back' check (half = 'back'),
  status      text not null default 'open' check (status in ('open', 'capped', 'complete', 'terminated')),
  created_at  timestamptz not null default now()
);

create index evolution_line_root_band_idx on evolution_line (root_dex_id, color_band);

-- Reconciliation unit keyed by (catalog_card, dex_variant_raw); the UI reads counts from it
-- (sync-ui-spec §C; sync-architecture §1.5). Its ordered Copy list is copies pointing back via
-- copy.presence_group_id.
create table presence_group (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  catalog_card_id text not null references catalog_card (tcgdex_id) on delete cascade,
  dex_variant_raw text not null,
  desired_count   integer not null default 0 check (desired_count >= 0),
  created_at      timestamptz not null default now(),
  unique (owner_id, catalog_card_id, dex_variant_raw)
);

-- A physical card owned. `variant` is the derived five-flag display/placement variant; the raw
-- Dex variant string that drives identity is `dex_variant_raw` (sync-architecture §1.4; §C).
-- binder_id/binder_half/color_band are NULL for bulk copies (no shelf location).
-- line_slot_id FK is added after line_slot exists (circular reference).
create table copy (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  catalog_card_id text not null references catalog_card (tcgdex_id) on delete restrict,
  variant         text not null default 'normal'
                    check (variant in ('normal', 'holo', 'reverse', 'firstEdition', 'wPromo')),
  dex_variant_raw text,                          -- raw Dex string (e.g. 'Reverse Holo'); NULL for hand-entered
  presence_group_id uuid references presence_group (id) on delete set null,
  haul_id         uuid references haul (id) on delete set null,
  acquired_at     timestamptz,
  role            text not null default 'shelved' check (role in ('shelved', 'bulk', 'block')),
  binder_id       uuid references binder (id) on delete set null,
  binder_half     text check (binder_half in ('front', 'back')),
  color_band      text references color_band (band),
  line_slot_id    uuid,                          -- FK added below (circular with line_slot)
  created_at      timestamptz not null default now()
);

create index copy_catalog_idx on copy (catalog_card_id);
create index copy_binder_half_idx on copy (binder_id, binder_half);
create index copy_role_idx on copy (role);
create index copy_presence_group_idx on copy (presence_group_id);

-- The ordered stages of a line. Each is filled / placeholder / block (system-design §6).
create table line_slot (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid(),
  line_id              uuid not null references evolution_line (id) on delete cascade,
  stage_index          integer not null,         -- ordered position within the chain (root = 0)
  stage                text not null,             -- 'Basic','Stage1','Stage2', ...
  state                text not null check (state in ('filled', 'placeholder', 'block')),
  copy_id              uuid references copy (id) on delete set null,        -- when filled
  target_catalog_card_id text references catalog_card (tcgdex_id) on delete set null,  -- when placeholder
  note                 text,
  unique (line_id, stage_index)
);

create index line_slot_line_idx on line_slot (line_id);

-- Now that line_slot exists, close the circular reference on copy.
alter table copy
  add constraint copy_line_slot_fk foreign key (line_slot_id) references line_slot (id) on delete set null;

-- Every open placeholder surfaces here (system-design §4; §6 alternates).
create table wishlist_item (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null default auth.uid(),
  line_slot_id             uuid references line_slot (id) on delete cascade,
  required_dex_id          integer,
  required_type            text,
  required_stage           text,
  chosen_catalog_card_id   text references catalog_card (tcgdex_id) on delete set null,
  alternate_catalog_card_ids text[] not null default '{}',
  held_for_binder_id       uuid references binder (id) on delete set null,
  will_live_in_specialty   boolean not null default false,
  created_at               timestamptz not null default now(),
  resolved_at              timestamptz
);

-- A blocked run of pockets: basic energy (untracked material) or a repurposed duplicate (tracked,
-- including which copy). system-design §4.
create table binder_block (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  binder_id   uuid not null references binder (id) on delete cascade,
  half        text not null check (half in ('front', 'back')),
  pocket_count integer not null default 1 check (pocket_count > 0),
  purpose     text not null check (purpose in ('line-terminated', 'collection-reserve')),
  material    text not null check (material in ('basicEnergy', 'repurposedDuplicate')),
  copy_id     uuid references copy (id) on delete set null,        -- set iff material = repurposedDuplicate
  line_id     uuid references evolution_line (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Audit trail: one row per card per placement, automated or user. The only way to debug the
-- cascade and answer "why did this card end up in bulk" (system-design §4; dev-spec §4).
create table placement_decision (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  haul_id     uuid references haul (id) on delete set null,
  copy_id     uuid references copy (id) on delete set null,
  decision    text not null,
  reason      text not null,
  resolved_by text not null check (resolved_by in ('auto', 'user')),
  created_at  timestamptz not null default now()
);

create index placement_decision_haul_idx on placement_decision (haul_id);

-- =============================================================================
-- Sync tables (sync-ui-spec §C; §A.3 unresolved queue; §B.4 snapshot)
-- =============================================================================

-- The holding area that makes catalog lag a visible, self-healing state instead of data loss.
-- Dedupe key is (dex_id, dex_variant_raw) — re-importing the same CSV updates in place (A.6).
create table unresolved_entry (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  dex_id          text not null,                 -- raw, unmapped (e.g. 'me6-14')
  dex_set_name    text,
  dex_series      text,
  dex_number      text,
  dex_name        text,
  dex_variant_raw text not null default '',
  quantity        integer not null default 1 check (quantity >= 0),
  locale          text,
  reason          text not null check (reason in ('UNKNOWN_SET', 'UNKNOWN_CARD')),
  status          text not null default 'WAITING' check (status in ('WAITING', 'RESOLVED', 'DISMISSED')),
  first_seen_sync timestamptz not null default now(),
  last_retry_sync timestamptz,
  retry_count     integer not null default 0 check (retry_count >= 0),
  manual_match_id text references catalog_card (tcgdex_id) on delete set null,
  unique (owner_id, dex_id, dex_variant_raw)
);

-- Learned (locale, dex_code) → tcgdex_set_id alias, writable by manual-match (A.8) and by
-- name-based auto-resolution (sync-architecture §1.3). One match can drain a whole set.
create table set_alias (
  locale         text not null,                  -- 'en' | 'ja' (resolve.ts Locale)
  dex_code       text not null,
  tcgdex_set_id  text not null,
  source         text not null default 'manual' check (source in ('manual', 'name-resolved')),
  created_at     timestamptz not null default now(),
  primary key (locale, dex_code)
);

-- A single serialized pre-apply state, overwritten each sync (last-sync-only undo; B.4).
create table last_sync_snapshot (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  snapshot   jsonb not null,
  created_at timestamptz not null default now()
);

-- =============================================================================
-- binder_section — a VIEW, not a table (system-design §4; dev-spec §5).
-- One row per (binder, half): general binders have front + back; specialty binders have one
-- section. Capacity is pages-in-half × pockets_per_page (CAPACITY, NOT ADDRESS — no pocket
-- addressing). security_invoker so the querying user's RLS on the base tables applies.
-- =============================================================================
create view binder_section
  with (security_invoker = on)
as
with section as (
  -- General binder: front half is pages [1 .. back_half_start_page-1], back is the remainder.
  select
    b.id as binder_id,
    b.owner_id,
    'front'::text as half,
    greatest(coalesce(b.back_half_start_page, b.pages + 1) - 1, 0) * b.pockets_per_page as capacity
  from binder b
  where b.type = 'general'
  union all
  select
    b.id,
    b.owner_id,
    'back'::text,
    greatest(b.pages - (coalesce(b.back_half_start_page, b.pages + 1) - 1), 0) * b.pockets_per_page
  from binder b
  where b.type = 'general'
  union all
  -- Specialty binder: a single section.
  select
    b.id,
    b.owner_id,
    'single'::text,
    b.pages * b.pockets_per_page
  from binder b
  where b.type = 'specialty'
)
select
  s.binder_id,
  s.half,
  s.capacity,
  coalesce(sh.shelved_count, 0) as shelved_count,
  coalesce(bl.block_pockets, 0) as block_pockets,
  coalesce(ph.open_placeholders, 0) as open_placeholders,
  greatest(
    s.capacity
      - coalesce(sh.shelved_count, 0)
      - coalesce(bl.block_pockets, 0)
      - coalesce(ph.open_placeholders, 0),
    0
  ) as free_pockets
from section s
left join (
  select binder_id, binder_half, count(*) as shelved_count
  from copy
  where role = 'shelved'
  group by binder_id, binder_half
) sh on sh.binder_id = s.binder_id
     and (sh.binder_half = s.half or (s.half = 'single' and sh.binder_half is null))
left join (
  select binder_id, half, sum(pocket_count) as block_pockets
  from binder_block
  group by binder_id, half
) bl on bl.binder_id = s.binder_id and bl.half = s.half
left join (
  select el.binder_id, count(*) as open_placeholders
  from line_slot ls
  join evolution_line el on el.id = ls.line_id
  where ls.state = 'placeholder'
  group by el.binder_id
) ph on ph.binder_id = s.binder_id and s.half = 'back';

-- =============================================================================
-- Row-Level Security (dev-spec decision §4). RLS on EVERY table.
--   * Owner-scoped tables: authenticated principal may act only on its own rows.
--   * Shared catalog/config: authenticated may read; writes to catalog land via the service
--     role (which bypasses RLS). color_band/type_color_map/set_alias are editable in-app.
--   * anon (unauthenticated) matches NO policy on any table → all reads denied (acceptance test).
-- =============================================================================

-- Owner-scoped tables.
do $$
declare t text;
begin
  foreach t in array array[
    'haul', 'binder', 'collection', 'evolution_line', 'presence_group', 'copy',
    'line_slot', 'wishlist_item', 'binder_block', 'placement_decision',
    'unresolved_entry', 'last_sync_snapshot'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy owner_all on %I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());',
      t
    );
  end loop;
end $$;

-- Shared catalog (read-only to the app; service role writes bypass RLS).
alter table catalog_card enable row level security;
create policy catalog_read on catalog_card for select to authenticated using (true);

-- Shared config, editable in Settings (M8).
alter table color_band enable row level security;
create policy color_band_all on color_band for all to authenticated using (true) with check (true);

alter table type_color_map enable row level security;
create policy type_color_map_all on type_color_map for all to authenticated using (true) with check (true);

-- Learned set aliases: read + write by the authenticated owner (single-user app); also written by
-- name-based auto-resolution via the service role (bypasses RLS).
alter table set_alias enable row level security;
create policy set_alias_all on set_alias for all to authenticated using (true) with check (true);
