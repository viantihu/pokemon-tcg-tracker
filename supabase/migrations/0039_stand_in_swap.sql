-- 0039_stand_in_swap — once TCGdex carries the real card, her stand-in is swapped for it (UIL-060 Half 2).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0038 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- Karvi (2026-10-22): "There should be a mechanism in place to automatically match these cards once TCGdex adds
-- them." Which real card a stand-in is, and whether that is certain enough to swap without asking her, is decided in
-- the app (lib/catalog/stand-in.ts `standInMatch`); this file only does the swap, whole or not at all.
--
--   swap_stand_in(stand_in_id, real_id)  NEW: repoints every row that names the stand-in at the real card, rewrites
--                                         the undo snapshot so an Undo puts back the real card, then deletes the
--                                         stand-in. One call, one transaction.
--   catalog_card_user_delete             NEW policy: she may delete her OWN stand-ins (0015 gave no DELETE; a stand-in
--                                         with copies is still protected by copy's `on delete restrict`).
--
-- EVERY PLACE A CARD ID LIVES (read from Testing's catalog, 2026-10-22; FK = foreign key to catalog_card):
--   copy.catalog_card_id (FK, restrict)              presence_group.catalog_card_id (FK, cascade)
--   dex_presence.catalog_card_id (FK, cascade)        removed_presence.catalog_card_id (FK, cascade)
--   line_slot.target_catalog_card_id (FK, set null)  wishlist_item.chosen_catalog_card_id (FK, set null)
--   unresolved_entry.manual_match_id (FK, set null)  placement_decision.catalog_card_id (no FK)
--   wishlist_item.alternate_catalog_card_ids (array) collection.target_catalog_card_ids (array)
--   last_sync_snapshot.snapshot (jsonb: the undo record's card ids)
-- A cascade or set-null FK missed here would lose her data silently when the stand-in is deleted, so every one is
-- repointed BEFORE the delete; tests/catalog/stand-in-swap.test.ts names each of them.
--
-- A CLASH IS REFUSED, NOT MERGED. presence_group, dex_presence and removed_presence are unique on (owner, card, Dex
-- variant). If she already holds the real card under the same variant as the stand-in, the two would have to be
-- merged (copies moved between groups, counts recombined); that is not done here. The swap raises
-- `stand_in_swap_clash` and changes nothing, and the app shows the pair to her instead.
--
-- SECURITY as 0006–0038: `security invoker` (every statement runs under her RLS, so only her rows are touched and
-- only her own stand-in can be deleted), `set search_path = public, pg_temp`, no dynamic SQL.

create policy catalog_card_user_delete on catalog_card
  for delete to authenticated
  using (source = 'user' and owner_id = auth.uid());

create or replace function swap_stand_in(stand_in_id text, real_id text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  s catalog_card%rowtype;
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

  if exists (
       select 1 from presence_group a join presence_group b
         on b.owner_id = a.owner_id and b.dex_variant_raw is not distinct from a.dex_variant_raw
        where a.catalog_card_id = stand_in_id and b.catalog_card_id = real_id)
     or exists (
       select 1 from dex_presence a join dex_presence b
         on b.owner_id = a.owner_id and b.dex_variant_raw is not distinct from a.dex_variant_raw
        where a.catalog_card_id = stand_in_id and b.catalog_card_id = real_id)
     or exists (
       select 1 from removed_presence a join removed_presence b
         on b.owner_id = a.owner_id and b.dex_variant_raw is not distinct from a.dex_variant_raw
        where a.catalog_card_id = stand_in_id and b.catalog_card_id = real_id)
  then
    raise exception 'You already have the real card under the same variant, so the two cannot be swapped automatically.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'stand_in_swap_clash', 'stand_in', stand_in_id,
                                       'real', real_id)::text;
  end if;

  update copy             set catalog_card_id = real_id        where catalog_card_id = stand_in_id;
  update presence_group   set catalog_card_id = real_id        where catalog_card_id = stand_in_id;
  update dex_presence     set catalog_card_id = real_id        where catalog_card_id = stand_in_id;
  update removed_presence set catalog_card_id = real_id        where catalog_card_id = stand_in_id;
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

  -- The undo record holds card ids as plain JSON strings (lib/sync/undo.ts `AppliedSnapshot`). An Undo after the
  -- swap must put back the real card: the stand-in it names is about to be gone. Replacing the QUOTED id touches
  -- only a whole string value, never part of a longer one.
  update last_sync_snapshot
     set snapshot = replace(snapshot::text, to_json(stand_in_id)::text, to_json(real_id)::text)::jsonb
   where strpos(snapshot::text, to_json(stand_in_id)::text) > 0;

  delete from catalog_card where tcgdex_id = stand_in_id;
end;
$$;

comment on function swap_stand_in(text, text) is
  'UIL-060 Half 2: repoint everything naming her stand-in at the real TCGdex card, then delete the stand-in. Refuses a clash (she already holds the real card under the same Dex variant).';

grant execute on function swap_stand_in(text, text) to authenticated, service_role;
