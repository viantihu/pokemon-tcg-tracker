-- 0005_collection_mode — give the collection finite/open toggle its own column.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every
-- table). Additive — 0001–0004 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- Why: M8 shipped after the schema was frozen, so it had no place for the FINITE/OPEN toggle and
-- overloaded the free-text `status` column (`status='finite'` ⇒ finite, anything else incl. the
-- default 'active' ⇒ open). That collides with `status`'s real meaning (active/archived). This
-- migration gives `mode` its own column and frees `status` again.
--
-- `mode` is a new column on an already-RLS-protected table; the owner-scoped `owner_all` policy
-- (0002) is row-based (`owner_id = auth.uid()`) and column-agnostic, so no new policy is needed.
--
-- Idempotent / safe to re-run: the ADD is `if not exists`; the backfill updates key off
-- `status='finite'`, which no longer matches once a prior run has reset those rows to 'active'.

alter table collection
  add column if not exists mode text not null default 'open' check (mode in ('finite', 'open'));

-- Backfill the toggle onto the new column, then hand `status` back to its real active/archived
-- meaning. Order matters: set `mode` off the legacy `status='finite'` flag first, then reset those
-- same rows' `status` (the first update touches only `mode`, so the second still sees 'finite').
update collection set mode = 'finite' where status = 'finite';
update collection set status = 'active' where status = 'finite';
