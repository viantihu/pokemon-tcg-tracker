-- 0016_catalog_locale — the catalog mirror learns a second locale: Japanese printings can be mirrored,
-- stored and matched without colliding with English ones (UIL-047 C1/C2; Karvi: pull the Japanese
-- catalog THIS phase).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0015 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHAT THIS ADDS, AND WHY BOTH HALVES.
--   1. `catalog_card.locale` — 'en' (every existing row, by default, no backfill) or 'ja'. Every lookup
--      that used to key on (set_id, local_id) alone is locale-scoped from here on, and the mirror's
--      resume count groups by (locale, set_id).
--   2. A NAMESPACE for non-English ids. The primary key is `tcgdex_id` ALONE, referenced by seven bare
--      text sites (five FKs, two arrays), and the mirror upserts on it. A locale column cannot stop a
--      Japanese id equal to an English id string from overwriting the English row through that upsert —
--      and four set ids (neo1–neo4) are already shared across TCGdex's two locales. So a Japanese row is
--      stored as tcgdex_id `ja:neo1-001` with set_id `ja:neo1`; English rows stay EXACTLY as TCGdex
--      returns them (nothing existing moves). Enforced both ways by a check constraint, the same
--      convention 0015 used for `user:` stand-ins. It also makes set_alias.tcgdex_set_id unambiguous
--      (`ja:sv11w` vs `swshp`) and keeps (set_id, local_id) unique without a locale in the key.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It does not rewrite any set_alias row. The two Japanese-locale aliases
-- on Testing that point at ENGLISH set ids (`ja:m6 → swshp` is Karvi's own cross-locale pin) keep meaning
-- exactly what they mean; she re-teaches one with Forget if the Japanese mirror offers a better target.
-- tests/catalog/catalog-locale-migration.test.ts pins that a pre-existing alias survives this file byte
-- for byte. `apply_write_ops` is untouched (0015's body still runs).
--
-- After deploy: dispatch the mirror with `locale: ja` (NOT force_all — the resume logic sees zero ja rows
-- and requests all 184 sets with the existing backoff; force_all would re-request all 220 en sets too).

alter table catalog_card
  add column locale text not null default 'en' check (locale in ('en', 'ja'));
comment on column catalog_card.locale is
  'TCGdex locale this printing was mirrored from. ''en'' rows keep TCGdex''s ids verbatim; every other locale is namespaced: tcgdex_id ''<locale>:<id>'', set_id ''<locale>:<set>'' (UIL-047).';

-- The namespace and the locale agree, both ways. A `user:` stand-in (0015) is an 'en' row with no
-- `ja:` prefix, so it passes untouched.
alter table catalog_card
  add constraint catalog_card_locale_namespace check ((locale = 'en') = (tcgdex_id not like 'ja:%'));

-- Every (set, number) lookup is locale-scoped from here on.
drop index if exists catalog_card_set_local_idx;
create index catalog_card_locale_set_local_idx on catalog_card (locale, set_id, local_id);
