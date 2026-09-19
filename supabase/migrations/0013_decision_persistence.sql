-- 0013_decision_persistence — a resolved line decision must stay resolved, and its audit row must
-- name the slot it was about (UIL-078).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0012 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- COMPOSED FUNCTION, READ WITH ITS NEIGHBOURS. This file REPLACES `apply_write_ops` (0008's body plus
-- three patch keys in `update_slot`, nothing else). 0014_forget_set_alias, which lands after it,
-- replaces the function AGAIN and is built on THIS body plus its own `delete_set_alias` branch. Neither
-- file is the whole function on its own; the one that runs last is. Gate the composed result.
--
-- WHY TWO SEPARATE CHANGES, NOT ONE. `deriveDecisions` (lib/line/decisions.ts) re-derives every
-- outstanding decision from CURRENT state on every load — no persisted row remembers she already
-- answered one. For every "confirm the recommendation" choice, the write that resolves a decision
-- does not change the condition its own trigger checks (state stays `placeholder`/`block`, a claimed
-- collection stays claimed), so the identical decision re-derives on the next load, forever. Karvi's
-- report: "line decisions do not stick."
--
-- The obvious fix — have the loader check `placement_decision` for a prior resolution — was considered
-- and rejected: UIL-042 (open in this log) already made that table load-bearing for QUEUE state, and
-- Karvi was burned once when clearing those rows silently re-queued her entire collection. The standing
-- rule since is that `placement_decision` is never cleared and never read back to decide behaviour.
-- Making it load-bearing for a SECOND kind of state — whether to re-ask a decision — would mean anyone
-- pruning or archiving audit history silently makes the app start re-asking her everything. So:
--
--   1. line_slot.resolved_decision_kind / resolved_decision_choice / resolved_decision_collection_id —
--      the BEHAVIOURAL marker, on the thing the decision is about. State lives in state; audit history
--      can be pruned, replayed or archived without ever changing what she gets asked. All nullable: most
--      slots have never had a decision to resolve. Kind AND choice, not a bare boolean — a boolean would
--      suppress a question that has genuinely become a different one (a materially changed situation
--      must still ask); kind lets the loader recognise "this exact question" specifically, and choice is
--      stored alongside it for the same precision even though the loader's suppression check only needs
--      kind. NOT written for `leave-it` (resurfaces by design) or for a choice that hands off to a
--      different decision (`block-instead`, `no-line`, `make-line-anyway` — those move the slot/line into
--      a shape a DIFFERENT trigger matches, which is a fresh question, not the same one answered twice).
--
--      resolved_decision_collection_id exists because kind alone is NOT "this exact question" for
--      `collection-vs-line`: "collection wins" is an answer about ONE collection's claim. The loader
--      suppresses only while the collection(s) claiming the species are the one recorded here; a
--      different collection claiming the same card afterwards is a new question and is asked. NULL for
--      every other kind. FK to `collection` with `on delete set null`, so deleting the collection she
--      answered for dissolves the answer with it (there is then no claim left to have answered).
--
--      And the marker must not outlive the SLOT'S situation either: a slot she resolved a cap on, later
--      filled by a card, then vacated again, is a new situation. So `releaseSlotOps` (lib/line/move.ts —
--      the ONE path every slot release goes through: the Line move, the Haul Plan pull, the Haul Plan
--      override) nulls all three columns in the same `update_slot` op that reopens the slot. That op runs
--      inside `apply_write_ops`, whose `update_slot` branch (0008) patched only state / copy_id /
--      target_catalog_card_id / note — hence the function replacement below: 0008's body verbatim plus
--      those three keys, with 0008's partial-patch semantics (key present sets, even to null; absent
--      leaves alone). No other branch changes; no pure logic moves into SQL.
--
--   2. placement_decision.line_id / line_slot_id — pure traceability, fixing a separate defect found
--      while tracing this one: today a line decision's audit row cannot be traced back to the slot it
--      was about at all, only informally through the `reason` text. `applyDecision` already has both
--      ids in hand at write time. Nothing reads these columns back to decide behaviour — that is
--      exactly the mistake (1) avoids repeating.
--
-- SECURITY properties of the replaced function are preserved EXACTLY as 0006/0007/0008 declared them:
-- `security invoker` (0002's `owner_all` RLS governs every write), `set search_path = public, pg_temp`,
-- `owner_id` never read from the payload, NO dynamic SQL (every table and column name is a literal
-- chosen by a fixed `case`), and an unknown op raises so a typo fails the whole transaction rather than
-- silently writing less. `create or replace function` preserves the object's existing privileges; the
-- grants are restated at the bottom anyway so this file is self-sufficient (and idempotent).

alter table line_slot
  add column resolved_decision_kind text,
  add column resolved_decision_choice text,
  add column resolved_decision_collection_id uuid references collection (id) on delete set null;

alter table placement_decision
  add column line_id uuid references evolution_line (id) on delete set null,
  add column line_slot_id uuid references line_slot (id) on delete set null;

comment on column line_slot.resolved_decision_kind is
  'The DecisionCard.kind she last resolved for this slot (e.g. "ex-only-cap", "collection-vs-line"), when the choice was one that should stop deriveDecisions from re-asking it (UIL-078). NULL if never resolved, if the last choice was a hand-off/leave-it, or since the slot was last vacated (releaseSlotOps clears it). Never cleared by audit-history maintenance — see placement_decision.line_slot_id for why this lives here and not there.';
comment on column line_slot.resolved_decision_choice is
  'The DecisionChoiceId she picked alongside resolved_decision_kind — stored for precision/audit even though suppression only checks the kind. NULL under the same conditions as resolved_decision_kind.';
comment on column line_slot.resolved_decision_collection_id is
  'For a resolved collection-vs-line: the collection whose claim she answered (UIL-078). The loader suppresses the decision only while this is the collection claiming the species; another collection''s claim is a new question. NULL for every other kind and under the same conditions as resolved_decision_kind.';
comment on column placement_decision.line_id is
  'The line a line-screen decision was about, for traceability only (UIL-078). Never read back to decide behaviour — see line_slot.resolved_decision_kind for where that lives, and UIL-042 for why it does not live here.';
comment on column placement_decision.line_slot_id is
  'The slot a line-screen decision was about, for traceability only (UIL-078). Same rule as line_id: audit only, never load-bearing.';

-- ---------------------------------------------------------------------------------------------------
-- apply_write_ops: 0008's body verbatim + three `update_slot` patch keys (see header). Superseded by
-- 0014, which is built on THIS body.
-- ---------------------------------------------------------------------------------------------------

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

      when 'insert_decision' then
        insert into placement_decision (id, haul_id, copy_id, decision, reason, resolved_by)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'haul_id')::uuid,
          (op ->> 'copy_id')::uuid,
          op ->> 'decision',
          op ->> 'reason',
          op ->> 'resolved_by'
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
