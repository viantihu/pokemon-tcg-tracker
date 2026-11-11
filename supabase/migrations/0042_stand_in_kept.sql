-- 0042_stand_in_kept — she can leave a stand-in as it is, and the Sync screen stops asking until something changes.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0041 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- Karvi (2026-11-11): the swap's suggestions can all be wrong, and she needs a way to say "leave it" rather than swap
-- for a wrong card. `stand_in_kept_candidate_ids` records the real cards she was shown when she chose to keep it. The
-- stand-in is asked about again only when a NEW candidate appears (the catalog gained a card, or she fixed the
-- stand-in, which clears it): a choice she made about these cards is not asked again for the same cards.
--
-- Null means she never kept it. Only stand-ins carry it; mirror rows leave it null. Written under 0033's
-- `catalog_card_user_update` (her own stand-ins only), so no new policy.

alter table catalog_card add column stand_in_kept_candidate_ids text[];

comment on column catalog_card.stand_in_kept_candidate_ids is
  'Stand-ins only: the real cards shown when she chose to keep it as a stand-in; asked again only when a new candidate appears. Null = never kept.';
