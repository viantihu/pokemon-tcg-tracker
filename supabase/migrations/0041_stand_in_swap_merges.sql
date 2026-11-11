-- 0041_stand_in_swap_merges — swapping a stand-in for a real card she already holds MERGES the two, as a rematch does.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0040 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY. 0039 `swap_stand_in` refused any "clash": the real card already having a presence_group, dex_presence or
-- removed_presence row under the stand-in's Dex variant. That is not rare, it is how a stand-in usually comes to be:
--   * "Wrong card?" (0040) moves a copy OFF the real card onto a stand-in and leaves the real card's presence group
--     behind, empty (desired_count 0). Swapping back then reads that empty group as "you already have it".
--   * The sync matched the real card, she removed it as wrong (a removed_presence memory on the real key) and made a
--     stand-in instead; swapping back hits the memory.
-- Both are the SAME card under the same Dex key, so the honest result is one key holding both sides' rows. 0040 made
-- the same ruling for one copy ("A clash is a merge"); this applies it to a whole stand-in.
--
-- HOW EACH KEYED TABLE MERGES (unique on owner, card, Dex variant):
--   presence_group    her copies move to the real card's group; the stand-in's group goes; desired_count is
--                     recomputed from the copies (as apply_write_ops and 0040 do).
--   dex_presence      quantities add: each Dex row counts on exactly one key, so the file-level check (0024) holds.
--   removed_presence  counts add: a removal of either is a removal of the card.
-- A stand-in row with no counterpart on the real card is repointed, as before. Every other column is repointed exactly
-- as 0039 did (the list and the undo-record rewrite are unchanged).
--
-- SECURITY as 0006–0040: `security invoker` (every statement runs under her RLS, so only her rows are touched and
-- only her own stand-in can be deleted), `set search_path = public, pg_temp`, no dynamic SQL, every UPDATE / DELETE
-- scoped (pg_safeupdate, 0026).

create or replace function swap_stand_in(stand_in_id text, real_id text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  s catalog_card%rowtype;
  g record;
  real_gid uuid;
begin
  -- Hers, and still a stand-in. Locked, so two swaps of one stand-in cannot both run.
  select * into s from catalog_card c
   where c.tcgdex_id = stand_in_id and c.source = 'user' and c.owner_id = auth.uid()
     for update;
  if not found then
    raise exception 'That stand-in is not in your catalog any more. Reload to see where your cards are now.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'stand_in_missing', 'stand_in', stand_in_id)::text;
  end if;

  -- A real TCGdex card in the stand-in's own language (UIL-108: a Japanese card never becomes an English printing).
  if not exists (
    select 1 from catalog_card c
     where c.tcgdex_id = real_id and c.source = 'tcgdex' and c.locale = s.locale
  ) then
    raise exception 'That card is not in the catalog in this language.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'stand_in_real_missing', 'real', real_id)::text;
  end if;

  -- presence_group: merge into the real card's group of the same variant, else repoint.
  for g in
    select * from presence_group where catalog_card_id = stand_in_id
  loop
    select r.id into real_gid from presence_group r
     where r.catalog_card_id = real_id and r.dex_variant_raw is not distinct from g.dex_variant_raw;
    if real_gid is null then
      update presence_group set catalog_card_id = real_id where id = g.id;
    else
      update copy set presence_group_id = real_gid where presence_group_id = g.id;
      delete from presence_group where id = g.id;
      update presence_group r
         set desired_count = (select count(*) from copy where copy.presence_group_id = r.id)
       where r.id = real_gid;
    end if;
  end loop;

  -- dex_presence: quantities add on a shared key.
  update dex_presence r
     set quantity = r.quantity + d.quantity, updated_at = now()
    from dex_presence d
   where d.catalog_card_id = stand_in_id and r.catalog_card_id = real_id
     and r.dex_variant_raw is not distinct from d.dex_variant_raw;
  delete from dex_presence d
   where d.catalog_card_id = stand_in_id
     and exists (select 1 from dex_presence r
                  where r.catalog_card_id = real_id and r.dex_variant_raw is not distinct from d.dex_variant_raw);
  update dex_presence set catalog_card_id = real_id where catalog_card_id = stand_in_id;

  -- removed_presence: counts add on a shared key.
  update removed_presence r
     set count = r.count + d.count, updated_at = now()
    from removed_presence d
   where d.catalog_card_id = stand_in_id and r.catalog_card_id = real_id
     and r.dex_variant_raw is not distinct from d.dex_variant_raw;
  delete from removed_presence d
   where d.catalog_card_id = stand_in_id
     and exists (select 1 from removed_presence r
                  where r.catalog_card_id = real_id and r.dex_variant_raw is not distinct from d.dex_variant_raw);
  update removed_presence set catalog_card_id = real_id where catalog_card_id = stand_in_id;

  update copy             set catalog_card_id = real_id        where catalog_card_id = stand_in_id;
  update line_slot        set target_catalog_card_id = real_id where target_catalog_card_id = stand_in_id;
  update wishlist_item    set chosen_catalog_card_id = real_id where chosen_catalog_card_id = stand_in_id;
  update unresolved_entry set manual_match_id = real_id        where manual_match_id = stand_in_id;
  update placement_decision set catalog_card_id = real_id      where catalog_card_id = stand_in_id;

  -- The id lists: the real card takes the stand-in's place, once (a list that already names it just loses the
  -- stand-in).
  update wishlist_item
     set alternate_catalog_card_ids = case
           when real_id = any (alternate_catalog_card_ids)
             then array_remove(alternate_catalog_card_ids, stand_in_id)
           else array_replace(alternate_catalog_card_ids, stand_in_id, real_id)
         end
   where stand_in_id = any (alternate_catalog_card_ids);
  update collection
     set target_catalog_card_ids = case
           when real_id = any (target_catalog_card_ids)
             then array_remove(target_catalog_card_ids, stand_in_id)
           else array_replace(target_catalog_card_ids, stand_in_id, real_id)
         end
   where stand_in_id = any (target_catalog_card_ids);

  -- The undo record holds card ids as plain JSON strings (lib/sync/undo.ts `AppliedSnapshot`); see 0039.
  update last_sync_snapshot
     set snapshot = replace(snapshot::text, to_json(stand_in_id)::text, to_json(real_id)::text)::jsonb
   where strpos(snapshot::text, to_json(stand_in_id)::text) > 0;

  delete from catalog_card where tcgdex_id = stand_in_id;
end;
$$;

comment on function swap_stand_in(text, text) is
  'UIL-060 Half 2 (0041): repoint everything naming her stand-in at the real TCGdex card, merging a shared Dex key (copies join the real group; Dex quantities and removals add), then delete the stand-in.';

grant execute on function swap_stand_in(text, text) to authenticated, service_role;
