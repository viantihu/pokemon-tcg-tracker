-- 0010_release_stale_line_slots — one-time repair: reopen line slots that name a copy which is no
-- longer in them (UIL-062).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive and data-only — 0001–0009 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY THIS EXISTS. `line_slot.copy_id` and `copy.line_slot_id` are one fact stored twice, and the app is
-- only correct when they agree. Two write paths broke the pair and are fixed in the same PR as this
-- migration, prevention first:
--
--   * the Haul Plan's placement override (`writeOverriddenCard`) cleared the copy's pointer —
--     `placementForMove` does that for every destination kind, correctly, since no `MoveDestination`
--     can express "into a line slot" — but emitted no slot op at all, so the vacated slot stayed
--     `filled` naming a copy that had moved. 4 of the 5 rows below.
--   * the `filledExistingSlot` branch wrote both pointers only `if (slot)`, with no else, so an
--     unresolvable slot produced a card shelved in the back half whose stage still read as wanting one.
--
-- The Lines page reads the SLOT, so these render as occupied by a card that is elsewhere and nothing on
-- screen contradicts it. Measured on Testing: 5 such rows.
--
-- WHY THE COPY SIDE ALWAYS WINS, and why this never writes a pointer back. All four override rows carry
-- `placement_decision.resolved_by = 'user'`: she chose that destination. And because no
-- `MoveDestination` can name a line slot, her choice cannot have meant "put this card in that slot" —
-- it meant bulk, a shelf, or a collection. So the copy's own columns are the authoritative record of
-- where the card physically is, and the slot is the stale half. Re-attaching would invent a placement
-- decision on her behalf; releasing records what is already true.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH. There are also 8 shelved back-half copies with a NULL pointer
-- (about 4 of which render as HUNTING — the Dragonair report, UIL-063). They are NOT repaired here, and
-- that is a deliberate call rather than an omission: measurement showed ZERO of them have an intended
-- placeholder slot to be re-attached to (5 have a placeholder in the right binder+band wanting a
-- DIFFERENT card, 3 have no placeholder there at all). A migration that picked a slot for them would be
-- inventing her placement decisions. They are physically correct and correctly filed; what is missing is
-- the line's knowledge of them, and she can now attach them herself from the Lines page's "not in a line
-- yet" list (UIL-056, shipped in #120 — `unlinedCards` lists every shelved copy with a null pointer, so
-- all 8 appear with join candidates). That is her decision to make, not a migration's.
--
-- IDEMPOTENT AND SAFE ON AN EMPTY TABLE. The predicate is a NOT EXISTS correlated on the slot's own
-- `copy_id`, so re-running it matches nothing once repaired, and it affects zero rows against
-- Production's empty `line_slot` at cutover. No RLS change: this runs as the migration role and touches
-- only rows that are already broken.
--
-- Expected row effect on Testing: 5.

update line_slot
set state = 'placeholder',
    copy_id = null
where state = 'filled'
  and copy_id is not null
  and not exists (
    select 1
    from copy c
    where c.id = line_slot.copy_id
      and c.line_slot_id = line_slot.id
  );
