-- 0009_set_metadata — carry two set-level facts on each catalog_card so collector-number search can
-- rank exact matches instead of ordering them alphabetically (UIL-026).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0008 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY. `catalog_card.search` (lib/repo/catalog-card.ts) ranks an exact `local_id` hit above name
-- matches, but when the same collector number exists in several sets it had no way to order THOSE and
-- fell back to `.order("set_id")` — alphabetical, which is arbitrary. Searching `099/182` for Minior
-- (`sv04-099`) returned five cards numbered 099 with the real match last, because `sv04` sorts late
-- (UIL-015's residual limitation, UIL-026 the fix). Two facts, both already in hand at mirror time,
-- turn that arbitrary order into a real one:
--
--   set_card_count_official — the printed set total (TCGdex `cardCount.official`). The `/182` a
--     collector types IS this number, and today `parseCardQuery` discards it because there was nothing
--     to match it against. With this column an exact number whose set total equals the typed
--     denominator ranks first — decisive for `099/182`, where only Paradox Rift is 182.
--
--   set_release_date — the set's release date (TCGdex `releaseDate`). The principled tie-break once
--     the denominator is used or absent: most-recent set first, which is what a collector building from
--     a current set expects. Replaces alphabetical `set_id`, which encodes nothing.
--
-- BOTH NULLABLE, deliberately. Coverage was sampled at 25 of 218 sets, not proven, and TCGdex may omit
-- either field on some set; a NOT NULL we cannot guarantee would fail this migration or the mirror on
-- the one set that lacks it. The search orders NULLs last, so a set missing either fact simply sorts
-- after the sets that have it rather than breaking the query.
--
-- POPULATED BY THE MIRROR, NOT HERE. These columns land NULL on every existing row and are filled when
-- catalog-mirror.yml re-runs with force_all: true — the resume check otherwise sees every set already at
-- its full card count and mirrors nothing (a green run that populates nothing, UIL-004's failure shape).
-- No backfill in this migration: the values live in the TCGdex set resource, not anywhere in the DB.
--
-- set_release_date is for ORDERING ONLY. Many old sets carry first-of-month placeholder dates
-- (`1996-01-01`, `2000-02-01`); they order correctly but must never be shown as a set's actual release
-- date.

alter table catalog_card
  add column set_card_count_official integer,
  add column set_release_date date;

comment on column catalog_card.set_card_count_official is
  'Printed set total (TCGdex cardCount.official). Search ranks a row whose total equals a typed collector-number denominator first (UIL-026). NULL until the mirror repopulates.';
comment on column catalog_card.set_release_date is
  'Set release date (TCGdex releaseDate). Search tie-breaks most-recent-first on it. ORDERING ONLY — old sets carry placeholder dates; never display it. NULL until the mirror repopulates.';
