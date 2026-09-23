-- 0019_release_foreign_locale_targets — one-time repair: release placeholder targets that name a card
-- from the OTHER regional variant than the line they sit in (UIL-090).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive and DATA-ONLY — 0001–0018 are FROZEN; never edit them (docs/devops-strategy.md §6, dev-spec §4).
--
-- WHY THIS EXISTS. An English and a Japanese printing of one species are two different cards with two
-- placements (docs/sync-architecture.md L5), and a line belongs to one of them. `rankAlternates` chose a
-- placeholder's target from the WHOLE catalog, so an English line could be given a Japanese card to hunt.
-- Measured on Testing 2026-09-22: of 60 `line_slot` rows, 22 carry a `ja:` target, while every slotted
-- copy is English — so 22 English lines are chasing Japanese cards.
--
-- The code fix (same PR) stops new ones, and it is NOT enough on its own: `lib/line/load.ts` reads
-- `const chosen = targetCc ?? alt[0]`, so a STORED target wins over the freshly-ranked alternates and
-- those 22 slots would keep displaying the Japanese card forever.
--
-- WHY RELEASING RATHER THAN RE-TARGETING, which is 0010's precedent in its own words: "Re-attaching would
-- invent a placement decision on her behalf; releasing records what is already true." Re-pointing would
-- need the ranking rule (cheapest standard, else specialty, tie-break by id, with the type→band map and
-- `is_digital_only`) re-implemented in SQL — a second definition of a rule that lives in TypeScript, which
-- is the drift that produced UIL-012. Releasing needs none of it: after the fix the slot immediately shows
-- the locale-correct cheapest printing from `altOptions`, which is computed at load and not stored, with
-- the priced alternates beneath it, so nothing renders blank and she can pick another (UIL-057).
--
-- NOTHING OF HERS IS DISCARDED. `line_slot.target_catalog_card_id` is written ONLY when a slot is inserted,
-- from the engine's plan; a target she chooses herself is recorded on the WISHLIST row
-- (`wishlistUpsertFor` → `insert_wishlist.chosen_catalog_card_id`), which this does not touch. So all 22
-- are engine output, not decisions.
--
-- THE PREDICATE, and why it cannot invert. A line's locale is derived from its FILLED COPIES ONLY — the
-- cards she physically owns — and never from a target, because in a mixed line the target is precisely the
-- thing that is wrong: deriving from "the lowest slot's card" would let a Japanese target at stage 0 declare
-- an otherwise-English line Japanese and release the ENGLISH targets instead. `lineLocaleOf`
-- (lib/engine/line.ts) applies the SAME precedence at runtime, so the app and this repair cannot disagree.
-- A line with no filled copy is left untouched: no evidence, no change.
--
-- Symmetric (it would equally release an `en` target inside a `ja` line — zero such rows today),
-- idempotent (a released row no longer matches), and affects nothing on Production's empty `line_slot`.
--
-- Expected row effect on Testing: 22.

update line_slot
set target_catalog_card_id = null
where state = 'placeholder'
  and target_catalog_card_id is not null
  and exists (
    -- The line holds at least one copy, so its locale is knowable.
    select 1
    from line_slot sib
    join copy c on c.id = sib.copy_id
    where sib.line_id = line_slot.line_id
  )
  and (target_catalog_card_id like 'ja:%') <> (
    -- The locale of the line's LOWEST-stage filled copy: 'ja:%' or not.
    select c.catalog_card_id like 'ja:%'
    from line_slot sib
    join copy c on c.id = sib.copy_id
    where sib.line_id = line_slot.line_id
    order by sib.stage_index
    limit 1
  );
