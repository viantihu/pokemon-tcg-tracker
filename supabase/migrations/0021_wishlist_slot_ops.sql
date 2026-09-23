-- 0021_wishlist_slot_ops — resolving a line decision lands WHOLE or not at all (UIL-095).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0020 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHAT IS WRONG TODAY. `lib/line/write.ts`'s `applyDecision` performs a SEQUENCE of separate writes: the
-- line's status, then one update per slot patch, then a read of the whole `wishlist_item` table, then a
-- wishlist update or insert per slot, then the `placement_decision` row. Any failure after the first leaves
-- her decision half-applied — a line capped with its slot unmarked, a slot re-pointed with no wishlist row,
-- or every write landed and NO audit row, which UIL-042 says is not optional. This is the shape UIL-014,
-- UIL-023 and UIL-033 each made High: a multi-row user action lands whole or not at all.
--
-- WHY THE RPC NEEDED NEW OPS AT ALL. Every other write in this app already goes through
-- `apply_write_ops`, and `update_line`, `update_slot` and `insert_decision` are all there. The wishlist
-- half was the blocker: nothing could update a `wishlist_item` or mark one resolved, so that half could
-- only ever have been a second statement outside the transaction.
--
-- KEYED ON THE SLOT, NOT ON A ROW ID, and that is the load-bearing choice. Today TypeScript reads EVERY
-- wishlist row, builds a slot -> id map of the open ones, and decides insert-vs-update from that snapshot.
-- The choice of statement therefore depends on a read taken before the write: a read-modify-write across
-- statements, which is exactly the fault 0007 fixed in `union_collection_targets`. Keyed on the slot, the
-- RPC decides from the row it locks and TypeScript stops reading the table at all — deleting a class of
-- staleness rather than moving it somewhere quieter.
--
-- AN ASSUMED INVARIANT BECOMES AN ENFORCED ONE. 0002 declares no uniqueness on `wishlist_item` at all, so
-- "at most one OPEN wishlist row per slot" was something the TypeScript assumed: with two, `openBySlot`
-- silently picked whichever came last. The partial unique index below states it, and the upsert then needs
-- no invented tie-break. Verified before writing this (Senior BA's read, Actions run 35818777597): Testing
-- holds 6 wishlist rows, all open, all slotted, with 6 DISTINCT `line_slot_id` values, so the index applies
-- cleanly; Production's table is empty. Taken rather than assumed, because 0018's rule (f) raised on real
-- rows that its author had not read.
--
-- A RESOLVED ROW IS NOT RESURRECTED, and the index is what says so: `where resolved_at is null` means a
-- resolved row does not participate in the conflict, so a new open row is inserted beside it. That is
-- today's behaviour, and it keeps the history of what she was chasing before.
--
-- Expected row effect on Testing: NONE. The index is additive over 6 conforming rows; no row is written,
-- and the two new branches are only reachable from a decision she resolves after this deploys.
--
-- COMPOSED FUNCTION, READ WITH ITS NEIGHBOURS. 0013 replaced `apply_write_ops`; 0014 again
-- (+ `delete_set_alias`); 0015 again (+ `insert_catalog_stand_in`); 0017 again
-- (+ `set_collection_binders`); 0020 again (+ the two `removed_presence` branches); 0016, 0018 and 0019
-- left it alone. This file replaces it AGAIN and is built on 0020's body plus TWO new branches — AND, unlike
-- every re-issue before it, ONE MODIFIED branch: `insert_decision` gains `line_id` and `line_slot_id`. So
-- the usual "verbatim plus one branch" claim is NOT true of this file, and the diff test asserts the
-- narrower thing that is: 0020's body with its `insert_decision` branch replaced by this one, plus the two
-- additions, and nothing else changed. Said explicitly because a header claiming "verbatim" of a file that
-- edits an inherited branch would be the kind of comment that outlives its truth.
--
-- WHY THAT BRANCH HAD TO CHANGE: both columns exist since 0013 and `applyDecision` has always written them,
-- but through `placementDecisionRepo.insert` — so moving that write inside the transaction without them
-- would have silently dropped them from the audit trail while claiming to preserve behaviour.
-- tests/line/decision-atomicity.test.ts pins all of it mechanically, one more link in the chain
-- tests/copy/remove-copy.test.ts extended from 0017 to 0020.
--
-- SECURITY properties are preserved EXACTLY as 0006–0020 declared them: `security invoker` (both new
-- branches run under 0002's `owner_all` policy, so a slot that is not the caller's matches no row),
-- `set search_path = public, pg_temp`, `owner_id` never read from the payload (it defaults to `auth.uid()`
-- on insert, and it is part of the index the upsert conflicts on, so one owner can never collide with
-- another's), NO dynamic SQL, and an unknown op still raises so a typo fails the whole transaction.

-- 1. The invariant the TypeScript has been assuming since M7, stated. Partial, because a slot may carry any
--    number of RESOLVED rows — that is its history — and only one open one.
create unique index wishlist_item_one_open_per_slot
  on wishlist_item (owner_id, line_slot_id)
  where resolved_at is null;

comment on index wishlist_item_one_open_per_slot is
  'At most one OPEN wishlist row per line slot (UIL-095). Assumed by lib/line/write.ts since M7 and unenforced until 0021; it is also the conflict target of apply_write_ops upsert_wishlist_for_slot. Partial on purpose: a slot keeps every resolved row as history.';

create or replace function apply_write_ops(payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  op  jsonb;   -- the current operation
  p   jsonb;   -- an update op's partial patch (present keys are set; absent keys are left as-is)
  gid uuid;    -- a presence group whose desired_count is recomputed after all ops
  ids text[];  -- an op's catalog-id list, materialised once so the UPDATE stays one statement
begin
  for op in select value from jsonb_array_elements(coalesce(payload -> 'ops', '[]'::jsonb))
  loop
    case op ->> 'op'

      -- ---- inserts (owner_id omitted everywhere → defaults to auth.uid(); RLS with-check enforces) --
      when 'insert_haul' then
        insert into haul (id, source, notes)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          op ->> 'source',
          op ->> 'notes'
        );

      when 'insert_copy' then
        insert into copy (
          id, catalog_card_id, variant, dex_variant_raw, presence_group_id,
          haul_id, acquired_at, role, binder_id, binder_half, color_band, line_slot_id, created_at
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          op ->> 'catalog_card_id',
          coalesce(op ->> 'variant', 'normal'),
          op ->> 'dex_variant_raw',
          (op ->> 'presence_group_id')::uuid,
          (op ->> 'haul_id')::uuid,
          (op ->> 'acquired_at')::timestamptz,
          coalesce(op ->> 'role', 'shelved'),
          (op ->> 'binder_id')::uuid,
          op ->> 'binder_half',
          op ->> 'color_band',
          (op ->> 'line_slot_id')::uuid,
          coalesce((op ->> 'created_at')::timestamptz, now())
        );

      when 'insert_line' then
        insert into evolution_line (id, root_dex_id, color_band, binder_id, half, status)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'root_dex_id')::integer,
          op ->> 'color_band',
          (op ->> 'binder_id')::uuid,
          coalesce(op ->> 'half', 'back'),
          coalesce(op ->> 'status', 'open')
        );

      when 'insert_slot' then
        insert into line_slot (id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id, note)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'line_id')::uuid,
          (op ->> 'stage_index')::integer,
          op ->> 'stage',
          op ->> 'state',
          (op ->> 'copy_id')::uuid,
          op ->> 'target_catalog_card_id',
          op ->> 'note'
        );

      when 'insert_wishlist' then
        insert into wishlist_item (
          id, line_slot_id, required_dex_id, required_type, required_stage,
          chosen_catalog_card_id, alternate_catalog_card_ids, will_live_in_specialty, held_for_binder_id
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'line_slot_id')::uuid,
          (op ->> 'required_dex_id')::integer,
          op ->> 'required_type',
          op ->> 'required_stage',
          op ->> 'chosen_catalog_card_id',
          coalesce(
            (select array_agg(x) from jsonb_array_elements_text(op -> 'alternate_catalog_card_ids') as t(x)),
            '{}'::text[]
          ),
          coalesce((op ->> 'will_live_in_specialty')::boolean, false),
          (op ->> 'held_for_binder_id')::uuid
        );

      -- MODIFIED in 0021 — `line_id` and `line_slot_id` (UIL-095). Both columns exist since 0013 and
      -- `applyDecision` has always written them through `placementDecisionRepo.insert`, but this op could
      -- not carry them, so moving that write inside the transaction would have silently dropped them from
      -- the audit trail. They are traceability only (UIL-078: nothing reads them back to decide behaviour),
      -- and losing them is exactly the kind of quiet erosion UIL-094 exists to stop. Absent keys read as
      -- NULL, so every existing caller is unchanged.
      when 'insert_decision' then
        insert into placement_decision (
          id, haul_id, copy_id, decision, reason, resolved_by, line_id, line_slot_id
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'haul_id')::uuid,
          (op ->> 'copy_id')::uuid,
          op ->> 'decision',
          op ->> 'reason',
          op ->> 'resolved_by',
          (op ->> 'line_id')::uuid,
          (op ->> 'line_slot_id')::uuid
        );

      when 'insert_presence_group' then
        insert into presence_group (id, catalog_card_id, dex_variant_raw, desired_count)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          op ->> 'catalog_card_id',
          op ->> 'dex_variant_raw',
          coalesce((op ->> 'desired_count')::integer, 0)
        );

      -- NEW in 0007 — a physically reserved pocket run recorded by backfill (basic energy, or a
      -- repurposed duplicate, in which case copy_id points at the copy that was sacrificed).
      when 'insert_binder_block' then
        insert into binder_block (
          id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, created_at
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'binder_id')::uuid,
          op ->> 'half',
          coalesce((op ->> 'pocket_count')::integer, 1),
          coalesce(op ->> 'purpose', 'line-terminated'),
          coalesce(op ->> 'material', 'basicEnergy'),
          (op ->> 'copy_id')::uuid,
          (op ->> 'line_id')::uuid,
          coalesce((op ->> 'created_at')::timestamptz, now())
        );

      when 'insert_unresolved_entry' then
        insert into unresolved_entry (
          id, dex_id, dex_set_name, dex_series, dex_number, dex_name, dex_variant_raw,
          quantity, locale, reason, status, first_seen_sync, last_retry_sync, retry_count, manual_match_id
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          op ->> 'dex_id',
          op ->> 'dex_set_name',
          op ->> 'dex_series',
          op ->> 'dex_number',
          op ->> 'dex_name',
          coalesce(op ->> 'dex_variant_raw', ''),
          coalesce((op ->> 'quantity')::integer, 1),
          op ->> 'locale',
          op ->> 'reason',
          coalesce(op ->> 'status', 'WAITING'),
          coalesce((op ->> 'first_seen_sync')::timestamptz, now()),
          (op ->> 'last_retry_sync')::timestamptz,
          coalesce((op ->> 'retry_count')::integer, 0),
          op ->> 'manual_match_id'
        );

      when 'insert_snapshot' then
        insert into last_sync_snapshot (id, snapshot)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          op -> 'snapshot'
        );

      when 'upsert_set_alias' then
        insert into set_alias (locale, dex_code, tcgdex_set_id, source)
        values (
          op ->> 'locale',
          op ->> 'dex_code',
          op ->> 'tcgdex_set_id',
          coalesce(op ->> 'source', 'manual')
        )
        on conflict (locale, dex_code)
        do update set tcgdex_set_id = excluded.tcgdex_set_id, source = excluded.source;

      -- ---- partial updates: `p ? 'col'` (key present) sets it (even to null); absent leaves it be --
      when 'update_copy' then
        p := op -> 'patch';
        update copy set
          variant           = case when p ? 'variant'           then p ->> 'variant'                     else variant end,
          dex_variant_raw   = case when p ? 'dex_variant_raw'   then p ->> 'dex_variant_raw'             else dex_variant_raw end,
          presence_group_id = case when p ? 'presence_group_id' then (p ->> 'presence_group_id')::uuid   else presence_group_id end,
          role              = case when p ? 'role'              then p ->> 'role'                        else role end,
          binder_id         = case when p ? 'binder_id'         then (p ->> 'binder_id')::uuid           else binder_id end,
          binder_half       = case when p ? 'binder_half'       then p ->> 'binder_half'                 else binder_half end,
          color_band        = case when p ? 'color_band'        then p ->> 'color_band'                  else color_band end,
          line_slot_id      = case when p ? 'line_slot_id'      then (p ->> 'line_slot_id')::uuid        else line_slot_id end
        where id = (op ->> 'id')::uuid;

      when 'update_slot' then
        p := op -> 'patch';
        update line_slot set
          state                  = case when p ? 'state'                  then p ->> 'state'                    else state end,
          copy_id                = case when p ? 'copy_id'                then (p ->> 'copy_id')::uuid          else copy_id end,
          target_catalog_card_id = case when p ? 'target_catalog_card_id' then p ->> 'target_catalog_card_id'   else target_catalog_card_id end,
          note                   = case when p ? 'note'                   then p ->> 'note'                     else note end,
          -- NEW in 0013 — UIL-078's "she already answered this" marker, so `releaseSlotOps` can clear it
          -- in the SAME transaction that vacates the slot (see this file's header). Same partial-patch
          -- semantics as every column above: key present sets it (null included), key absent leaves it.
          resolved_decision_kind          = case when p ? 'resolved_decision_kind'          then p ->> 'resolved_decision_kind'                  else resolved_decision_kind end,
          resolved_decision_choice        = case when p ? 'resolved_decision_choice'        then p ->> 'resolved_decision_choice'                else resolved_decision_choice end,
          resolved_decision_collection_id = case when p ? 'resolved_decision_collection_id' then (p ->> 'resolved_decision_collection_id')::uuid else resolved_decision_collection_id end
        where id = (op ->> 'id')::uuid;

      when 'update_unresolved_entry' then
        p := op -> 'patch';
        update unresolved_entry set
          status          = case when p ? 'status'          then p ->> 'status'                    else status end,
          quantity        = case when p ? 'quantity'        then (p ->> 'quantity')::integer        else quantity end,
          retry_count     = case when p ? 'retry_count'     then (p ->> 'retry_count')::integer     else retry_count end,
          last_retry_sync = case when p ? 'last_retry_sync' then (p ->> 'last_retry_sync')::timestamptz else last_retry_sync end,
          reason          = case when p ? 'reason'          then p ->> 'reason'                     else reason end,
          manual_match_id = case when p ? 'manual_match_id' then p ->> 'manual_match_id'            else manual_match_id end
        where id = (op ->> 'id')::uuid;

      -- NEW in 0007 — union catalog ids into a collection's curated target list (specialty backfill
      -- tagging). ONE statement, and the new value is derived from the column itself: Postgres
      -- re-evaluates the SET expression against the row this statement locks, so two interleaved
      -- taggings compose instead of clobbering (the lost-update the old TS read-modify-write had).
      -- `distinct on` keeps the FIRST occurrence of each id and `order by ord` restores insertion
      -- order, so existing membership order is preserved and re-tagging a card is a no-op.
      -- A collection that does not exist (or is not the caller's, per RLS `using`) matches no row and
      -- is silently skipped — the same behaviour as the old executor's `if (!coll) continue`.
      when 'union_collection_targets' then
        update collection set target_catalog_card_ids = coalesce(
          (
            select array_agg(d.cid order by d.ord)
            from (
              select distinct on (u.cid) u.cid, u.ord
              from unnest(
                     collection.target_catalog_card_ids
                     || coalesce(
                          (select array_agg(x)
                             from jsonb_array_elements_text(op -> 'catalog_card_ids') as t(x)),
                          '{}'::text[]
                        )
                   ) with ordinality as u(cid, ord)
              order by u.cid, u.ord
            ) d
          ),
          '{}'::text[]
        )
        where id = (op ->> 'collection_id')::uuid;

      -- ---- deletes (FK on delete set null frees any referencing slots / wishlist / blocks) ----------
      when 'delete_copy' then
        delete from copy where id = (op ->> 'id')::uuid;

      when 'delete_unresolved_entry' then
        delete from unresolved_entry where id = (op ->> 'id')::uuid;

      when 'delete_snapshot' then
        delete from last_sync_snapshot where id = (op ->> 'id')::uuid;

      -- NEW in 0008 — the inverse of `union_collection_targets`: drop catalog ids OUT of a
      -- collection's curated list. Needed by the collection-removal path (UIL-014), which must
      -- rewrite a copy's placement AND drop it from the chase list in ONE transaction — a half-apply
      -- is exactly the orphaned-copy state this fix exists to make impossible.
      -- Same single-statement, column-derived shape as the union so it is atomic and cannot lose a
      -- concurrent edit; `with ordinality` + `order by ord` preserves the surviving membership order,
      -- and removing an id that is not present is a no-op (idempotent).
      when 'subtract_collection_targets' then
        ids := coalesce(
          (select array_agg(x) from jsonb_array_elements_text(op -> 'catalog_card_ids') as t(x)),
          '{}'::text[]
        );
        update collection set target_catalog_card_ids = coalesce(
          (
            select array_agg(u.cid order by u.ord)
            from unnest(collection.target_catalog_card_ids) with ordinality as u(cid, ord)
            where not (u.cid = any (ids))
          ),
          '{}'::text[]
        )
        where id = (op ->> 'collection_id')::uuid;

      -- NEW in 0008 — patch an evolution line's status. The move/removal path demotes a `complete`
      -- line back to `open` when the copy that filled its last slot leaves (removal symmetry,
      -- sync-architecture §1.6). 0006/0007 could set a line's status only at insert time, so a
      -- removal routed through the RPC had no way to keep that invariant inside the transaction.
      when 'update_line' then
        p := op -> 'patch';
        update evolution_line set
          status = case when p ? 'status' then p ->> 'status' else status end
        where id = (op ->> 'id')::uuid;

      -- NEW in 0014 — forget a learned set alias (UIL-047 C3, second half). Keyed on the primary key;
      -- a key that matches no row is a silent no-op, like `delete_copy`. Emitted by lib/sync/exec.ts
      -- `forgetSetAlias` together with the `update_unresolved_entry` re-classifications of that set's
      -- WAITING entries (see the header), so the two land in one transaction.
      when 'delete_set_alias' then
        delete from set_alias
        where locale = (op ->> 'locale') and dex_code = (op ->> 'dex_code');

      -- NEW in 0015 — a USER-CREATED STAND-IN catalog card (UIL-060 Half 1). The card TCGdex lacks gets a
      -- row of her own so it can be matched, shelved and placed today; `source = 'user'` and the `user:`
      -- id namespace mark it for Half 2's swap. Emitted by lib/sync/exec.ts `manualMatchStandIn` as the
      -- FIRST op of the same transaction that pins the entry to it and creates its copies, so a stand-in
      -- never exists without its match. Runs under 0015's `catalog_card_user_insert` policy (security
      -- invoker), which only admits `source = 'user'` rows in the `user:` namespace — the shared TCGdex
      -- catalog stays untouchable from the app.
      when 'insert_catalog_stand_in' then
        insert into catalog_card (
          tcgdex_id, name, set_id, set_name, local_id, dex_id, types, stage, card_class, image_url, source
        )
        values (
          op ->> 'tcgdex_id',
          op ->> 'name',
          op ->> 'set_id',
          op ->> 'set_name',
          op ->> 'local_id',
          coalesce(
            (select array_agg(x::integer) from jsonb_array_elements_text(coalesce(op -> 'dex_id', '[]'::jsonb)) as t(x)),
            '{}'::integer[]
          ),
          coalesce(
            (select array_agg(x) from jsonb_array_elements_text(coalesce(op -> 'types', '[]'::jsonb)) as t(x)),
            '{}'::text[]
          ),
          op ->> 'stage',
          coalesce(op ->> 'card_class', 'standard'),
          null,
          'user'
        );

      -- NEW in 0017 — SET a collection's binder list (UIL-040 step 2). Emitted by lib/coll/rebind.ts
      -- AFTER the `update_copy` ops that carry the collection's shelved copies into the new binder, so
      -- the copies and the collection change binder in the same transaction. A collection that does not
      -- exist (or is not the caller's, per RLS `using`) matches no row and is silently skipped — the
      -- same behaviour as `union_collection_targets` / `subtract_collection_targets`. The 0012
      -- `collection_touch` trigger fires on this update like any other, so `updated_at` moves.
      when 'set_collection_binders' then
        update collection set current_binder_ids = coalesce(
          (
            select array_agg(t.x::uuid order by t.ord)
            from jsonb_array_elements_text(op -> 'binder_ids') with ordinality as t(x, ord)
          ),
          '{}'::uuid[]
        )
        where id = (op ->> 'collection_id')::uuid;

      -- NEW in 0020 — REMEMBER that she removed a Dex-backed copy (UIL-089). Emitted by
      -- lib/copy/remove.ts in the SAME transaction as the `delete_copy` it describes, so the collection
      -- and the memory of what left it can never disagree.
      --
      -- The new value is computed FROM THE COLUMN, never read-modify-written in TypeScript: two removals
      -- of the same printing racing each other would otherwise lose one, which is exactly the fault 0007
      -- fixed in `union_collection_targets`. `count` carries the `check (count > 0)`, so a delta that
      -- would take it to zero or below is the caller's bug and fails the whole transaction loudly rather
      -- than leaving a meaningless row.
      when 'remember_removed_presence' then
        insert into removed_presence (catalog_card_id, dex_variant_raw, count)
        values (
          op ->> 'catalog_card_id',
          op ->> 'dex_variant_raw',
          coalesce((op ->> 'delta')::integer, 1)
        )
        on conflict (owner_id, catalog_card_id, dex_variant_raw) do update
          set count = removed_presence.count + excluded.count,
              updated_at = now();

      -- NEW in 0020 — FORGET a memory whose key Dex no longer lists (UIL-089). Emitted by the import in
      -- its own transaction: once the export stops naming the card, the disagreement this row recorded is
      -- over, and keeping it would suppress a genuine re-acquisition forever.
      when 'forget_removed_presence' then
        delete from removed_presence
        where catalog_card_id = op ->> 'catalog_card_id'
          and dex_variant_raw = op ->> 'dex_variant_raw';

      -- NEW in 0021 — MARK a slot's open wishlist row resolved (UIL-095). Emitted by lib/line/write.ts
      -- in the same transaction as the slot and line patches the same decision implies.
      --
      -- Keyed on the SLOT, not on a wishlist row id: TypeScript used to read the whole table to find the
      -- open row first, so the statement it chose depended on a snapshot taken before the write. A slot
      -- with no open row is a silent no-op, the contract `delete_copy` and the target-list ops follow, and
      -- running it twice is idempotent because the second pass matches nothing.
      when 'resolve_wishlist_for_slot' then
        update wishlist_item
          set resolved_at = now()
          where line_slot_id = (op ->> 'line_slot_id')::uuid
            and resolved_at is null;

      -- NEW in 0021 — CREATE or REFRESH a slot's open wishlist row (UIL-095). One statement, conflicting on
      -- the partial unique index this migration adds, so "update the open row, else insert" is decided by
      -- the row Postgres locks rather than by a read TypeScript took earlier.
      --
      -- A RESOLVED row does not participate in the conflict (the index is `where resolved_at is null`), so a
      -- new open row is inserted beside it and the history of what she was chasing is kept. `owner_id` is
      -- omitted, so it defaults to `auth.uid()` and forms part of the conflict target.
      when 'upsert_wishlist_for_slot' then
        insert into wishlist_item (
          line_slot_id, required_dex_id, required_type, required_stage,
          chosen_catalog_card_id, alternate_catalog_card_ids, will_live_in_specialty, held_for_binder_id
        )
        values (
          (op ->> 'line_slot_id')::uuid,
          (op ->> 'required_dex_id')::integer,
          op ->> 'required_type',
          op ->> 'required_stage',
          op ->> 'chosen_catalog_card_id',
          coalesce(
            (
              select array_agg(t.x order by t.ord)
              from jsonb_array_elements_text(op -> 'alternate_catalog_card_ids') with ordinality as t(x, ord)
            ),
            '{}'::text[]
          ),
          coalesce((op ->> 'will_live_in_specialty')::boolean, false),
          (op ->> 'held_for_binder_id')::uuid
        )
        -- A refresh OVERWRITES only what the caller decides, and KEEPS what it does not. Three writers make
        -- these rows: this op (a line decision), the Haul Plan's commit and Backfill. The decision path
        -- decides the chosen card, its alternates and whether it lives in the specialty binder, so those are
        -- overwritten. It does not decide `held_for_binder_id` — it always sends null — and a plain
        -- `= excluded` there wiped the binder the Haul Plan or Backfill had set (QA's finding on #323). The
        -- three `required_*` columns describe the SLOT, not the decision; a null from the caller means
        -- "not known here", never "clear it", and wiping `required_dex_id` would stop Lookup reading the card
        -- as wished (it matches an open row on species). So those four keep the stored value unless the
        -- caller supplies one.
        on conflict (owner_id, line_slot_id) where resolved_at is null do update
          set required_dex_id = coalesce(excluded.required_dex_id, wishlist_item.required_dex_id),
              required_type = coalesce(excluded.required_type, wishlist_item.required_type),
              required_stage = coalesce(excluded.required_stage, wishlist_item.required_stage),
              chosen_catalog_card_id = excluded.chosen_catalog_card_id,
              alternate_catalog_card_ids = excluded.alternate_catalog_card_ids,
              will_live_in_specialty = excluded.will_live_in_specialty,
              held_for_binder_id = coalesce(excluded.held_for_binder_id, wishlist_item.held_for_binder_id);

      else
        raise exception 'apply_write_ops: unknown op %', op ->> 'op';
    end case;
  end loop;

  -- Recompute desired_count for every touched presence group AFTER all copy writes so it reflects the
  -- post-apply live copy count (replaces exec.ts resyncGroupCount — now authoritative and atomic).
  for gid in
    select value::uuid from jsonb_array_elements_text(coalesce(payload -> 'resync_group_ids', '[]'::jsonb))
  loop
    update presence_group
      set desired_count = (select count(*) from copy where copy.presence_group_id = gid)
      where id = gid;
  end loop;
end;
$$;

-- Only the authenticated owner (and the service role) may drive a commit; anon must not.
-- (Restated from 0006/0007/0008: `create or replace` keeps the existing ACL, so this is a no-op re-assert.)
revoke all on function apply_write_ops(jsonb) from public;
grant execute on function apply_write_ops(jsonb) to authenticated, service_role;
