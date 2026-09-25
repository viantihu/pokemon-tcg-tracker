-- 0023_copy_group_required — every card the app holds is one the next Dex import can see (UIL-098 part 4).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0022 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- KARVI'S CHARGE (2026-09-23): "make sure all edge cases are covered so that the entry of cards is
-- streamlined to a manual add or Dex" — and she narrowed "manual add" to the Sync page's match of an
-- unresolved Dex row. Both carry the Dex row's presence group.
--
-- WHY THE GROUP IS THE WHOLE INVARIANT. The import builds "what she already owns" from presence groups:
-- `loadCurrentGroups` (lib/sync/pipeline.ts) SKIPS every copy whose `presence_group_id` is null. So a copy
-- with no group is invisible to the next import, and that import creates a second copy of the same card —
-- the twins she found (UIL-098). The TypeScript side is closed: after UIL-098 parts 2 and 3 only
-- lib/sync/exec.ts emits `insert_copy`, always with a group, and tests/copy/only-sync-creates-copies.test.ts
-- fails the build if any other file starts to. This migration makes the DATABASE refuse the same thing, so
-- a future path — or a direct API insert, which RLS alone allows the signed-in owner — cannot quietly create
-- inventory the import cannot see.
--
-- WHAT IT DOES.
--   1. Refuses to run, naming the count, if any copy has no group. Checked by the Senior BA's read before
--      merge (`copy?presence_group_id=is.null` = 0 on Testing); this makes a surprise fail loudly in migrate
--      rather than as a bare NOT NULL error.
--   2. `copy.presence_group_id` NOT NULL.
--   3. Its foreign key goes from ON DELETE SET NULL to ON DELETE RESTRICT. SET NULL on a NOT NULL column
--      would turn "delete a group that still holds cards" into a constraint error anyway; RESTRICT says so
--      on purpose, and names the constraint. No app path deletes a presence group (only inserts exist);
--      the Testing wipe deletes copies before groups.
--
-- Expected row effect: NONE. No row is written. Testing: 720 copies, all grouped (the Senior BA's reads).
-- Production: empty until the promotion, which inserts presence_group before copy (scripts/promote-collection.mjs).

do $$
declare
  ungrouped integer;
begin
  select count(*) into ungrouped from copy where presence_group_id is null;
  if ungrouped > 0 then
    raise exception
      '0023: % copy row(s) have no presence group, so the next Dex import cannot see them. Link or remove them before this migration (UIL-098 part 4).',
      ungrouped;
  end if;
end $$;

alter table copy alter column presence_group_id set not null;

alter table copy drop constraint copy_presence_group_id_fkey;
alter table copy
  add constraint copy_presence_group_id_fkey
  foreign key (presence_group_id) references presence_group (id) on delete restrict;

comment on column copy.presence_group_id is
  'The Dex (card, variant) this copy belongs to. REQUIRED since 0023: the import sees only grouped copies, so an ungrouped copy was invisible to it and got twinned (UIL-098). ON DELETE RESTRICT: a group that still holds cards cannot be deleted.';
