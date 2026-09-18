-- 0011_relink_unambiguous_line_slots — pair a shelved back-half copy with the placeholder slot that
-- names exactly it, and ONLY where that pairing is unambiguous in both directions (UIL-062 follow-up).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive and data-only — 0001–0010 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY THIS IS POSSIBLE NOW AND WAS NOT BEFORE. 0010 released 5 stale `filled` slots to `placeholder`.
-- It correctly never touched their `target_catalog_card_id`, so releasing them RE-EXPOSED what each of
-- those slots was waiting for — and 5 of the 8 shelved back-half copies with a null pointer turned out
-- to have a placeholder in the same binder and band naming exactly their card. Before 0010 those slots
-- read `filled`, so there was nothing to pair with and the honest answer was to leave all 8 alone.
--
-- THE UNIQUENESS GUARD IS THE POINT OF THIS FILE, not defensive boilerplate. A pre-flight count on
-- Testing measured the pairing cardinality of all 8:
--
--     strictly 1:1 (safe to relink):                  3
--     one slot, SEVERAL copies want it (ambiguous):   2
--     SEVERAL slots match this copy:                  0
--     no matching slot at all (stays hers):           3
--
-- So the skip branch is LIVE on her real data, not dead code: without it, 2 pairs would have been
-- guessed. The dangerous shape — one copy that could belong to two different lines — does not occur.
-- The 2 ambiguous ones are the same printing twice: she owns two copies of one card in that binder and
-- band, and a single placeholder wants it.
--
-- AND DELIBERATELY NO TIE-BREAK. Picking the older `created_at` would put a correct CARD in the slot,
-- but `target_catalog_card_id` says nothing about `variant` — if those two copies are a normal and a
-- reverse holo, which one sits in the line is her decision, and not inventing her decisions is this
-- migration's entire justification. Ambiguous pairs join the other 3 as hers to attach from the Lines
-- page's "not in a line yet" list (UIL-056).
--
-- BOTH SIDES, ONE STATEMENT SET. `line_slot.copy_id` and `copy.line_slot_id` are one fact stored twice,
-- which is what #151 established; writing one without the other is the very defect being repaired here.
--
-- IDEMPOTENT for the same structural reason as 0010: the predicate requires `state = 'placeholder'`,
-- `copy_id is null` and `line_slot_id is null`, so its own output no longer matches it. Zero rows
-- against Production's empty tables at cutover.
--
-- Expected effect on Testing: 3 pairs. The 8 null-pointer copies become 5; `line_slot` filled 19 → 22,
-- placeholder 12 → 9; `copy` unchanged at 706. IF IT RELINKS 5, SOMETHING WENT WRONG RATHER THAN WELL —
-- that would mean the ambiguity guard did not hold.
--
-- TWO CORRECTIONS THAT BELONG WITH 0010, which is applied and therefore frozen — so they live here,
-- in the file a reader of 0010 meets next. Both are in 0010's line 30:
--
--     "(about 4 of which render as HUNTING — the Dragonair report, UIL-063)"
--
-- 1. THE ATTRIBUTION IS WRONG. That report resolved to no defect at all: no Dragonair copy exists and
--    the slot in question was a correct placeholder. The phrase attaches a real repair to a false
--    example, and it had already misled two sessions before it was caught. 0010's actual cause was an
--    override clearing a copy's `line_slot_id` without vacating the slot that named it.
--
-- 2. "ABOUT 4 ... RENDER AS HUNTING" WAS NEVER TRUE, and it describes a state that could not exist yet.
--    When 0010 was written, NONE of the 8 rendered HUNTING, because none had a placeholder naming its
--    card. The 5 that do now are a CONSEQUENCE of 0010 itself: releasing those stale slots re-exposed
--    each slot's original `target_catalog_card_id`, which is the very thing that makes this migration
--    possible (see above). So a comment attached to 0010 describes an effect of running 0010.
--
--    The tell is inside 0010's own paragraph: two lines below that clause it states that measurement
--    showed ZERO of the 8 have an intended placeholder to re-attach to. Both cannot be true — if none
--    had a placeholder naming it, none could read as HUNTING for that card. A future reader who spots
--    the contradiction should trust the ZERO and disregard the "about 4"; it was an estimate written as
--    though it were a measurement, which is the part worth not repeating.

-- Candidate pairs: a placeholder slot and a shelved back-half copy that agree on the card, and whose
-- line agrees with the copy on both binder and colour band.
with candidate as (
  select
    s.id   as slot_id,
    c.id   as copy_id,
    s.target_catalog_card_id as card_id,
    l.binder_id,
    l.color_band
  from line_slot s
  join evolution_line l on l.id = s.line_id
  join copy c
    on c.catalog_card_id = s.target_catalog_card_id
   and c.owner_id        = s.owner_id
   and c.binder_id       = l.binder_id
   and c.color_band      = l.color_band
  where s.state   = 'placeholder'
    and s.copy_id is null
    and s.target_catalog_card_id is not null
    and c.role          = 'shelved'
    and c.binder_half   = 'back'
    and c.line_slot_id is null
),
-- Unambiguous in BOTH directions: exactly one candidate copy for that slot, and exactly one candidate
-- slot for that copy. Anything else is skipped entirely rather than guessed.
unambiguous as (
  select slot_id, copy_id
  from candidate
  where slot_id in (select slot_id from candidate group by slot_id having count(*) = 1)
    and copy_id in (select copy_id from candidate group by copy_id having count(*) = 1)
)
update line_slot s
set state   = 'filled',
    copy_id = u.copy_id
from unambiguous u
where s.id = u.slot_id;

-- The copy side of the same fact. Recomputed from the slots just filled rather than from a second
-- evaluation of the predicate, so the two halves cannot disagree even if the data shifted underneath.
update copy c
set line_slot_id = s.id
from line_slot s
where s.copy_id = c.id
  and s.state = 'filled'
  and c.line_slot_id is null;
