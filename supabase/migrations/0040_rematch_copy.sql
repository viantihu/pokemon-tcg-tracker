-- 0040_rematch_copy — a card the sync matched to the wrong catalog card is rematched from the Haul Plan.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0039 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- Karvi (2026-10-26): "There should be an option in the haul plan to either rematch a card or create a stand-in, in
-- case the wrong card has been matched during the sync." Which card it should be (a catalog pick, or a stand-in she
-- makes) is decided in the app (lib/copy/rematch.ts); this file only moves the copy, whole or not at all.
--
--   rematch_copy(p_copy_id, p_card_id)  NEW: points ONE waiting copy at a different catalog card, and moves that one
--                                       card's count between the two Dex keys so the Count check still adds up.
--
-- WHAT MOVES. `copy.catalog_card_id` and `copy.presence_group_id` (the copy's Dex key is (card, Dex variant), and the
-- variant string does not change). Then, so the per-card Count check (0022: copies = max(0, Dex − removed)) and the
-- file-level one (0024: file total = Σ dex_presence + waiting + dismissed) both keep holding:
--   * the old key's `dex_presence.quantity` falls by one (the row goes at zero), and
--   * the new key's rises by one (the row is made when there is none),
--   * both presence groups' `desired_count` are recomputed from their copies.
-- A key with no `dex_presence` row (no import recorded yet) moves no count: its copy was never counted.
--
-- ONLY A WAITING COPY. The copy must still be in the haul — role 'haul', no binder, no line slot — with no
-- `placement_decision` row (the same test lib/plan/pending.ts uses for "waiting"). A shelved copy sits in a pocket
-- that was chosen for the card it was; moving it to another card would leave a filled slot naming the wrong card,
-- which is what the slot invariants (0018, 0028) exist to prevent. She moves a shelved card with the Line screen's
-- Move, and fixes the match first.
--
-- A CLASH IS A MERGE. If she already holds the new card under the same Dex variant, the copy joins that presence
-- group (Karvi's ruling): the group is the same unique key (owner, card, Dex variant) either way, so there is
-- nothing to reconcile beyond the two counts above. (swap_stand_in refuses its clash because it moves a whole card's
-- groups; this moves one waiting copy, which is always safe to add.)
--
-- WHAT IT DOES NOT TOUCH. `unresolved_entry.manual_match_id` (the pin that makes an import keep a hand match) and the
-- undo snapshot. The next FULL Dex import re-reads the file, so a row the catalog still resolves to the old card is
-- shown in its preview for her to review, exactly as for any other hand change; making a rematch survive an import
-- needs the Dex row's own id, which a copy does not carry (UIL-082's pin is keyed by it).
--
-- SECURITY as 0006–0039: `security invoker` (every statement runs under her RLS, so only her rows are touched),
-- `set search_path = public, pg_temp`, no dynamic SQL, every UPDATE / DELETE scoped (pg_safeupdate, 0026).

create or replace function rematch_copy(p_copy_id uuid, p_card_id text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c         copy%rowtype;
  old_gid   uuid;
  new_gid   uuid;
  counted   integer;
begin
  -- Hers, and locked so two rematches of one copy cannot both run.
  select * into c from copy where id = p_copy_id for update;
  if not found then
    raise exception 'That card is no longer in your collection. Reload to see where your cards are now.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'rematch_copy_missing', 'copy', p_copy_id)::text;
  end if;

  -- Still waiting: in the haul, unplaced, and never decided.
  if c.role <> 'haul' or c.binder_id is not null or c.line_slot_id is not null
     or exists (select 1 from placement_decision d where d.copy_id = c.id) then
    raise exception 'That card has already been shelved, so it cannot be rematched here. Move it from the Line screen instead.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'rematch_copy_placed', 'copy', p_copy_id)::text;
  end if;

  if c.catalog_card_id = p_card_id then
    raise exception 'That is the card it is already matched to.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'rematch_same_card', 'card', p_card_id)::text;
  end if;

  -- A card she can see: a TCGdex card, or one of her own stand-ins (0033's read policy).
  if not exists (select 1 from catalog_card k where k.tcgdex_id = p_card_id) then
    raise exception 'That card is not in the catalog.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'rematch_card_missing', 'card', p_card_id)::text;
  end if;

  -- Every copy has a Dex key (0023); one without a Dex variant has nowhere to be counted.
  if c.dex_variant_raw is null then
    raise exception 'That card has no Dex variant recorded, so it cannot be rematched. Re-import your Dex file first.'
      using errcode = 'P0001',
            detail = json_build_object('check', 'rematch_copy_no_key', 'copy', p_copy_id)::text;
  end if;

  old_gid := c.presence_group_id;

  -- The new key's presence group: the one she already has, else a new one.
  select g.id into new_gid from presence_group g
   where g.catalog_card_id = p_card_id and g.dex_variant_raw = c.dex_variant_raw;
  if new_gid is null then
    insert into presence_group (catalog_card_id, dex_variant_raw, desired_count)
      values (p_card_id, c.dex_variant_raw, 0)
      returning id into new_gid;
  end if;

  -- The count moves with the copy, but only when the old key was counted at all.
  update dex_presence
     set quantity = quantity - 1, updated_at = now()
   where catalog_card_id = c.catalog_card_id and dex_variant_raw = c.dex_variant_raw and quantity > 1;
  get diagnostics counted = row_count;
  if counted = 0 then
    delete from dex_presence
     where catalog_card_id = c.catalog_card_id and dex_variant_raw = c.dex_variant_raw and quantity = 1;
    get diagnostics counted = row_count;
  end if;
  if counted > 0 then
    insert into dex_presence (catalog_card_id, dex_variant_raw, quantity)
      values (p_card_id, c.dex_variant_raw, 1)
      on conflict (owner_id, catalog_card_id, dex_variant_raw)
      do update set quantity = dex_presence.quantity + 1, updated_at = now();
  end if;

  update copy set catalog_card_id = p_card_id, presence_group_id = new_gid where id = c.id;

  -- Both groups hold their live copy count again (the same recompute apply_write_ops does after every write).
  update presence_group g
     set desired_count = (select count(*) from copy where copy.presence_group_id = g.id)
   where g.id in (old_gid, new_gid);
end;
$$;

comment on function rematch_copy(uuid, text) is
  'Point ONE waiting copy at a different catalog card (the sync matched it wrongly), moving its count between the two Dex keys. Refuses a shelved copy. Joins her existing group for the new card.';

grant execute on function rematch_copy(uuid, text) to authenticated, service_role;
