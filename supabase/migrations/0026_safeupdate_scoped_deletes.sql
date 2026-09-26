-- 0026_safeupdate_scoped_deletes — the record's two whole-record deletes name the owner (P0, 2026-09-26).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0025 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- THE FAILURE. Her import on Testing failed with "DELETE requires a WHERE clause" (SQLSTATE 21000). Supabase
-- loads pg_safeupdate for PostgREST sessions, and it refuses any DELETE or UPDATE without a WHERE clause, even
-- inside a function and even on a table RLS already scopes. It checks the statement as written, before RLS
-- adds its filter. 0022 wrote three such deletes into `apply_write_ops`, and 0024 kept them:
-- `replace_dex_record`'s `delete from dex_presence`, and `clear_dex_record`'s `delete from dex_presence` and
-- `delete from dex_import`. Every import runs `replace_dex_record`, so no import could be saved. It shipped
-- green because the PGlite test harness does not load pg_safeupdate, and #333's E352 (fixed in #357) kept
-- every action from reaching the database in the meantime.
--
-- THE FIX. Each of the three now says `where owner_id = auth.uid()`. That is the rows it always meant: RLS
-- already limited it to the caller's rows, and the `current_user = 'authenticated'` guard in front of each
-- ensures there is a signed-in owner to name. The predicate states that intent, rather than an always-true
-- filter that would only quiet pg_safeupdate. It also keeps the delete owner-scoped if RLS on these tables
-- were ever loosened.
--
-- `auth.uid()` IN THE BODY, the first since 0006. 0006–0025 declared "no `auth.uid()` in the body" because
-- the PGlite harness never granted `authenticated` usage on schema `auth`, which Supabase does. That grant is
-- what lets every RLS policy call `auth.uid()` as `authenticated`. The harness now replicates it
-- (tests/support/pglite-rpc.ts). The claim is also proven on real Postgres: the Database Engineer runs each
-- branch on Testing as `authenticated`, with pg_safeupdate loaded, inside BEGIN … ROLLBACK.
--
-- Expected row effect: NONE. No table changes and no data written; three statements gain a WHERE clause.
--
-- COMPOSED FUNCTION, READ WITH ITS NEIGHBOURS. 0025 did not touch `apply_write_ops`, so 0024's body is the one
-- that runs before this file. This file replaces it with 0024's body VERBATIM except for those three
-- statements and the comment above them. tests/db/safeupdate-scoped-deletes.test.ts asserts exactly that.
-- tests/db/no-unscoped-writes.test.ts refuses any DELETE or UPDATE without WHERE in the live body of any
-- function the migrations define.
--
-- SECURITY properties are otherwise preserved exactly as 0006–0024 declared them: `security invoker`,
-- `set search_path = public, pg_temp`, no dynamic SQL, and an unknown op still raises.

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

      -- NEW in 0022 (UIL-100) — what the Dex file said, so the collection can be checked against it.
      -- The record is Dex's RAW quantity per (card, Dex variant), BEFORE removals: removals are subtracted
      -- when checking, exactly as lib/sync/diff.ts `applyRemovedMemory` subtracts them for an import.
      -- OWNER SCOPE IS RLS, as in every other branch (`security invoker` + 0002's `owner_all` shape): each
      -- statement below sees and touches only the caller's rows. The two branches that DELETE a whole record
      -- also name the owner (`where owner_id = auth.uid()`, 0026): Supabase's pg_safeupdate refuses a DELETE
      -- with no WHERE clause, and RLS does not count as one. They still refuse to run as anything but the
      -- signed-in owner, because the service role bypasses RLS and has no `auth.uid()` to scope by.

      -- A full import REPLACES the record with the file's resolved map and writes the file-level header.
      when 'replace_dex_record' then
        if current_user <> 'authenticated' then
          raise exception 'apply_write_ops: replace_dex_record runs only as the signed-in owner, not %', current_user;
        end if;
        delete from dex_presence where owner_id = auth.uid();
        insert into dex_presence (catalog_card_id, dex_variant_raw, quantity)
          select r ->> 'catalog_card_id', r ->> 'dex_variant_raw', (r ->> 'quantity')::int
            from jsonb_array_elements(coalesce(op -> 'rows', '[]'::jsonb)) r
           where (r ->> 'quantity')::int > 0;
        insert into dex_import (file_total, row_count, imported_at)
          values ((op ->> 'file_total')::int, (op ->> 'row_count')::int,
                  coalesce((op ->> 'imported_at')::timestamptz, now()))
          on conflict (owner_id) do update
            set file_total = excluded.file_total,
                row_count = excluded.row_count,
                imported_at = excluded.imported_at;

      -- Undo of the FIRST recorded import: there was no record before it, so there is none after.
      when 'clear_dex_record' then
        if current_user <> 'authenticated' then
          raise exception 'apply_write_ops: clear_dex_record runs only as the signed-in owner, not %', current_user;
        end if;
        delete from dex_presence where owner_id = auth.uid();
        delete from dex_import where owner_id = auth.uid();

      -- A Retry promotion or a manual match moves a Dex row from "waiting" into the record. The file-level
      -- total does not change: that row was already counted, as a waiting entry. Only once an import has
      -- recorded a file: before that there is no record to add to, and the next import writes it whole.
      when 'add_dex_presence' then
        if (op ->> 'quantity')::int > 0 and exists (select 1 from dex_import) then
          insert into dex_presence (catalog_card_id, dex_variant_raw, quantity)
            values (op ->> 'catalog_card_id', op ->> 'dex_variant_raw', (op ->> 'quantity')::int)
            on conflict (owner_id, catalog_card_id, dex_variant_raw) do update
              set quantity = dex_presence.quantity + excluded.quantity,
                  updated_at = now();
        end if;

      -- Take back part of a removal memory, computed from the column like 0020's increment (UIL-100; asked
      -- for by UIL-099 E2's "add it back"). `remember_removed_presence` cannot do this with a negative delta:
      -- Postgres checks `count > 0` on the INSERT's candidate row before ON CONFLICT merges it, so delta -1
      -- fails even against a row holding 3. Shrinking to zero or below deletes the memory: one
      -- representation of "none", as 0020 decided. A key with no memory is a silent no-op.
      when 'shrink_removed_presence' then
        update removed_presence
           set count = count - (op ->> 'by')::int, updated_at = now()
         where catalog_card_id = op ->> 'catalog_card_id'
           and dex_variant_raw = op ->> 'dex_variant_raw'
           and count > (op ->> 'by')::int;
        delete from removed_presence
         where catalog_card_id = op ->> 'catalog_card_id'
           and dex_variant_raw = op ->> 'dex_variant_raw'
           and count <= (op ->> 'by')::int;

      -- THE CHECK. Emitted LAST by every sync writer (import, Retry, manual match, stand-in, Undo, the
      -- remove-copy memory write) — never by placement, moves or collection edits. For each key named
      -- (or every key she has, with `all`), the copies in its presence group must equal
      -- max(0, dex - removed). Any key that does not raises, naming the keys in DETAIL as JSON, and the
      -- whole transaction rolls back: a count that disagrees with Dex is never committed.
      -- Before her first recorded import there is no header and nothing to check against, so it passes.
      when 'assert_presence_counts' then
        if exists (select 1 from dex_import) then
          declare
            want_all boolean := coalesce((op ->> 'all')::boolean, false);
            bad      jsonb;
            n_bad    integer;
          begin
            with k as (
              select x ->> 'catalog_card_id' as card, x ->> 'dex_variant_raw' as var
                from jsonb_array_elements(coalesce(op -> 'keys', '[]'::jsonb)) x
              union
              select catalog_card_id, dex_variant_raw from dex_presence where want_all
              union
              select catalog_card_id, dex_variant_raw from presence_group where want_all
              union
              select catalog_card_id, dex_variant_raw from removed_presence where want_all
            ), c as (
              select k.card, k.var,
                     coalesce((select d.quantity from dex_presence d
                                where d.catalog_card_id = k.card and d.dex_variant_raw = k.var), 0) as dex,
                     coalesce((select r.count from removed_presence r
                                where r.catalog_card_id = k.card and r.dex_variant_raw = k.var), 0) as removed,
                     (select count(*) from copy cp
                        join presence_group g on g.id = cp.presence_group_id
                       where g.catalog_card_id = k.card and g.dex_variant_raw = k.var)::int as have
                from k
            ), m as (
              select * from c where have <> greatest(0, dex - removed)
            )
            select (select count(*) from m),
                   (select coalesce(jsonb_agg(jsonb_build_object(
                             'catalog_card_id', card, 'dex_variant_raw', var,
                             'dex', dex, 'removed', removed, 'have', have)
                           order by card, var), '[]'::jsonb)
                      from (select * from m order by card, var limit 50) first50)
              into n_bad, bad;
            if n_bad > 0 then
              raise exception using
                errcode = 'P0001',
                message = format('apply_write_ops: presence count check failed on %s key(s) (UIL-100)', n_bad),
                detail = bad::text;
            end if;
          end;
        end if;

      -- NEW in 0024 (UIL-100 hardening) — THE FILE TOTAL. Every Dex quantity lives in exactly one place:
      -- the record (a row an import resolved, or one she matched) or the queue (a WAITING or DISMISSED
      -- entry). So file_total = sum(record) + sum(waiting) + sum(dismissed) must hold after every write that
      -- is not an import (an import rewrites both sides at once). `assert_presence_counts` checks each card
      -- against the record, so a write that adds the SAME amount to both the record and the copies is
      -- invisible to it — the second press of Match was exactly that. This catches it: the record grew and
      -- nothing left the queue. No header yet (no import recorded since 0022): nothing to check, it passes.
      -- Owner scope is RLS, as in every other branch.
      when 'assert_file_total' then
        declare
          ft     integer;
          rec    integer;
          queued integer;
        begin
          select file_total into ft from dex_import;
          if ft is not null then
            select coalesce(sum(quantity), 0) into rec from dex_presence;
            select coalesce(sum(greatest(quantity, 0)), 0) into queued
              from unresolved_entry where status in ('WAITING', 'DISMISSED');
            if ft <> rec + queued then
              raise exception using
                errcode = 'P0001',
                message = 'apply_write_ops: file total check failed (UIL-100)',
                detail = json_build_object('file_total', ft, 'record', rec, 'queued', queued)::text;
            end if;
          end if;
        end;

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
