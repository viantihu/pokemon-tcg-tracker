-- 0018_haul_copy_state — a copy can be IN HAUL: imported, and not placed anywhere yet (UIL-088).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0017 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- HER MODEL, in her words (2026-09-22): "SHELVED = placed in a binder or a bulk box; BULK = placed in a
-- bulk box; IN HAUL = imported but not placed anywhere, which is NOT bulk." The app had two states where
-- she has three, and wrote an imported-but-unplaced copy as `role = 'bulk'` — so "a card she filed in a
-- box" and "a card the app has never put anywhere" were the same value. That conflation was UIL-087's
-- cause (a): the engine read an unplaced copy as "already placed" and filled a line slot with it.
--
-- THE THIRD STATE ALREADY EXISTED, spelled as a conjunction. `copyRepo.listUnplaced` selected
-- `role = 'bulk' AND binder_id IS NULL AND line_slot_id IS NULL`, and `loadPendingPlacements` then kept
-- only those with no `placement_decision` row (UIL-042: the decision row is what takes a card out of the
-- queue). That is the Haul Plan's "cards waiting to be placed". This migration gives that set a name, so
-- the question is asked once instead of re-derived — which is why the classification below IS that
-- predicate, and why the app and this repair cannot disagree about which copies are in the haul.
--
-- ONE COLUMN, NOT TWO, deliberately. A separate `in_haul` flag beside `role` would store one fact twice
-- and need an invariant to keep them agreeing. This project has already paid for that shape three times:
-- `line_slot.copy_id` against `copy.line_slot_id` produced UIL-062, migrations 0010 and 0011, and UIL-087.
-- The trade is that her word SHELVED (placed anywhere) and this column's `'shelved'` (in a binder) differ
-- in scope; `isPlaced(role)` in lib/engine/types.ts is the single bridge, and nothing re-derives it.
--
-- THE CLASSIFICATION, first match wins, keyed on the copy's own columns plus the PRESENCE of a decision
-- row — never on `placement_decision.reason`, which is free text:
--   (a) `line_slot_id IS NOT NULL`        -> shelved. A slotted copy is placed by definition (UIL-087).
--                                            A REPAIR, not just an ordering: Testing carries 3 such rows.
--   (b) `role = 'block'`                  -> block, unchanged. A block IS placed: a spacer in a binder.
--   (c) `role = 'shelved'`                -> shelved, unchanged.
--   (d) `role = 'bulk'` + a decision row  -> bulk. She or the cascade put it in the box.
--   (e) `role = 'bulk'` + no decision row -> HAUL. Imported, never placed.
--   (f) `role = 'bulk'` + a binder + NO slot -> bulk, and this should not exist (bulk clears the binder).
--       Asserted to be zero below rather than assumed, so a surprise stops the deploy.
--
-- (a) and (e) each change rows. NOTHING IS DELETED and no other column is touched.
--
-- THE SLOT LINK IS TWO-SIDED and the halves can disagree: nothing in the schema ties `line_slot.copy_id`
-- to `copy.line_slot_id`, and UIL-062 and UIL-087 both shipped exactly that drift. A copy whose SLOT names
-- it while its own back-pointer is null is therefore excluded from (e) explicitly, so it stays 'bulk': not
-- 'haul', because a line is holding it, and not 'shelved', because no binder can be asserted for it. Today
-- that set is EMPTY — the UIL-061 drift check's check B (filled slots whose copy does not point back at
-- that slot) reads 0 on Testing, as does check A — so the clause is a guard added before 0018 freezes, not
-- a repair. Repairing such a row, if one ever appears, belongs to its own migration with its own read.
--
-- WHY A MISCLASSIFICATION IS SAFE, stated because the split cannot be verified from PostgREST filters
-- alone (it needs an anti-join): 'bulk' and 'haul' both mean "not in a binder" — neither carries a binder,
-- half, band or slot — so moving a row between them loses nothing physical and is reversible by the same
-- predicate. What IS verifiable: `haul + bulk` after equals `bulk` before, every other role count and the
-- `copy` total are unchanged, and `copy?role=eq.haul` must equal the number the Haul Plan shows as "cards
-- waiting to be placed", because that queue is computed from the same predicate.
--
-- IDEMPOTENT: a second run matches nothing, because the rows it moved no longer have `role = 'bulk'`.
-- Safe on Production's empty `copy` at cutover.
--
-- EXPECTED ROW EFFECT ON TESTING, from the BEFORE read taken 2026-09-22 (Actions run 35810562689):
--   copy    712  -> 712 unchanged      shelved 120 -> 123   (rule (a): the 3 UIL-087 leftovers)
--   bulk    592  ->  16                haul      0 -> 573   (rule (e): 589 unplaced minus 16 decided)
--   block     0  ->   0                slotted  39, all 'shelved' afterwards
--   placement_decision 155 unchanged. Nothing else moves, and the Haul Plan's "cards waiting" reads 573.

