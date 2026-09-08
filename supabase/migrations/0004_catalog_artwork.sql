-- 0004_catalog_artwork — M2 catalog mirror: perceptual-hash storage + manual grouping override.
--
-- Build contract: docs/dev-spec.md §5 (M2). Authoritative shape: docs/system-design.md §10
-- (artwork identity, resolved). Additive, FORWARD-ONLY — 0002_domain.sql is FROZEN (applied to
-- live prod + testing); never edit it (docs/devops-strategy.md §6, dev-spec §4).
--
-- Migration number: 0003 is reserved for the separately-tracked config-into-migration task
-- (color_band + type_color_map, deferred). M2 takes 0004 to avoid colliding with it.
--
-- catalog_card already exists with artwork_group_id (the effective cluster). This adds:
--   * artwork_hash        — the RAW perceptual hash (dHash hex). Stored alongside the group so
--                           clusters can be recomputed when the threshold is tuned WITHOUT a full
--                           re-sync/re-download (system-design §10).
--   * artwork_group_locked — set by a manual merge/split override. When true, artwork_group_id was
--                           assigned by hand and the auto-clusterer must not overwrite it. Merge =
--                           lock several cards to one group id; split = lock a card to its own id.

alter table catalog_card
  add column if not exists artwork_hash text,
  add column if not exists artwork_group_locked boolean not null default false;

-- Recomputing groups from stored hashes scans by hash; index it so a re-cluster over the mirror
-- does not table-scan 23.5k rows.
create index if not exists catalog_card_artwork_hash_idx on catalog_card (artwork_hash);
