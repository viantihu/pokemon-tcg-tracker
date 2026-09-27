-- 0031_onboarding — each account remembers that it has seen the first-run tutorial (UIL-128).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0030 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- KARVI'S RULING (2026-09-27), on the tutorial's steps: "That is sufficient." The tutorial opens on an account's
-- first sign-in and never again by itself once it is finished or skipped. That fact is kept HERE, on the account,
-- not in the browser, so a new phone or a cleared browser does not show it again.
--
-- WHAT THIS ADDS. `onboarding`: one row per owner. A row means the tutorial is done (finished or skipped); no row
-- means it opens on the next page load. Replaying it from Settings changes nothing here until it is finished or
-- skipped again, which only moves `tutorial_done_at`.
--
-- EXISTING ACCOUNTS START DONE. Every owner who already has a binder, a card or a Dex import gets a row, so the
-- tutorial never pops up over a collection that is already set up. Keyed off her data rather than auth.users,
-- because no migration here reads auth.users and every owner table is keyed by owner_id alone.
--
-- Expected row effect on Testing: ONE row inserted into the new table (her owner id), nothing else touched.
-- Production: none today. NOT promoted (scripts/promote-collection.mjs EXCLUDED): the promotion needs her to have
-- signed in to Production first, and that sign-in (an account with no data yet) opens the tour, so a row she writes
-- there by skipping it would otherwise fail the promotion's empty-target check. She sees the tour once there.
--
-- SECURITY: 0002's `owner_all` policy shape, `owner_id` defaults to `auth.uid()` and is never read from a payload.

create table onboarding (
  owner_id         uuid primary key default auth.uid(),
  tutorial_done_at timestamptz not null default now()
);

comment on table onboarding is
  'One row per owner once the first-run tutorial is finished or skipped (UIL-128). No row: it opens on the next page load.';

alter table onboarding enable row level security;
create policy owner_all on onboarding
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

insert into onboarding (owner_id)
select owner_id from binder
union
select owner_id from copy
union
select owner_id from dex_import;
