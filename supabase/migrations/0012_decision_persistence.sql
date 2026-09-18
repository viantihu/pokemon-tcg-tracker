-- 0012_decision_persistence — a resolved line decision must stay resolved, and its audit row must
-- name the slot it was about (UIL-078).
--
-- Build contract: docs/dev-spec.md §4 (migrations are FORWARD-ONLY and ordered; RLS on every table).
-- Additive — 0001–0011 are FROZEN (applied to live prod + testing); never edit them
-- (docs/devops-strategy.md §6, dev-spec §4).
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
--   1. line_slot.resolved_decision_kind / resolved_decision_choice — the BEHAVIOURAL marker, on the
--      thing the decision is about. State lives in state; audit history can be pruned, replayed or
--      archived without ever changing what she gets asked. Both nullable: most slots have never had a
--      decision to resolve. Kind AND choice, not a bare boolean — a boolean would suppress a question
--      that has genuinely become a different one (a materially changed situation must still ask); kind
--      lets the loader recognise "this exact question" specifically, and choice is stored alongside it
--      for the same precision even though the loader's suppression check only needs kind. NOT written
--      for `leave-it` (resurfaces by design) or for a choice that hands off to a different decision
--      (`block-instead`, `no-line`, `make-line-anyway` — those move the slot/line into a shape a
--      DIFFERENT trigger matches, which is a fresh question, not the same one answered twice).
--
--   2. placement_decision.line_id / line_slot_id — pure traceability, fixing a separate defect found
--      while tracing this one: today a line decision's audit row cannot be traced back to the slot it
--      was about at all, only informally through the `reason` text. `applyDecision` already has both
--      ids in hand at write time. Nothing reads these columns back to decide behaviour — that is
--      exactly the mistake (1) avoids repeating.

alter table line_slot
  add column resolved_decision_kind text,
  add column resolved_decision_choice text;

alter table placement_decision
  add column line_id uuid references evolution_line (id) on delete set null,
  add column line_slot_id uuid references line_slot (id) on delete set null;

comment on column line_slot.resolved_decision_kind is
  'The DecisionCard.kind she last resolved for this slot (e.g. "ex-only-cap", "collection-vs-line"), when the choice was one that should stop deriveDecisions from re-asking it (UIL-078). NULL if never resolved, or if the last choice was a hand-off/leave-it. Never cleared by audit-history maintenance — see placement_decision.line_slot_id for why this lives here and not there.';
comment on column line_slot.resolved_decision_choice is
  'The DecisionChoiceId she picked alongside resolved_decision_kind — stored for precision/audit even though suppression only checks the kind. NULL under the same conditions as resolved_decision_kind.';
comment on column placement_decision.line_id is
  'The line a line-screen decision was about, for traceability only (UIL-078). Never read back to decide behaviour — see line_slot.resolved_decision_kind for where that lives, and UIL-042 for why it does not live here.';
comment on column placement_decision.line_slot_id is
  'The slot a line-screen decision was about, for traceability only (UIL-078). Same rule as line_id: audit only, never load-bearing.';
