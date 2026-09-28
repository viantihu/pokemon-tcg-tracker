-- 0034_line_tightening — a line is only OPEN or CLOSED, a stage's card is hers only when she chases it, and one card
-- fills at most one pocket (UIL-121, step D).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0033 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- KARVI'S RULINGS (2026-09-27): "Functionally, there are only 2 stages: open or closed", and nothing is written for her.
-- 0030 added that vocabulary and converted the rows then; it left the old words allowed while writers in other lanes
-- moved. They have: the decision cards retired (#432), Backfill writes her choices (#422), the Haul Plan's writers go
-- through the one line builder (#434, #441). So this step converts what is left and FORBIDS the old words.
--
--   evolution_line.status       complete, terminated -> closed; capped -> open; every slot filled -> closed;
--                               the CHECK is ('open', 'closed')
--   line_slot (placeholder)     an undecided stage with exactly one open wish on an open line -> her chase, of the
--                               wished card when it names none (0 such rows on Testing at the last read)
--                               an old engine target on a stage she has not chased -> none (2 rows on Testing at the
--                               0032 read). Since #441 the Haul Plan names a stage only by a card or her chase, so
--                               clearing these no longer hides a stage from it.
--   binder_block                one card fills at most one pocket: UNIQUE (copy_id) where there is one (the Senior BA's
--                               backstop, 2026-09-27); a filler fills exactly one pocket (pocket_count = 1)
--
-- Function-free: no `apply_write_ops` change (the CHECK and the index hold every writer, and the RPC's own
-- constraint errors roll the whole write back).
--
-- ORDER: after #441 (the Haul Plan names an undecided stage by the card's own chain, not by a leftover target).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Existing rows. Every statement has a WHERE (pg_safeupdate).
--
-- >>> 0034 CONVERSION. The statements between the two markers also run, unchanged, on each labelled Testing baseline
-- (a backup_* schema) when it is re-stamped past 0034, with search_path set to that schema. So they name tables
-- unqualified, need no column newer than 0030's, and change nothing when run twice. A baseline taken before 0030 is
-- re-stamped with 0030's marked statements first, then these.
-- tests/db/line-tightening.test.ts runs them on a copy of the tables and compares the result with this migration's.
update evolution_line set status = 'closed' where status in ('complete', 'terminated');
update evolution_line set status = 'open' where status = 'capped';
-- A line with every slot filled is closed, whatever word it carried (0030's rule, again for rows written since).
update evolution_line l set status = 'closed'
 where l.status = 'open'
   and exists (select 1 from line_slot s where s.line_id = l.id)
   and not exists (select 1 from line_slot s where s.line_id = l.id and s.state <> 'filled');

-- An undecided stage she wished for, on an open line, is her chase: of the card it names, else the wished card.
update line_slot s
   set stage_choice = 'chase',
       target_catalog_card_id = coalesce(
         s.target_catalog_card_id,
         (select w.chosen_catalog_card_id from wishlist_item w
           where w.line_slot_id = s.id and w.resolved_at is null)
       )
 where s.state = 'placeholder' and s.stage_choice is null
   and exists (select 1 from evolution_line l where l.id = s.line_id and l.status = 'open')
   and (select count(*) from wishlist_item w where w.line_slot_id = s.id and w.resolved_at is null) = 1
   and coalesce(
         s.target_catalog_card_id,
         (select w.chosen_catalog_card_id from wishlist_item w
           where w.line_slot_id = s.id and w.resolved_at is null)
       ) is not null;

-- A card named on a stage she has not chased was the engine's pick, never hers: the stage names none.
update line_slot set target_catalog_card_id = null
 where state = 'placeholder' and stage_choice is distinct from 'chase'
   and target_catalog_card_id is not null;
-- <<< 0034 CONVERSION

-- ---------------------------------------------------------------------------------------------------------------
-- 2. One card, one pocket. A card already in two pockets is a choice the data cannot make for her: stop, and name
-- them, before the index would refuse without saying which (0 block rows on Testing at the last read).
do $$
declare
  dup text;
begin
  select string_agg(format('copy %s in blocks %s', d.copy_id, d.ids), '; ')
    into dup
    from (select b.copy_id, string_agg(b.id::text, ', ' order by b.id) as ids
            from binder_block b
           where b.copy_id is not null
           group by b.copy_id
          having count(*) > 1) d;
  if dup is not null then
    raise exception '0034: a card fills more than one pocket; resolve these before this migration: %', dup;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The vocabulary, held.
alter table evolution_line drop constraint evolution_line_status_check;
alter table evolution_line add constraint evolution_line_status_check
  check (status in ('open', 'closed'));

create unique index binder_block_one_per_copy on binder_block (copy_id) where copy_id is not null;
alter table binder_block add constraint binder_block_filler_one_pocket
  check (purpose <> 'line-filler' or pocket_count = 1);
