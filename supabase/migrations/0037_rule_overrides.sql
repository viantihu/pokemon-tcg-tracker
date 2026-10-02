-- 0037_rule_overrides — her rules are recommendations: she can override every one of them, and an override is
-- recorded with the move.
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0036 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- KARVI'S RULING (2026-10-01/02): "The rules should exist only for the recommendation engine. Users should always be
-- able to override all rules." The app recommends, warns in her words, and lets her do it anyway.
--
-- THE KEYS. `overrides` is a closed set, one key per family of rule:
--   line_fit          species, stage, branch, trainer, region or language fit. No database rule today: validated and
--                     recorded only.
--   line_min_stages   a line with a single stage (0032's "a line needs at least two stages" in assert_line_slots).
--   bulk_box_full     a card into a full box (the copy trigger, 0035/0036), and a deleted box's cards into a box
--                     without room for them (delete_bulk_unit, 0036).
--   line_completion   the third pocket and the "Decide every stage" prompts. No database rule: validated and recorded
--                     only.
--   collection_pick   a specialty card shelved with no collection. No database rule: validated and recorded only.
-- A write names the keys it overrides in the payload's top-level `overrides` (a list; absent = none), and records each
-- of them on an `insert_decision` in the same write, or it is refused whole. Nothing is overridden silently.
--
-- WHAT STAYS HARD, AND WHY. Integrity has NO key, so it cannot be named, so it cannot be overridden: one physical
-- copy in one place; one copy per pocket (0034's binder_block_one_per_copy, and a filler fills one pocket); a slot
-- and its copy pointing at each other (assert_line_slots' pointer checks); a row is hers (the owner checks); her
-- collection agrees with Dex (the count and file-total checks); her last bulk box, and a deleted box's cards always
-- having another of her boxes to go to (delete_bulk_unit's move_to). Inside assert_line_slots only the two-stage rule
-- relaxes. The rest of it is physical, or a record of what she decided: a third-pocket choice on a line of three or
-- more slots names a pocket that is not there (its three stages fill the row's three pockets); the chase, empty and
-- filler checks and the open/closed checks keep each slot and line saying what she decided; the binder and back-half
-- match is where the line physically is.
--
--   placement_decision.overrides  NEW: text[] not null default '{}', checked to hold only the five keys.
--   copy_bulk_unit()              CHANGED: 0036's body VERBATIM, except a full box takes the card when the write
--                                 declared bulk_box_full.
--   apply_write_ops               0036's body VERBATIM plus the parts marked "NEW in 0037" / "CHANGED in 0037": the
--                                 keys validated and handed to the trigger; insert_decision records them; the
--                                 two-stage rule and delete_bulk_unit's room check give way to their key; every
--                                 declared key must be recorded; the setting is reset before it returns.
--
-- NO CONVERSION BLOCK, no data changes: every existing decision takes the '{}' default (a plain stamp), and so does a
-- baseline re-stamped past 0037 when the column is added to it.
--
-- SECURITY properties are preserved exactly as 0006–0036 declared them: `security invoker`,
-- `set search_path = public, pg_temp`, no dynamic SQL, unknown op still raises. The trigger cannot see the payload,
-- so apply_write_ops hands it the validated keys in `app.overrides`, set transaction-local (set_config(..., true))
-- and reset to '[]' before it returns. It cannot be set through PostgREST: a request calls only the functions of the
-- exposed schema, set_config is in pg_catalog, and no request header or claim maps to an `app.*` setting. And all an
-- override relaxes is her own recommendation on her own rows: the trigger still checks the box is hers, and RLS
-- scopes every row the write touches.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The audit: which rules a decision overrode. A plain stamp ('{}') for every decision made before 0037.
alter table placement_decision add column overrides text[] not null default '{}';
alter table placement_decision add constraint placement_decision_overrides_known check (
  overrides <@ array['line_fit', 'line_min_stages', 'bulk_box_full', 'line_completion', 'collection_pick']::text[]
);
comment on column placement_decision.overrides is
  'The rules she overrode with this move (0037), only ever the five keys of its check. Empty = none.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The copy trigger: 0036's body VERBATIM, except a full box takes the card when the write declared bulk_box_full.
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
      -- CHANGED in 0036 — no default found. With boxes (a moment a write can be in mid-way; at commit she has exactly
      -- one default): her first box, the one 0035 gave her, else her lowest in order. Never a bulk copy with no box,
      -- and never a second box made beside hers.
      select * into unit from bulk_unit u
       where u.owner_id = new.owner_id
       order by (u.id = md5('bulk-box:' || new.owner_id::text)::uuid) desc, u.sort_order, u.created_at
       limit 1;
    end if;
    if not found then
      -- No box at all: her first one, with the id the conversion gives it (derived from her), so a box made here, by
      -- the migration and on a baseline always coincide (the DB Engineer's ask).
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
  -- CHANGED in 0037 — unless the write overrides it. Karvi: "Users should always be able to override all rules." A
  -- write through apply_write_ops that declared bulk_box_full (and recorded it on a decision, which that function
  -- checks) puts the card in a full box. The setting is that function's alone, and reads as none when it is unset,
  -- reset to '[]', or '' after the transaction that set it: a direct write into a full box is refused as in 0035.
  if entering and unit.capacity is not null
     and not (coalesce(nullif(current_setting('app.overrides', true), ''), '[]')::jsonb ? 'bulk_box_full') then
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

-- ---------------------------------------------------------------------------------------------------------------
-- 3. apply_write_ops: 0036's body VERBATIM, plus the parts marked NEW in 0037 / CHANGED in 0037.
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
  -- NEW in 0037 — the rules this write overrides, and what its decisions recorded.
  ovr          jsonb;                  -- payload.overrides, validated: a list of the five keys
  ovr_recorded jsonb := '[]'::jsonb;   -- every key this write's insert_decision ops recorded
  ovr_bad      jsonb;                  -- the first key that is not one of the five
  ovr_key      text;                   -- a declared key, checked against what was recorded
begin
  -- NEW in 0037 — the rules she overrides with this write (Karvi, 2026-10-01: "Users should always be able to
  -- override all rules"). A closed set, one key per family; integrity has no key, so it cannot be named. Anything
  -- else, or anything that is not a string in a list, is refused before a row changes.
  ovr := coalesce(payload -> 'overrides', '[]'::jsonb);
  if jsonb_typeof(ovr) <> 'array' then
    raise exception 'apply_write_ops: unknown override %', ovr using errcode = 'P0001';
  end if;
  select e into ovr_bad
    from jsonb_array_elements(ovr) as t(e)
   where jsonb_typeof(e) <> 'string'
      or e #>> '{}' not in ('line_fit', 'line_min_stages', 'bulk_box_full', 'line_completion', 'collection_pick')
   limit 1;
  if found then
    raise exception 'apply_write_ops: unknown override %', ovr_bad using errcode = 'P0001';
  end if;
  -- The copy trigger cannot see the payload, so it reads the validated keys from here: transaction-local, and reset
  -- to '[]' before this function returns, so no later statement in the transaction inherits them.
  perform set_config('app.overrides', ovr::text, true);

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
          id, haul_id, copy_id, decision, reason, resolved_by, line_id, line_slot_id,
          -- NEW in 0037: the rules she overrode with this move. Absent: '{}', a plain stamp. The column's check holds
          -- it to the five keys.
          overrides
        )
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          (op ->> 'haul_id')::uuid,
          (op ->> 'copy_id')::uuid,
          op ->> 'decision',
          op ->> 'reason',
          op ->> 'resolved_by',
          (op ->> 'line_id')::uuid,
          (op ->> 'line_slot_id')::uuid,
          coalesce(
            (select array_agg(x) from jsonb_array_elements_text(op -> 'overrides') as t(x)),
            '{}'::text[]
          )
        );
        -- NEW in 0037: what this write recorded, for the check after the loop.
        ovr_recorded := ovr_recorded || coalesce(op -> 'overrides', '[]'::jsonb);

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
        -- CHANGED in 0030 (UIL-121) — a block may name the ONE stage pocket it fills (`line_slot_id`: her "filler"
        -- stage choice). Absent, it is line-level: the third pocket of a short complete line (purpose 'line-filler'),
        -- or a pre-0030 'line-terminated' run.
        insert into binder_block (
          id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, line_slot_id, created_at
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
          (op ->> 'line_slot_id')::uuid,
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
        -- CHANGED in 0033: an alias is hers (UIL-127b); keyed by owner, owner_id from its default auth.uid().
        on conflict (owner_id, locale, dex_code)
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
          line_slot_id      = case when p ? 'line_slot_id'      then (p ->> 'line_slot_id')::uuid        else line_slot_id end,
          -- NEW in 0036 (UIL-130) — the box she picked. Absent: the copy trigger keeps its box, or gives a bulk copy
          -- her default box (a plan parked before boxes, or any writer that names none).
          bulk_unit_id      = case when p ? 'bulk_unit_id'      then (p ->> 'bulk_unit_id')::uuid        else bulk_unit_id end
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
          resolved_decision_collection_id = case when p ? 'resolved_decision_collection_id' then (p ->> 'resolved_decision_collection_id')::uuid else resolved_decision_collection_id end,
          -- NEW in 0030 (UIL-121) — her choice for an unfilled stage: chase a card, leave it empty, or a filler pocket.
          stage_choice                    = case when p ? 'stage_choice'                    then p ->> 'stage_choice'                            else stage_choice end
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
          status       = case when p ? 'status'       then p ->> 'status'       else status end,
          -- NEW in 0030 (UIL-121) — what fills a short complete line's third pocket, her choice.
          extra_pocket = case when p ? 'extra_pocket' then p ->> 'extra_pocket' else extra_pocket end
        where id = (op ->> 'id')::uuid;

      -- NEW in 0014 — forget a learned set alias (UIL-047 C3, second half). Keyed on the primary key;
      -- a key that matches no row is a silent no-op, like `delete_copy`. Emitted by lib/sync/exec.ts
      -- `forgetSetAlias` together with the `update_unresolved_entry` re-classifications of that set's
      -- WAITING entries (see the header), so the two land in one transaction.
      when 'delete_set_alias' then
        -- CHANGED in 0033: only her own alias (UIL-127b).
        delete from set_alias
        where owner_id = auth.uid() and locale = (op ->> 'locale') and dex_code = (op ->> 'dex_code');

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

      -- NEW in 0028 (UIL-117 PR 1) — UIL-087's slot invariant, checked at the database. A line slot is one fact
      -- stored twice, `line_slot.copy_id` and `copy.line_slot_id`, and until now only tests held the two
      -- together. lib/repo/write-ops.ts appends this op LAST to every write that touches a copy or a slot, naming
      -- the slots and copies it touched, so a writer that leaves either side stale is refused whole. Checked:
      -- the named slots; the slots the named copies point at, or are named by; and every slot reading
      -- `filled` with no copy (what deleting a slotted copy without releasing it leaves). For each, a filled
      -- slot names exactly one copy, which is shelved, points back, and sits in the line's binder in the back
      -- half; a slot that is not filled has no copy pointing at it. And a line of any of those slots, or a named
      -- line, reads `complete` only when every one of its slots is filled. Read-only: no row is written.
      when 'assert_line_slots' then
        declare
          bad   jsonb;
          n_bad integer;
        begin
          with named_copies as (
            select v::uuid as id from jsonb_array_elements_text(coalesce(op -> 'copy_ids', '[]'::jsonb)) v
          ), ids as (
            select v::uuid as id from jsonb_array_elements_text(coalesce(op -> 'slot_ids', '[]'::jsonb)) v
            union
            select c.line_slot_id from copy c
             where c.id in (select id from named_copies) and c.line_slot_id is not null
            union
            select s.id from line_slot s where s.copy_id in (select id from named_copies)
            union
            select s.id from line_slot s where s.state = 'filled' and s.copy_id is null
          ), checked as (
            select s.id, s.state, s.copy_id, l.binder_id as line_binder,
                   c.id as cid, c.role, c.line_slot_id as c_slot, c.binder_id as c_binder,
                   c.binder_half as c_half,
                   (select count(*) from copy p where p.line_slot_id = s.id) as pointers,
                   -- NEW in 0030 (UIL-121): her stage choice, and what it requires.
                   s.stage_choice, s.target_catalog_card_id as target,
                   (select count(*) from wishlist_item w
                     where w.line_slot_id = s.id and w.resolved_at is null) as open_wishes,
                   (select count(*) from binder_block b where b.line_slot_id = s.id) as slot_blocks
              from line_slot s
              join evolution_line l on l.id = s.line_id
              left join copy c on c.id = s.copy_id
             where s.id in (select id from ids)
          ), lines_checked as (
            select v::uuid as id from jsonb_array_elements_text(coalesce(op -> 'line_ids', '[]'::jsonb)) v
            union
            select s.line_id from line_slot s where s.id in (select id from ids)
          ), v as (
            select id, case
                     when state = 'filled' and copy_id is null then 'filled with no copy'
                     when state = 'filled' and cid is null then 'its copy is gone'
                     when state = 'filled' and role <> 'shelved' then 'its copy is not shelved'
                     when state = 'filled' and c_slot is distinct from id then 'its copy does not point back'
                     when state = 'filled' and c_binder is distinct from line_binder then 'its copy is in another binder'
                     when state = 'filled' and c_half is distinct from 'back' then 'its copy is not in the back half'
                     when state = 'filled' and pointers <> 1 then 'more than one copy points at it'
                     when state <> 'filled' and pointers > 0 then 'a copy points at it but it is not filled'
                     -- NEW in 0030 (UIL-121). A stage she decided is exactly what she decided (checked only once a
                     -- choice is recorded: pre-0030 rows and the writers that have not moved yet carry none).
                     when state = 'filled' and stage_choice is not null then 'a filled stage still carries a choice'
                     when stage_choice = 'chase' and state <> 'placeholder' then 'a chased stage is not an open slot'
                     when stage_choice = 'chase' and target is null then 'a chased stage names no card'
                     when stage_choice = 'chase' and open_wishes <> 1 then 'a chased stage is not on her wishlist exactly once'
                     when stage_choice = 'empty' and state <> 'placeholder' then 'a stage left empty is not an open slot'
                     when stage_choice = 'empty' and open_wishes > 0 then 'a stage left empty is on her wishlist'
                     when stage_choice = 'filler' and state <> 'block' then 'a filler stage is not a block'
                     when stage_choice = 'filler' and slot_blocks <> 1 then 'a filler stage needs exactly one block row'
                     when stage_choice = 'filler' and open_wishes > 0 then 'a filler stage is on her wishlist'
                   end as why
              from checked
            union all
            select l.id, 'the line reads complete with a slot that is not filled'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.status = 'complete'
               and exists (select 1 from line_slot s where s.line_id = l.id and s.state <> 'filled')
            -- NEW in 0030 (UIL-121): a line is OPEN or CLOSED (Karvi). 'complete' and 'terminated' still read as closed,
            -- and 'capped' as open, until the writers that still use them have moved (then a later migration drops them).
            union all
            -- NEW in 0032 (UIL-121, Karvi 2026-09-27): "A basic with no evolution should not be allowed to get put in
            -- the 'lines' area." A line CREATED by this write (its created_at is this transaction's now(): every line
            -- insert is `insert_line`, which never sets it) has at least two stages. Only new lines: an older one-card
            -- line, if any existed, must still let its card move out (her always-movable rule).
            select l.id, 'a line needs at least two stages'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.created_at = now()
               and (select count(*) from line_slot s where s.line_id = l.id) < 2
               -- NEW in 0037: unless she overrides it (line_min_stages), recorded with the move. Only this rule: the
               -- pointer checks are integrity, and the rest of this check is what she decided or where the line is.
               and not (ovr ? 'line_min_stages')
            union all
            select l.id, 'every slot is filled but the line reads open'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.status in ('open', 'capped')
               and exists (select 1 from line_slot s where s.line_id = l.id)
               and not exists (select 1 from line_slot s where s.line_id = l.id and s.state <> 'filled')
            union all
            select l.id, 'the line reads closed but a stage is being chased'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.status in ('closed', 'complete', 'terminated')
               and exists (select 1 from line_slot s where s.line_id = l.id and s.stage_choice = 'chase')
            union all
            select l.id, 'a third-pocket choice on a line with no third pocket'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.extra_pocket is not null
               -- CHANGED in 0032 (UIL-121): a short line keeps its third-pocket choice when a card leaves it. The energy
               -- or spare card is still in that pocket; only "complete" changed. She is ASKED only when a short line is
               -- complete (validateThirdPocket), but her answer stands while the line is short. 0030 also required the
               -- line to be complete here, which refused every Move, removal or undo out of such a line.
               and (select count(*) from line_slot s where s.line_id = l.id) >= 3
            union all
            select l.id, 'the third pocket does not hold what she chose'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and l.extra_pocket is not null
               and (select count(*) from binder_block b
                     where b.line_id = l.id and b.line_slot_id is null and b.purpose = 'line-filler'
                       and ((l.extra_pocket = 'energy' and b.copy_id is null and b.material = 'basicEnergy')
                         or (l.extra_pocket = 'card' and b.copy_id is not null and b.material = 'repurposedDuplicate')))
                   <> case when l.extra_pocket = 'empty' then 0 else 1 end
            union all
            select l.id, 'more than one thing fills the third pocket'
              from evolution_line l
             where l.id in (select id from lines_checked)
               and (select count(*) from binder_block b
                     where b.line_id = l.id and b.line_slot_id is null and b.purpose = 'line-filler') > 1
            union all
            select b.line_id, 'a filler block names a slot on another line'
              from binder_block b
              join line_slot s on s.id = b.line_slot_id
             where b.line_id in (select id from lines_checked)
               and s.line_id is distinct from b.line_id
            union all
            -- A tracked filler card (a stage pocket or the third pocket) is a block in the line's binder, back half, on
            -- no slot: exactly where her binder holds it.
            select b.line_id, 'a filler card is not a block in the line''s back half'
              from binder_block b
              join evolution_line l on l.id = b.line_id
              left join copy c on c.id = b.copy_id
             where b.line_id in (select id from lines_checked)
               and b.purpose = 'line-filler'
               and b.copy_id is not null
               and (c.id is null or c.role <> 'block' or c.binder_id is distinct from l.binder_id
                    or c.binder_half is distinct from 'back' or c.line_slot_id is not null)
          )
          select (select count(*) from v where why is not null),
                 (select coalesce(jsonb_agg(jsonb_build_object('slot', id, 'why', why) order by id), '[]'::jsonb)
                    from (select * from v where why is not null order by id limit 20) first20)
            into n_bad, bad;
          if n_bad > 0 then
            raise exception using
              errcode = 'P0001',
              message = format('apply_write_ops: line slot check failed on %s slot(s) (UIL-087)', n_bad),
              detail = bad::text;
          end if;
        end;

      -- NEW in 0029 (UIL-118) — delete a line that holds no card. Karvi: "I need the ability to delete lines. I
      -- accidentally added cards in the wrong place. I moved the cards, but the lines still created placeholders."
      -- Deletes the line's wishes (open and resolved: the line was a mistake), its slots and the line, every
      -- statement scoped by owner AND id (pg_safeupdate needs a WHERE; the owner names whose rows). REFUSED whole
      -- while anything still points at it: a filled slot, a copy whose `line_slot_id` names one of its slots (the
      -- FK would silently null it and strand the card in a back half with no line), or a `binder_block` on the
      -- line (a physical block, her call to remove first). Decision history keeps its label and loses the link
      -- (`placement_decision.line_id` / `line_slot_id` are ON DELETE SET NULL, 0013). Runs only as the
      -- signed-in owner, like the other owner-scoped deletes (0026): the service role has no `auth.uid()`.
      when 'delete_line' then
        declare
          lid     uuid := (op ->> 'line_id')::uuid;
          n_fill  integer;
          n_copy  integer;
          n_block integer;
          n_gone  integer;
        begin
          if current_user <> 'authenticated' then
            raise exception 'apply_write_ops: delete_line runs only as the signed-in owner, not %', current_user;
          end if;
          select count(*) into n_fill from line_slot where line_id = lid and state = 'filled';
          select count(*) into n_copy
            from copy c join line_slot s on s.id = c.line_slot_id
           where s.line_id = lid;
          -- CHANGED in 0032 (UIL-121): an untracked energy filler is not something the line HOLDS; it goes with the
          -- line. A tracked filler card is a card, so it still refuses the delete (UIL-118).
          select count(*) into n_block from binder_block
           where line_id = lid and not (purpose = 'line-filler' and copy_id is null);
          if n_fill > 0 or n_copy > 0 or n_block > 0 then
            raise exception using
              errcode = 'P0001',
              message = 'apply_write_ops: delete_line refused, the line still holds something (UIL-118)',
              detail = json_build_object(
                'line', lid, 'filled_slots', n_fill, 'copies', n_copy, 'blocks', n_block
              )::text;
          end if;
          -- NEW in 0032 (UIL-121): the line's energy fillers go with it.
          delete from binder_block
           where owner_id = auth.uid() and line_id = lid and purpose = 'line-filler' and copy_id is null;
          delete from wishlist_item
           where owner_id = auth.uid()
             and line_slot_id in (select id from line_slot where owner_id = auth.uid() and line_id = lid);
          delete from line_slot where owner_id = auth.uid() and line_id = lid;
          delete from evolution_line where owner_id = auth.uid() and id = lid;
          get diagnostics n_gone = row_count;
          if n_gone = 0 then
            raise exception using
              errcode = 'P0001',
              message = 'apply_write_ops: delete_line found no such line (UIL-118)',
              detail = json_build_object('line', lid)::text;
          end if;
        end;

      -- NEW in 0030 (UIL-121) — take a block out: she changed what fills a pocket. Scoped by owner AND id
      -- (pg_safeupdate needs a WHERE; the owner names whose rows), and only as the signed-in owner (0026). A tracked
      -- card's own move back to the bulk box is the caller's `update_copy` in the same call.
      when 'delete_binder_block' then
        declare
          n_gone integer;
        begin
          if current_user <> 'authenticated' then
            raise exception 'apply_write_ops: delete_binder_block runs only as the signed-in owner, not %', current_user;
          end if;
          delete from binder_block where owner_id = auth.uid() and id = (op ->> 'id')::uuid;
          get diagnostics n_gone = row_count;
          if n_gone = 0 then
            raise exception using
              errcode = 'P0001',
              message = 'apply_write_ops: delete_binder_block found no such block (UIL-121)',
              detail = json_build_object('block', op ->> 'id')::text;
          end if;
        end;

      -- NEW in 0033 — her rainbow order, written whole (UIL-127b). `bands` must name every configured band exactly
      -- once; anything else is refused before a row changes.
      when 'set_band_order' then
        ids := array(select jsonb_array_elements_text(coalesce(op -> 'bands', '[]'::jsonb)));
        if cardinality(ids) <> (select count(*) from color_band)
           or cardinality(ids) <> (select count(distinct k) from unnest(ids) as k)
           or exists (select 1 from unnest(ids) as k where not exists (select 1 from color_band b where b.band = k))
        then
          raise exception 'The rainbow order must name every band once. Reload Settings and try again.'
            using errcode = 'P0001', detail = json_build_object('check', 'band_order')::text;
        end if;
        delete from owner_band_order where owner_id = auth.uid();
        insert into owner_band_order (band, position)
        select k, n from unnest(ids) with ordinality as t(k, n);

      -- NEW in 0033 — one type's band in her map (UIL-127b). Her map starts as a copy of the defaults, so it is
      -- always whole; then the one type is set.
      when 'set_type_band' then
        if not exists (select 1 from owner_type_band where owner_id = auth.uid()) then
          insert into owner_type_band (card_type, band) select card_type, band from type_color_map;
        end if;
        insert into owner_type_band (card_type, band)
        values (op ->> 'card_type', op ->> 'band')
        on conflict (owner_id, card_type) do update set band = excluded.band;

      -- NEW in 0033 — a shelved or block card the payload put in NO binder (UIL-127a's rule, as the database's
      -- backstop). lib/repo/write-ops.ts names only the copies whose binder the payload SET, so a card left without a
      -- binder by a deleted binder stays movable (the Tech Lead's C3).
      when 'assert_copy_binders' then
        declare
          bad text;
        begin
          select string_agg(c.id::text, ', ' order by c.id) into bad
          from copy c
          where c.id in (
              select value::uuid from jsonb_array_elements_text(coalesce(op -> 'copy_ids', '[]'::jsonb))
            )
            and c.role in ('shelved', 'block')
            and c.binder_id is null;
          if bad is not null then
            raise exception 'A card has no binder to go to. Add a binder in Settings, or move the card somewhere else.'
              using errcode = 'P0001', detail = json_build_object('check', 'copy_binder', 'copy_ids', bad)::text;
          end if;
        end;

      -- NEW in 0036 (UIL-130) — her bulk boxes, added like binders (Karvi, 2026-09-29). Every statement is scoped to
      -- the signed-in owner and an id (pg_safeupdate). Her first box is her default; she always has exactly one.
      when 'insert_bulk_unit' then
        insert into bulk_unit (id, name, sort_order, capacity, is_default)
        values (
          coalesce((op ->> 'id')::uuid, gen_random_uuid()),
          btrim(op ->> 'name'),
          coalesce(
            (op ->> 'sort_order')::integer,
            (select coalesce(max(u.sort_order), -1) + 1 from bulk_unit u where u.owner_id = auth.uid())
          ),
          (op ->> 'capacity')::integer,
          not exists (select 1 from bulk_unit u where u.owner_id = auth.uid() and u.is_default)
        );

      when 'update_bulk_unit' then
        p := op -> 'patch';
        update bulk_unit set
          name       = case when p ? 'name'       then btrim(p ->> 'name')              else name end,
          capacity   = case when p ? 'capacity'   then (p ->> 'capacity')::integer      else capacity end,
          sort_order = case when p ? 'sort_order' then (p ->> 'sort_order')::integer    else sort_order end
        where owner_id = auth.uid() and id = (op ->> 'id')::uuid;
        if not found then
          raise exception 'That box isn''t one of yours any more. Reload and pick again.'
            using errcode = 'P0001', detail = json_build_object('check', 'bulk_unit_owner')::text;
        end if;

      -- Her default box changes in ONE op: the old default lets go, then the new one takes it (the one-default index
      -- is per row, so the order matters).
      when 'set_default_bulk_unit' then
        if not exists (
          select 1 from bulk_unit u where u.owner_id = auth.uid() and u.id = (op ->> 'id')::uuid
        ) then
          raise exception 'That box isn''t one of yours any more. Reload and pick again.'
            using errcode = 'P0001', detail = json_build_object('check', 'bulk_unit_owner')::text;
        end if;
        update bulk_unit set is_default = false
         where owner_id = auth.uid() and is_default and id <> (op ->> 'id')::uuid;
        update bulk_unit set is_default = true
         where owner_id = auth.uid() and id = (op ->> 'id')::uuid;

      -- A box goes only with somewhere for its cards to go (`move_to`, another of her boxes), checked before anything
      -- moves: never her last box, never into a box with a limit that cannot take them all. Its cards and the spare
      -- cards that call it home move; a deleted default passes its place to `move_to`.
      when 'delete_bulk_unit' then
        declare
          gone   bulk_unit%rowtype;
          dest   bulk_unit%rowtype;
          moving integer;
          held   integer;
        begin
          select * into gone from bulk_unit u where u.owner_id = auth.uid() and u.id = (op ->> 'id')::uuid;
          if not found then
            raise exception 'That box isn''t one of yours any more. Reload and pick again.'
              using errcode = 'P0001', detail = json_build_object('check', 'bulk_unit_owner')::text;
          end if;
          if not exists (select 1 from bulk_unit u where u.owner_id = auth.uid() and u.id <> gone.id) then
            raise exception 'This is your only bulk box. Add another box before you delete this one.'
              using errcode = 'P0001', detail = json_build_object('check', 'bulk_unit_last')::text;
          end if;
          select * into dest from bulk_unit u
           where u.owner_id = auth.uid() and u.id = (op ->> 'move_to')::uuid and u.id <> gone.id
             for update;
          if not found then
            raise exception 'Pick the box this one''s cards go to.'
              using errcode = 'P0001', detail = json_build_object('check', 'bulk_unit_move_to')::text;
          end if;
          select count(*) into moving from copy c
           where c.owner_id = auth.uid() and c.bulk_unit_id = gone.id and c.role = 'bulk';
          -- CHANGED in 0037: unless she overrides it (bulk_box_full), recorded with the move; the copy trigger lets
          -- the cards in for the same key. Her last box, and a move_to that is missing or the box itself, stay
          -- refused above: her cards always have somewhere real to go.
          if dest.capacity is not null and not (ovr ? 'bulk_box_full') then
            select count(*) into held from copy c
             where c.owner_id = auth.uid() and c.bulk_unit_id = dest.id and c.role = 'bulk';
            if held + moving > dest.capacity then
              raise exception 'Your % can''t take these % cards: it has room for %. Pick another box.',
                dest.name, moving, greatest(dest.capacity - held, 0)
                using errcode = 'P0001',
                      detail = json_build_object('check', 'bulk_unit_full', 'unit', dest.id)::text;
            end if;
          end if;
          update copy set bulk_unit_id = dest.id
           where owner_id = auth.uid() and bulk_unit_id = gone.id;
          if gone.is_default then
            update bulk_unit set is_default = false where owner_id = auth.uid() and id = gone.id;
            update bulk_unit set is_default = true where owner_id = auth.uid() and id = dest.id;
          end if;
          delete from bulk_unit where owner_id = auth.uid() and id = gone.id;
        end;

      else
        raise exception 'apply_write_ops: unknown op %', op ->> 'op';
    end case;
  end loop;

  -- NEW in 0037 — nothing silent: every rule this write overrides is recorded by one of its decisions, or the whole
  -- write is refused. Checked against what the ops above recorded, not against the table.
  for ovr_key in select value from jsonb_array_elements_text(ovr)
  loop
    if not (ovr_recorded ? ovr_key) then
      raise exception 'An override has to be recorded with the move.'
        using errcode = 'P0001',
              detail = json_build_object('check', 'override_recorded', 'rule', ovr_key)::text;
    end if;
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

  -- NEW in 0037 — the override ends with this write: a later statement in the same transaction (a direct write, or
  -- another call that declares nothing) is held to every rule.
  perform set_config('app.overrides', '[]', true);
end;
$$;