-- 1. Admit the new value. `role` has no default change: a hand-entered card is still 'shelved'.
alter table copy drop constraint copy_role_check;
alter table copy
  add constraint copy_role_check check (role in ('haul', 'shelved', 'bulk', 'block'));

-- 2. Rule (a), as a REPAIR and not just an ordering: a copy a line slot holds is placed, whatever its role
--    says. On Testing this is the 3 UIL-087 leftovers — the confirmed-pull write set slot, binder, half and
--    band but never the role, so the copy kept the import's 'bulk'. Karvi has not moved them. Leaving them
--    would leave this file asserting a state its own rule (a) denies, and would make rule (f) below raise
--    on the one shape 0018 exists to repair.
update copy
set role = 'shelved'
where role = 'bulk'
  and line_slot_id is not null;

-- 3. Rule (f) as an assertion, AFTER (a) has cleared the slotted rows: a copy in a binder while holding no
--    slot must not still be 'bulk', because bulk clears the binder. Reads 0 on Testing today
--    (`copy?role=eq.bulk&binder_id=not.is.null&line_slot_id=is.null`). It stays because a row in that shape
--    is a placement nobody can explain, and a surprise should stop the deploy rather than be assumed.
--
--    ON THE `line_slot_id is null` NARROWING, stated exactly because it is easy to overclaim. The first cut
--    of this file asserted the un-narrowed shape (bulk + a binder) BEFORE any repair ran, and that raised on
--    Testing: the rule (a) leftovers carry a binder, so the assertion failed the deploy on the one shape
--    0018 exists to fix. With (a) running first those rows are already 'shelved', so the two forms are now
--    EQUIVALENT — a mutation that widens it back does not fail a test, and should not. The narrowing is kept
--    because it makes the assertion say what it means on its own, independent of what runs above it.
do $$
declare bad integer;
begin
  select count(*) into bad
    from copy
    where role = 'bulk' and binder_id is not null and line_slot_id is null;
  if bad > 0 then
    raise exception
      '0018: % bulk copy(ies) carry a binder_id while holding no line slot, which the placement rules forbid — classify them by hand before this runs', bad;
  end if;
end $$;

-- 4. Rule (e): a copy in no binder, in no slot, with no placement decision, is a card an import created and
--    she has never placed. Its own `line_slot_id is null` is now redundant — (a) already moved every slotted
--    bulk row out — and is kept as a statement of the rule rather than as the thing doing the work.
--
--    The last clause asks the OTHER side of the slot link (see the header). A copy whose slot names it while
--    its own `line_slot_id` is null must not become 'haul' — a line is holding it, and 0019 derives that
--    line's locale from it through `line_slot.copy_id`. It stays 'bulk', because no binder can be asserted
--    for it either. Empty on Testing today (UIL-061 drift check B = 0); a guard, not a repair.
update copy
set role = 'haul'
where role = 'bulk'
  and binder_id is null
  and line_slot_id is null
  and not exists (
    select 1 from placement_decision d where d.copy_id = copy.id
  )
  and not exists (
    select 1 from line_slot s where s.copy_id = copy.id
  );
