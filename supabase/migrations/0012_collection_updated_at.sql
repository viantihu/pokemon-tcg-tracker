-- UIL-052 — sort collections by most-recently-modified.
--
-- "Modified" is defined as: a card shelved/re-shelved into one of the collection's binders, a
-- wishlist placeholder added for it, or its own curated lists edited directly. There is no single
-- application-layer choke point for the first of those — nine independent write paths can place a
-- copy into a specialty binder (haul commit, a Line-screen move, logging a card, a bulk target add,
-- sync, backfill, collection removal moving a card OUT), three of which never go through the
-- `apply_write_ops` RPC at all. Bumping `updated_at` at each TypeScript call site would be nine places
-- to remember and, per this repo's own history (UIL-012, UIL-014, UIL-048 — a THIRD write path missing
-- the same fix each time), a tenth to eventually forget.
--
-- So this is done with triggers instead — the same instinct as `apply_write_ops` itself (0006/0007/
-- 0008): one place a write cannot bypass, because it lives on the table, not in any one caller.
--
-- WIDENS her literal wording on purpose: she said "shelved/re-shelved into it", which read strictly is
-- additions only, but the intent behind sorting by "recently modified" is "what did I touch", and a
-- card LEAVING a collection (a removal) is unambiguously touching it. The `copy` trigger below fires
-- on both directions of a shelve — recorded here as a visible decision, not a silent liberty, so it is
-- a one-line change if she disagrees.
--
-- Backfilled from `created_at`, NOT a blanket `now()`: a plain `add column ... default now()` would
-- have every existing collection's `updated_at` evaluate to the SAME single timestamp (the default
-- expression for a volatile function like `now()` is computed once per statement, not once per row),
-- which would falsely claim all eleven of her collections were "just modified" — a lie she'd see
-- immediately on the sorted list. `created_at` is the truthful prior: it orders existing collections by
-- when she made them until real activity bumps them, same as a NULL never would (every existing row
-- would sort into one indistinguishable block, or last, behind anything she touches next). New rows
-- still default to `now()` at insert time.
alter table collection add column updated_at timestamptz;
update collection set updated_at = created_at;
alter table collection alter column updated_at set default now();
alter table collection alter column updated_at set not null;

-- ---------------------------------------------------------------------------------------------
-- Trigger 1: a collection's OWN curated lists changing is a modification by definition.
--
-- Covers `union_collection_targets`/`subtract_collection_targets` (0007/0008 — both are a plain
-- `update collection set target_catalog_card_ids = ...`) and the two direct-repo paths that update a
-- collection row without ever going through the RPC (`applyCollectionLog`'s target union,
-- `applyCollectionSave`/`applyBulkAddTargets`'s target/binder writes).
--
-- `is distinct from` guards against bumping on a no-op re-save (e.g. re-tagging a card the collection
-- already chases) — a write that changes nothing must not reorder her list.
-- ---------------------------------------------------------------------------------------------
create function collection_touch() returns trigger
language plpgsql
as $$
begin
  if new.target_catalog_card_ids is distinct from old.target_catalog_card_ids
     or new.current_binder_ids is distinct from old.current_binder_ids then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger collection_touch_trg
  before update on collection
  for each row
  execute function collection_touch();

-- ---------------------------------------------------------------------------------------------
-- Trigger 2: a card shelved into, or un-shelved out of, one of a collection's binders.
--
-- Membership is the exact rule `lib/coll/remove.ts` already documents: a shelved copy sitting in one
-- of the collection's `current_binder_ids`, whose `catalog_card_id` is on its `target_catalog_card_ids`
-- — checked here against BOTH the new row values (a shelve, or a card moving IN) and the old row
-- values (an un-shelve, or a card moving OUT), so a card moving from collection A's binder to
-- collection B's bumps both, and a plain removal (role flips to bulk/block, or the binder changes)
-- bumps the collection it left. `update of` (not a bare `after insert or update`) means an edit to any
-- OTHER copy column — `binder_half`, `color_band`, `line_slot_id` — never fires this at all.
--
-- Fires once per row: a sync applying hundreds of copy writes in one commit fires this hundreds of
-- times. At her scale (~706 copies today, 11 collections) that is trivially fine; it would not
-- necessarily stay fine at an order of magnitude more copies AND more collections at once, the same
-- bound this app states rather than hides everywhere else (see `browse()`'s in-memory re-paging note).
-- ---------------------------------------------------------------------------------------------
create function copy_bumps_collection() returns trigger
language plpgsql
as $$
begin
  if new.role = 'shelved' and new.binder_id is not null then
    update collection
       set updated_at = now()
     where new.binder_id = any (current_binder_ids)
       and new.catalog_card_id = any (target_catalog_card_ids);
  end if;

  if tg_op = 'UPDATE' and old.role = 'shelved' and old.binder_id is not null then
    update collection
       set updated_at = now()
     where old.binder_id = any (current_binder_ids)
       and old.catalog_card_id = any (target_catalog_card_ids);
  end if;

  return new;
end;
$$;

create trigger copy_bumps_collection_trg
  after insert or update of binder_id, role, catalog_card_id on copy
  for each row
  execute function copy_bumps_collection();

-- ---------------------------------------------------------------------------------------------
-- Trigger 3: a placeholder added for a collection.
--
-- A collection's "placeholder" is never a `line_slot` — those are a general-binder, back-half-only
-- mechanism (`evolution_line.half` is checked = 'back'; `placementForMove`'s collection case always
-- nulls `line_slot_id`). It is a `wishlist_item` row with `held_for_binder_id` set to the collection's
-- specialty binder (`will_live_in_specialty = true`), written by `wishlistCollectionCard` and by
-- specialty backfill tagging. Insert-only: a wishlist placeholder later being FULFILLED means a real
-- card got shelved, which trigger 2 above already covers.
-- ---------------------------------------------------------------------------------------------
create function wishlist_bumps_collection() returns trigger
language plpgsql
as $$
begin
  if new.held_for_binder_id is not null and new.will_live_in_specialty then
    update collection
       set updated_at = now()
     where new.held_for_binder_id = any (current_binder_ids);
  end if;
  return new;
end;
$$;

create trigger wishlist_bumps_collection_trg
  after insert on wishlist_item
  for each row
  execute function wishlist_bumps_collection();
