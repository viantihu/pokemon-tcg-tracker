-- 0035_bulk_units — bulk is a storage unit she names, like a binder, and a full box with a card limit takes no more
-- (UIL-130, PR 1 of 3).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0034 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- KARVI'S RULINGS (2026-09-29): several bulk boxes per account, added like binders, each with a name. A box's
-- capacity is optional ("a unit may track no capacity"); a new box starts untracked. A box with a finite capacity
-- that is full REFUSES: "Stop it, ask for another. This should only apply to boxes that have a finite capacity."
-- Her first box is named "Bulk box". Phase 2 adds sorted bulk (`kind` is reserved for it).
--
--   bulk_unit              new: her boxes (owner-scoped, RLS owner_all). capacity NULL = untracked, never full.
--   copy.bulk_unit_id      new: the box a bulk copy is in. Required for role 'bulk'; none for 'haul'/'shelved';
--                          a 'block' (a spare card filling a pocket) keeps its home box, so it goes back there.
--
-- EVERY EXISTING WRITER KEEPS WORKING UNCHANGED (the Senior BA's condition, route (a)): the app does not know about
-- boxes until PR 2. A BEFORE trigger on copy fills a bulk copy's box with her default box (creating "Bulk box" if she
-- has none, in the same transaction), clears it when a copy leaves bulk for the haul or a binder, and keeps it on a
-- block. It runs before the CHECKs, so they hold for every writer, and it refuses a copy entering a full box that has
-- a capacity, in her words, not as a raw constraint error. Moving OUT of a box is never refused.
--
-- Expected row effect on Testing (the DB Engineer's read): one "Bulk box" for her; her 54 bulk copies move into it,
-- and the 4 spare cards filling pockets take it as their home (58 copies boxed). Function-free on the RPC:
-- no `apply_write_ops` change (the #418 chain guard is untouched).
--
-- SECURITY: the trigger is SECURITY INVOKER with `set search_path = public, pg_temp` and no dynamic SQL. As the
-- signed-in owner it sees, locks and creates only her own boxes (owner_all); the service role and postgres (the
-- promotion, a migration) bypass RLS as they do for every table. It touches only NEW.owner_id's boxes, and a refused
-- row rolls back the box it may have created.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Her boxes. (A baseline re-stamp creates this table and the column below in the backup schema, plain, before
-- running the marked statements, as it did for 0030's columns.)
create table bulk_unit (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  name        text not null check (length(btrim(name)) > 0),
  sort_order  integer not null default 0,
  is_default  boolean not null default false,
  -- NULL: untracked, never full (Karvi: a new box starts untracked). A number: how many cards it holds.
  capacity    integer check (capacity is null or capacity > 0),
  -- Reserved for phase 2's sorted bulk; every box is plain bulk today.
  kind        text not null default 'bulk' check (kind in ('bulk')),
  created_at  timestamptz not null default now()
);
comment on table bulk_unit is
  'Her bulk boxes (UIL-130). capacity NULL = untracked (never full); a box with a capacity refuses a card when full.';
create unique index bulk_unit_one_default on bulk_unit (owner_id) where is_default;
create index bulk_unit_owner_idx on bulk_unit (owner_id);

alter table bulk_unit enable row level security;
create policy owner_all on bulk_unit
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table copy add column bulk_unit_id uuid references bulk_unit (id) on delete restrict;
create index copy_bulk_unit_idx on copy (bulk_unit_id) where bulk_unit_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Existing rows. Every UPDATE has a WHERE (pg_safeupdate).
--
-- >>> 0035 CONVERSION. The statements between the two markers also run, unchanged, on each labelled Testing baseline
-- (a backup_* schema) when it is re-stamped past 0035, with search_path set to that schema. So they name tables
-- unqualified, need only the table and column section 1 adds, change nothing when run twice, and give a box the
-- SAME id on live and on a baseline (derived from its owner), so a restored baseline compares row for row.
-- tests/db/bulk-units.test.ts runs them on a copy of the tables and compares the result with this migration's.
insert into bulk_unit (id, owner_id, name, sort_order, is_default)
select md5('bulk-box:' || o.owner_id::text)::uuid, o.owner_id, 'Bulk box', 0, true
  from (select owner_id from copy union select owner_id from binder) o
 where not exists (select 1 from bulk_unit u where u.owner_id = o.owner_id);

-- Every card in her bulk box is in her first box.
update copy c set bulk_unit_id = u.id
  from bulk_unit u
 where c.role = 'bulk' and c.bulk_unit_id is null
   and u.owner_id = c.owner_id and u.is_default;

-- A spare card filling a pocket came from her bulk box: that is its home.
update copy c set bulk_unit_id = u.id
  from bulk_unit u
 where c.role = 'block' and c.bulk_unit_id is null
   and u.owner_id = c.owner_id and u.is_default
   and exists (select 1 from binder_block b where b.copy_id = c.id and b.purpose = 'line-filler');
-- <<< 0035 CONVERSION

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The box a copy is in, for every writer.
create or replace function copy_bulk_unit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  unit     bulk_unit%rowtype;
  entering boolean;
  held     integer;
begin
  if new.role in ('haul', 'shelved') then
    -- Out of bulk, into the haul or a binder: no box.
    new.bulk_unit_id := null;
    return new;
  end if;
  if new.role <> 'bulk' then
    -- A block keeps its home box (a spare card filling a pocket goes back there).
    return new;
  end if;

  if new.bulk_unit_id is null then
    -- A writer that does not name a box (every writer before UIL-130 PR 2): her default box, created if she has none.
    select * into unit from bulk_unit u where u.owner_id = new.owner_id and u.is_default;
    if not found then
      -- The same id the conversion gives her first box (derived from her), so a box made here, by the migration and
      -- on a baseline always coincide, and a refresh-to-baseline never meets two defaults (the DB Engineer's ask).
      insert into bulk_unit (id, owner_id, name, sort_order, is_default)
        values (md5('bulk-box:' || new.owner_id::text)::uuid, new.owner_id, 'Bulk box', 0, true)
        on conflict do nothing;
      select * into unit from bulk_unit u where u.owner_id = new.owner_id and u.is_default;
    end if;
    new.bulk_unit_id := unit.id;
  end if;

  -- The box is hers, and a box with a capacity that is full takes no more. Locked, so two writes at once cannot
  -- both take its last place.
  select * into unit from bulk_unit u where u.id = new.bulk_unit_id for update;
  if not found or unit.owner_id <> new.owner_id then
    raise exception 'That box isn''t one of yours any more. Reload and pick again.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'bulk_unit_owner', 'table', tg_table_name)::text;
  end if;
  -- Entering the box: a new copy, or one that was not in bulk, or was in another box. (OLD only on an UPDATE.)
  if tg_op = 'INSERT' then
    entering := true;
  else
    entering := old.role is distinct from 'bulk' or old.bulk_unit_id is distinct from new.bulk_unit_id;
  end if;
  if entering and unit.capacity is not null then
    select count(*) into held from copy c
     where c.bulk_unit_id = unit.id and c.role = 'bulk' and c.id <> new.id;
    if held >= unit.capacity then
      raise exception 'Your % is full. Pick another box.', unit.name
        using errcode = 'P0001',
              detail = json_build_object('check', 'bulk_unit_full', 'unit', unit.id,
                                         'capacity', unit.capacity)::text;
    end if;
  end if;
  return new;
end;
$$;

create trigger copy_bulk_unit before insert or update on copy
  for each row execute function copy_bulk_unit();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Held for every writer, after the trigger has run.
alter table copy add constraint copy_bulk_unit_role check (
  (role <> 'bulk' or bulk_unit_id is not null)
  and (role not in ('haul', 'shelved') or bulk_unit_id is null)
);
