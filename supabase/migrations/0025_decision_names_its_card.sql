-- 0025_decision_names_its_card — placement history keeps the card it is about (UIL-094).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0024 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
-- MERGE ORDER: after 0024 (the Tech Lead's); merged first, the migration-order check would refuse 0024.
--
-- THE PROBLEM. `placement_decision.copy_id` is `references copy (id) on delete set null` (0002). Sync's
-- retire deletes the copy, and UIL-089's "Not mine" deletes it in the same transaction as its own audit
-- row, so every retired or removed card leaves decision rows that name nothing: `reason` is free text,
-- `haul_id` names a sitting, `line_id` / `line_slot_id` name where, never what. UIL-042 promised history
-- is never deleted; the rows survive, but "removed" about no card in particular keeps that promise only in
-- the letter. UIL-089's self-describing `reason` ("Removed — <card id> <variant>, was <placement>") was the
-- stopgap, and stays: this makes the same fact queryable instead of grep-able.
--
-- WHAT THIS ADDS. Three nullable columns naming the card a decision is about — `catalog_card_id`,
-- `variant`, `dex_variant_raw` — copied from the copy when the decision is written, so they outlive it.
--
-- NO FOREIGN KEY ON catalog_card_id, DELIBERATELY (the Senior BA's ruling, 2026-09-25). Do not "fix" this.
-- It is a LABEL, like `reason`: a record of what the card was at the time, which must outlive changes to
-- the catalog. Every FK behaviour is wrong here:
--   * ON DELETE RESTRICT would stop the catalog ever removing a row that history names — including
--     UIL-060 Half 2's swap of a stand-in (`user:` id) for the real card TCGdex later adds;
--   * ON DELETE SET NULL would recreate this very bug one table up: history naming nothing again;
--   * ON DELETE CASCADE would delete history, the one thing UIL-042 says never happens.
-- A stale id is still an answer ("it was this card"); a null or a missing row is not.
--
-- THE TRIGGER, AND WHY NOT apply_write_ops. A BEFORE INSERT trigger fills the three columns from the copy
-- whenever a decision names a copy and leaves them empty. It was checked against every writer of
-- `placement_decision` as of develop f99bb90. The ONLY SQL writer is the `insert_decision` branch of
-- `apply_write_ops` (0022's text, and 0024's re-issue of it; the older copies are superseded), and every TypeScript
-- site emits that op while its copy still exists:
--    1. lib/plan/commit.ts:429   — Haul Plan, an overridden placement
--    2. lib/plan/commit.ts:445   — Haul Plan, the cascade's placement
--    3. lib/plan/commit.ts:903   — Haul Plan, a confirmed pull into a new line
--    4. lib/backfill/commit.ts:129 — Backfill, every placement
--    5. lib/coll/rebind.ts:164   — a collection re-homed (copy_id NULL: about the collection, stays unnamed)
--    6. lib/coll/rebind.ts:174   — a copy moved by that re-home
--    7. lib/coll/remove.ts:158   — removed from a collection (the copy stays)
--    8. lib/coll/remove.ts:168   — re-homed by that removal
--    9. lib/line/move.ts:458     — a card moved
--   10. lib/line/write.ts:351    — a line decision (copy_id NULL: about the line, stays unnamed)
--   11. lib/copy/remove.ts:106   — "Not mine": the decision is written, THEN `delete_copy`, in one
--       transaction, so the trigger reads the copy before it goes. That ordering is what names it.
-- A sync retire writes no decision; the rows it orphans are the older placement decisions of that copy,
-- which carry their card from the moment they were written (or from the backfill below).
-- So a NEW writer needs nothing: any decision that names an existing copy is named, whoever writes it. And
-- `apply_write_ops` is not replaced — this file never touches it, whichever migration last re-issued it —
-- which tests/plan/decision-names-its-card.test.ts pins.
--
-- A decision whose copy_id is NULL at insert stays unnamed — the trigger never guesses (the Senior BA's
-- condition; pinned). A caller that supplies the columns itself (the Production promotion copies them from
-- Testing) is never overwritten.
--
-- SECURITY. The trigger function is SECURITY INVOKER with a pinned search_path: it reads `copy` as the
-- caller, under the caller's RLS, so it can only ever name one of the caller's own copies (pinned).
--
-- BACKFILL. Every existing decision whose copy still exists is named from it, in this migration. Rows whose
-- copy is already gone stay NULL, their `reason` intact — reasons are not parsed: free text is how history
-- goes wrong, and Testing was emptied on 2026-09-23, so there is almost nothing to recover.
--
-- Expected row effect on Testing (the Senior BA reads B1–B4 immediately before merge):
--   named after = B2 (rows with copy_id NOT NULL); copy_id NOT NULL and catalog_card_id NULL = 0;
--   copy_id NULL and catalog_card_id NULL = B3; total = B1, unchanged. No row is inserted or deleted.

alter table placement_decision
  add column catalog_card_id text,
  add column variant text,
  add column dex_variant_raw text;

comment on column placement_decision.catalog_card_id is
  'The card this decision is about, copied from the copy when the decision was written (UIL-094). A label with NO foreign key, like reason: it must outlive the copy (deleted by a retire or a removal) and any change to the catalog. NULL when the decision is about a line or a collection, or its copy was gone before 0025.';
comment on column placement_decision.variant is
  'The copy''s app variant at the time of the decision (UIL-094). See catalog_card_id.';
comment on column placement_decision.dex_variant_raw is
  'The copy''s Dex variant at the time of the decision (UIL-094). See catalog_card_id.';

-- Backfill: name every decision whose copy still exists.
update placement_decision pd
   set catalog_card_id = c.catalog_card_id,
       variant         = c.variant,
       dex_variant_raw = c.dex_variant_raw
  from copy c
 where c.id = pd.copy_id
   and pd.catalog_card_id is null;

create or replace function placement_decision_name_its_card()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Only a decision about a copy, and only when the writer did not name it itself.
  if new.copy_id is not null and new.catalog_card_id is null then
    select c.catalog_card_id, c.variant, c.dex_variant_raw
      into new.catalog_card_id, new.variant, new.dex_variant_raw
      from copy c
     where c.id = new.copy_id;
  end if;
  return new;
end;
$$;

create trigger placement_decision_name_its_card
  before insert on placement_decision
  for each row execute function placement_decision_name_its_card();
