"use client";

/**
 * Haul placement plan — the core daily screen (scr-plan; dev-spec §5 M6; system-design §7B).
 *
 * Flow: the cards waiting in her haul → run the M3 cascade over them → a placement plan GROUPED to
 * mirror the physical sort (band in rainbow order → basics vs non-basics → name A–Z), worked
 * top-to-bottom, each card written atomically on the server the moment she presses Done.
 *
 * ONE WAY CARDS ARRIVE HERE (UIL-098 part 2): her Dex import. The draft is SEEDED from `initialPending`
 * — every copy that exists but has never been placed, which is the state sync leaves its additions in on
 * purpose (sync-ui-spec §B.6's "Place new cards" handoff). Every row carries its `existingCopyId`, so
 * Done places the copy sync already created. This screen used to take cards in by hand too (a source,
 * notes and an add-by-set-number-or-name form); that is gone, because a copy made here belonged to no
 * presence group, so the next import could not see it and created a SECOND one when Dex listed the card.
 * The queue is read on the server (./page.tsx) so the cards are there in the first paint;
 * `reloadPending` re-reads it after a sitting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Leaf import, NOT the "@/lib/plan" barrel: this is a client component, and the barrel re-exports
// ./session, which pulls lib/supabase/server (and `next/headers`) into the browser bundle. The
// `import type` below is fine because types are erased; a VALUE import is not.
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { progressPips } from "@/lib/plan/progress";
import type {
  BandMismatchChoice,
  LineAfterWrite,
  PlanBandGroup,
  PlanItem,
  ProposedPull,
} from "@/lib/plan";
import type { BlockNeedCandidate, MoveDestination, MoveOptions } from "@/lib/line/types";
import type { LineJoinOptions } from "@/lib/line/join-options";
// Leaf import of the pure move module (its only dependency is ./types; the `WriteOp` it names is a
// type-only import), so bringing `describeMove` into the browser bundle drags in no server code.
import { describeMove, moveNameLookups, type MoveNameLookups } from "@/lib/line/move";
import { cardTag, localeOfId, stripLocaleNamespace } from "@/lib/catalog/locale";
import { BandChip } from "../_components/BandChip";
import { NoBinderNotice } from "../_components/NoBinderNotice";
import { CardFace } from "../_components/CardFace";
import { cardCaption } from "../_components/CardLightbox";
import { ProgressBar } from "../_components/ProgressBar";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { RemoveCopyButton } from "../_components/RemoveCopyButton";
import { isUnreached, LOST, reach } from "../_components/reach";
import { ACTION_META, bandMeta, moveMeta } from "../_components/plan-meta";
import { removeCopy } from "../look/actions";
import {
  shelveCardAction,
  getLineJoinOptions,
  getMoveOptions,
  loadArrivals,
  loadPendingPlacementDraft,
  planStateStamp,
  refreshSpotlightAction,
  runHaulPlan,
} from "./actions";
import type { DraftCard, DraftPayloadItem, RunPlanResult } from "./plan-types";
import { createArrivalWatch } from "./arrivals";
import { HaulSearch, type HaulSearchTile } from "./HaulSearch";
import {
  createRerouteBatcher,
  dropFromPlan,
  flattenPlan,
  mergeReroute,
  type MovedCard,
} from "./reroute";
import type { LineChoice, LinePopupModel, LineProposal } from "@/lib/line/popup";
import { lineModelAction } from "../_components/line-popup-actions";
import { PlanLinePopup } from "./PlanLinePopup";
import { sameLineWaiting, type WaitingHaulCard } from "@/lib/plan/line-done";

/* ------------------------- resuming a plan in progress (UIL-006) ------------------------- */

const RESUME_KEY = "binderops.plan.v1";

/**
 * A run in progress, parked so navigating away does not throw it out.
 *
 * `stamp` is the server's stamp of everything the cascade read (lib/plan/fingerprint.ts). It is what
 * makes resuming safe rather than merely convenient: if anything the plan depends on has moved, the
 * stamp differs and the cache is dropped instead of showing a plan computed against stale state.
 *
 * Stored in sessionStorage, not localStorage: a plan is a working session at the binder, and a
 * month-old one resurfacing would be noise. The draft rides along too, since the plan's rows are keyed
 * by draft id and the two are only meaningful together.
 */
interface ResumeState {
  stamp: string;
  draft: DraftCard[];
  /**
   * Null when she has a draft but has not run the plan yet (UIL-092). A blob parked by a build before
   * UIL-098 part 2 may also carry `haulId`, `source` and `notes`; they are ignored.
   */
  plan: RunPlanResult | null;
  /** Check-off progress — the part whose loss actually hurts, mid-stack at the binder. */
  done: string[];
  cur: number;
  overrides: Record<string, MoveDestination>;
  /**
   * Band keys she has folded away (UIL-018). Rides in this payload for the same reason `done` does:
   * she bounces to Lines to resolve a decision and comes back, and re-folding six finished bands
   * every time would make the feature useless in the one workflow it exists for.
   *
   * It is deliberately NOT part of `stamp`. The stamp is a digest of DB state (lib/plan/fingerprint.ts)
   * and folding a band changes nothing the cascade read, so putting it there would throw away a
   * perfectly good plan — the exact failure UIL-006 was fixed twice for. Client-only view state
   * cannot reach the stamp anyway: it is computed on the server.
   */
  collapsed: string[];
  /**
   * Sub-group ("BASICS" / "STAGE 1 · 2") keys she has folded away (UIL-075), each `${bandKey}:${kind}`.
   * Rides here for the same reason `collapsed` does and is out of `stamp` for the same reason too.
   * OPTIONAL: a plan parked by a build before UIL-075 has no such field, and its absence must read as
   * "nothing folded" rather than throw — the same forward-compat `collapsed` itself already relies on.
   */
  collapsedSubgroups?: string[];
}

/** Stable fold key for one sub-group. A band key is `[a-z_]+`, so a `:` cannot collide with one. */
/**
 * The row badge for a card headed into a back half (UIL-117, v3 section 1): green, yellow, pink. It names the line by
 * its top stage, as v3 and the popup do ("＋ Starts Charizard line"); a replace stays generic.
 */
function lineBadgeText(kind: LineProposal["kind"], lineName: string | null): string {
  // The symbol and its verb never part (a no-break space): on a phone the badge wraps after the verb (UX review).
  if (kind === "start")
    return lineName ? `＋\u00a0Starts ${lineName} line` : "＋\u00a0Starts a line";
  if (kind === "add") return lineName ? `◆\u00a0Adds to ${lineName} line` : "◆\u00a0Adds to a line";
  return "⇄\u00a0Could replace a card";
}

/** The worklist row's element id, so "Search haul" can scroll to it (UIL-115). */
function planRowDomId(incomingId: string): string {
  return `plan-row-${incomingId}`;
}

/**
 * The collection a specialty card will join (UIL-053): her pick while it is still one of its binder's
 * collections, else the binder's ONLY collection (the Senior BA's ruling: pre-selected only when there is
 * exactly one), else none, and she picks before Done. Null for any card that joins no collection.
 */
export function pickedCollection(item: PlanItem, chosen: Record<string, string>): string | null {
  const pick = item.collectionPick;
  if (!pick) return null;
  const c = chosen[item.incomingId];
  if (c && pick.collections.some((x) => x.id === c)) return c;
  return pick.collections.length === 1 ? pick.collections[0].id : null;
}

export function subgroupKey(bandKey: string, kind: "basic" | "nonbasic"): string {
  return `${bandKey}:${kind}`;
}

/**
 * What was parked, and whether the PLAN in it is still trustworthy (UIL-092).
 *
 * A plan computed against state that has since moved is worthless — that is what the stamp is for, and
 * UIL-006 was fixed twice for showing one. Drift is reported rather than acted on here, so `restoreDraft`
 * can re-read the draft from the queue instead of the whole blob going in the bin.
 */
interface ParkedRun {
  state: ResumeState;
  /** False when the DB has moved under the parked run: the plan is stale, and the draft is re-read. */
  stampMatches: boolean;
}

/** A parked plan from before UIL-117: a back-half card on it carries no line proposal. */
function predatesLineProposals(plan: RunPlanResult | null | undefined): boolean {
  if (!plan) return false;
  return plan.groups.some((g) =>
    g.subgroups.some((s) =>
      s.rows.some(
        (r) =>
          (r.action === "FILL" || r.action === "NEWLINE" || r.action === "SWAP") &&
          !("lineProposal" in r),
      ),
    ),
  );
}

function readResume(stamp: string): ParkedRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeState;
    // A shape we do not recognise is unusable and cannot be salvaged. Drift is NOT that: it is reported,
    // and the blob is left in place for `restoreDraft` to re-read.
    if (!parsed || !Array.isArray(parsed.draft)) {
      window.sessionStorage.removeItem(RESUME_KEY);
      return null;
    }
    // A plan parked before UIL-117 has back-half cards with no line proposal, so it cannot ask her about them:
    // route it again (the Senior BA's ruling: once, on deploy; nothing she shelved is lost, it is written).
    return {
      state: parsed,
      stampMatches: parsed.stamp === stamp && !predatesLineProposals(parsed.plan),
    };
  } catch {
    // Corrupt entry, quota error, or storage disabled — never break the screen over a cache.
    return null;
  }
}

/**
 * The draft to open with (UIL-092 part 1, narrowed by UIL-098 part 2).
 *
 * Exported and pure so the rule is testable without a browser. Every row is backed by a copy in her haul,
 * so every row is DERIVED state:
 *
 *  - When the stamp holds, the parked draft is kept as it was, order and all.
 *  - When it does not, each parked row is re-read from `initialPending` and dropped if it is no longer
 *    there: the copy may have been placed, or removed, since she parked. Her parked ORDER is preserved,
 *    with rows new since she parked appended — she works a physical stack in the order it sits, and
 *    re-sorting it mid-sitting would cost her her place.
 *
 * A row with no copy behind it is a card she typed on a build before UIL-098 part 2. It cannot be placed
 * any more (the server refuses it), so it is dropped either way, and handed back as `droppedTyped` so the
 * screen can NAME it rather than lose it silently: the fix for such a card is to add it in Dex and import.
 */
export function restoreDraft(
  parked: ParkedRun | null,
  initialPending: DraftCard[],
): { draft: DraftCard[]; droppedTyped: DraftCard[] } {
  if (!parked) return { draft: initialPending, droppedTyped: [] };
  // Parsed from storage, so a legacy row may lack the field its type now requires.
  const droppedTyped = parked.state.draft.filter((d) => !d.existingCopyId);
  const backed = parked.state.draft.filter((d) => !!d.existingCopyId);
  if (parked.stampMatches) return { draft: backed, droppedTyped };
  const pendingById = new Map(initialPending.map((p) => [p.id, p]));
  const kept: DraftCard[] = [];
  for (const row of backed) {
    const fresh = pendingById.get(row.id);
    if (fresh) kept.push(fresh);
  }
  const keptIds = new Set(kept.map((d) => d.id));
  return {
    draft: [...kept, ...initialPending.filter((p) => !keptIds.has(p.id))],
    droppedTyped,
  };
}

function writeResume(state: ResumeState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    // Full or unavailable storage just means no resume; the plan itself is unaffected.
  }
}

function clearResume(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* nothing to do */
  }
}

/** The draft as the server actions want it — drops the display payload, keeps the routing link. */
function toPayload(draft: DraftCard[]): DraftPayloadItem[] {
  return draft.map((d) => ({
    id: d.id,
    tcgdexId: d.card.tcgdexId,
    variant: d.variant,
    existingCopyId: d.existingCopyId,
  }));
}

/**
 * Why a run did not produce a plan. `runHaulPlan` throws for a server failure as well as for a call that never
 * reached it, so this names no cause; a run writes nothing, so running it again is safe (UIL-106).
 */
export const RUN_FAILED = "Could not run the plan. Reload the page and run it again.";

/** Why a card taken off the plan did not re-route the others; the plan she has stays usable (UIL-114). */
export const REROUTE_FAILED =
  "The rest of the plan could not be updated. Its homes may be out of date; reload the page to route it again.";

/**
 * The arrivals check has failed twice running (UIL-114 follow-up, the Senior BA's wording). Most likely the
 * app was redeployed under an open tab, so the check calls an action that no longer exists and would fail
 * quietly forever: new cards would stop arriving with no word. One quiet note, not an error every 30 s;
 * it goes on the next check that works.
 */
export const ARRIVALS_LOST = "Can't check for new cards right now. Reload the page to get them.";

/** "Leave for later" (UIL-114; the Senior BA's wording): off this plan, still waiting, nothing deleted. */
export const LEAVE_FOR_LATER = "Leave for later";
export const LEAVE_FOR_LATER_HINT =
  "Takes it off this plan. It stays waiting in your haul; nothing is deleted.";

export function PlanScreen({
  initialPending = [],
  stateStamp = "",
}: {
  initialPending?: DraftCard[];
  stateStamp?: string;
}) {
  // Read once, during the first render, so a resumed plan is there in the first paint rather than
  // flashing an empty form and swapping. Safe in a lazy initializer: no effect, no cascading render.
  const [parked] = useState<ParkedRun | null>(() => readResume(stateStamp));
  /**
   * The parked run, but only as far as it is still TRUSTWORTHY (UIL-092).
   *
   * Everything derived from DB state — the plan, the overrides she set against it, her cursor, her folds —
   * reads from here, so a stamp mismatch drops all of it. The draft is re-read by `restoreDraft`.
   */
  const resumed = parked?.stampMatches ? parked.state : null;
  const [restored] = useState(() => restoreDraft(parked, initialPending));

  const [draft, setDraft] = useState<DraftCard[]>(restored.draft);
  const [plan, setPlan] = useState<RunPlanResult | null>(resumed?.plan ?? null);
  // Whether the plan CURRENTLY on screen is the restored one. `resumed` stays non-null for the life of
  // the component, so using it directly would keep claiming "resumed" after she re-runs.
  const [planIsResumed, setPlanIsResumed] = useState(resumed?.plan != null);
  /**
   * Routing the haul (UIL-114: there is no first screen, so the page routes what is waiting as soon as it
   * opens). Starts TRUE when there is something to route and no sitting to resume, so the route below is
   * kicked off by state rather than by a setState in an effect. A resumed sitting whose stamp matches never
   * re-routes: its plan is still true, and routing her full haul costs seconds.
   */
  const [running, setRunning] = useState(() => !resumed?.plan && restored.draft.length > 0);
  /** A background re-route after a card left the plan (UIL-114); the plan stays usable meanwhile. */
  const [updating, setUpdating] = useState(false);
  /** Waiting cards whose home the last re-route changed, named so none moves silently. */
  const [moved, setMoved] = useState<MovedCard[] | null>(null);
  /**
   * Cards that arrived while the page was open (UIL-114 part C), badged "New" until shelved, and named with
   * their homes until she dismisses the note. Not parked: "New" means new while she was looking.
   */
  const [arrived, setArrived] = useState<Set<string>>(() => new Set());
  const [joined, setJoined] = useState<MovedCard[] | null>(null);
  /** Two arrivals checks in a row could not reach the server: say so, once (ARRIVALS_LOST). */
  const [checksLost, setChecksLost] = useState(false);
  /** A card picked in "Search haul" (UIL-115), for the scroll to its row; `n` re-scrolls a repeat pick. */
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  /**
   * The stamp the parked run is keyed to. Shelving a card changes the copy count, which is part of the
   * stamp by design (UIL-006), so without rolling it forward the resume cache would be thrown away on
   * every Done click — halfway through a stack, which is exactly when losing it hurts.
   */
  const [liveStamp, setLiveStamp] = useState(resumed?.stamp ?? stateStamp);
  /** The card currently being written, so only its own control shows a pending state. */
  const [shelving, setShelving] = useState<string | null>(null);
  /**
   * The spotlight card, RE-DERIVED against current state (UIL-045).
   *
   * The worklist's rows all come from one cascade run that never advanced between cards, so any card
   * interacting with an earlier card in the same haul shows a stale pocket. The write re-derives, so it
   * silently disagrees — and she reads the screen to decide which physical pocket to use, which makes a
   * stale row a wrong shelf that nothing ever contradicts.
   *
   * Only the spotlight card is refreshed: it is the one whose accuracy moves a physical card. Keyed by
   * draft id so a stale in-flight response cannot overwrite a newer card's answer.
   */
  const [fresh, setFresh] = useState<{
    id: string;
    item: PlanItem | null;
    digest: string | null;
    proposedPulls: ProposedPull[];
    bandMismatch: BandMismatchChoice | null;
  } | null>(null);
  /**
   * Her collection for a specialty card whose binder holds collections (UIL-053), by draft id. Starts
   * empty: no collection is a default, except a binder's only one (`pickedCollection`).
   */
  const [collectionChoice, setCollectionChoice] = useState<Record<string, string>>({});
  /** The card whose line popup is open (UIL-117), by draft id; nothing is written until she confirms. */
  const [linePop, setLinePop] = useState<string | null>(null);
  /**
   * UIL-126: "⇄ Swap this one into the line…" on a plain extra copy opens the popup on THIS replace, Swap picked. Not a
   * line card, so it is not in the step-through: set only by that button, cleared whenever the popup closes.
   */
  const [swapInto, setSwapInto] = useState<LineProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Cards she typed by hand on a build before UIL-098 part 2, found in her parked sitting. They cannot be
   * placed any more, so they were dropped — and are named once, here, rather than vanishing (UIL-092's
   * rule: her input is never lost silently).
   */
  const [droppedTyped, setDroppedTyped] = useState<DraftCard[]>(restored.droppedTyped);
  const [cur, setCur] = useState(resumed?.cur ?? 0);
  /**
   * Cards already SHELVED — written to the database, not merely ticked (UIL-027). Every id in here is
   * a committed `apply_write_ops` call. It still drives the pips, the counts and the cursor, but it is
   * now a record of writes rather than a worklist aid, which is the whole of her complaint.
   */
  const [done, setDone] = useState<Set<string>>(() => new Set(resumed?.done ?? []));
  // Folded band sections (UIL-018). Everything expanded is the default: a fresh plan should look like
  // the plan, and the screen is worked top-to-bottom so the first band she needs is already open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(resumed?.collapsed ?? []));
  // Folded sub-groups within a band (UIL-075) — the finer level under the band fold. Same default and
  // same resume treatment as `collapsed`; keyed by `${bandKey}:${kind}` via `subgroupKey`.
  const [collapsedSubgroups, setCollapsedSubgroups] = useState<Set<string>>(
    () => new Set(resumed?.collapsedSubgroups ?? []),
  );
  // Placement overrides (M7): draft id → chosen destination, applied at commit (cascade skipped).
  const [overrides, setOverrides] = useState<Record<string, MoveDestination>>(
    resumed?.overrides ?? {},
  );
  const [moveOptions, setMoveOptions] = useState<MoveOptions | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTargetCard | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Pending-placement queue (UIL-003). Seeded from the server render, then re-read after a commit.
  const [pendingState, setPendingState] = useState<"loading" | "ready">("ready");

  /**
   * Park the run whenever it changes. Writing to sessionStorage is exactly what an effect is for — syncing
   * React state out to an external system — and it sets no state, so it cannot cascade.
   *
   * PARKED WITH OR WITHOUT A PLAN (UIL-092 part 1): a bare draft is parked too, and the only state that
   * clears the key is having genuinely nothing to keep.
   */
  useEffect(() => {
    if (!plan && draft.length === 0) {
      clearResume();
      return;
    }
    writeResume({
      stamp: liveStamp,
      draft,
      plan,
      done: [...done],
      cur,
      overrides,
      collapsed: [...collapsed],
      collapsedSubgroups: [...collapsedSubgroups],
    });
  }, [liveStamp, draft, plan, done, cur, overrides, collapsed, collapsedSubgroups]);

  // The override DESTINATION TEXT (e.g. "Binder 1 · Back · Green") needs the move options' name maps,
  // which `openMove` loads lazily. But a RESUMED plan (UIL-006) can carry overrides she set last
  // sitting with the panel never opened this one, so the options are absent exactly when there is
  // something to label (UIL-037). Load them once when overrides exist and we have not already. The
  // short chip label degrades gracefully without them (`moveMeta` reads only the destination kind), so
  // a failed load shows the right KIND of destination while missing only its proper name.
  useEffect(() => {
    if (moveOptions || Object.keys(overrides).length === 0) return;
    let live = true;
    getMoveOptions()
      .then((opts) => {
        if (live) setMoveOptions(opts);
      })
      .catch(() => {
        /* Chip still resolves from the destination alone; the sentence falls back to the suggestion. */
      });
    return () => {
      live = false;
    };
  }, [overrides, moveOptions]);

  /** Re-read the queue and seed the draft from it. Only ever called from an event handler. */
  const reloadPending = useCallback(() => {
    setPendingState("loading");
    loadPendingPlacementDraft()
      .then((rows) => {
        // Only seed when nothing is in progress, so a re-read never discards the sitting she is working.
        setDraft((cur) => (cur.length === 0 ? rows : cur));
        // And route it straight away: there is no first screen to press "Run the plan" on (UIL-114).
        if (rows.length > 0) setRunning(true);
      })
      .catch(() => {
        setError("Could not load the cards waiting to be placed.");
      })
      .finally(() => setPendingState("ready"));
  }, []);

  function flashToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  async function openMove(item: PlanItem) {
    let opts = moveOptions;
    if (!opts) {
      try {
        opts = await getMoveOptions();
        setMoveOptions(opts);
      } catch {
        setError("Could not load the placement options.");
        return;
      }
    }
    // The lines this card could join (UIL-070 part 1) — the same offer the Line screen makes a
    // stranded card, so back half is a real choice here too, not the dead end UIL-070 named. Absent
    // (a Trainer, or the lookup failed) the panel simply has no picker: the plain move still works.
    let join: Awaited<ReturnType<typeof getLineJoinOptions>> = null;
    try {
      join = await getLineJoinOptions(item.tcgdexId);
    } catch {
      /* no picker; MovePanel greys the back half and names the Lines page instead */
    }
    const gen = opts.binders.find((b) => b.type === "general");
    const existing = overrides[item.incomingId];
    setMoveTarget(
      moveTargetFor(
        item,
        join,
        existing ??
          (gen
            ? { kind: "shelf", binderId: gen.id, half: "front", band: item.bandKey }
            : undefined),
        plan?.blockNeeds,
      ),
    );
  }

  function onMoveConfirm(dest: MoveDestination) {
    if (!moveTarget) return;
    setOverrides((prev) => ({ ...prev, [moveTarget.copyId]: dest }));
    flashToast(`Placement override set · ${moveTarget.name}`);
    setMoveTarget(null);
  }
  /**
   * "I do not have this card" — remove the COPY from the app (UIL-089), from the plan she is working
   * (UIL-114: there is no first screen to do it from). "Leave for later" beside it means something different
   * and both are needed: it takes the card off this plan and leaves it waiting; this deletes the copy.
   */
  async function notMine(item: PlanItem) {
    const row = draft.find((d) => d.id === item.incomingId);
    if (!row) return;
    setError(null);
    setShelving(row.id);
    // Through `reach`: a call that never answers must still clear `shelving`, or `shelveCard` refuses every
    // Done after it with no word (UIL-106).
    const res = await reach(() => removeCopy(row.existingCopyId), LOST.action);
    setShelving(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // The copy it stood for is gone, so it leaves the plan, and the rest re-routes around it.
    takeOffPlan(row.id);
    flashToast(`Removed · ${item.name}`);
  }

  /**
   * Route the haul (UIL-114). Runs whenever `running` turns true: on opening the page with cards waiting and
   * no sitting to resume, after "Start a new haul", and on "Try again". Every setState is in the reply, not
   * in the effect body, so the effect cannot cascade a render. The draft is the one standing when routing
   * starts; a later change to it is a re-route's business, not this one's.
   */
  useEffect(() => {
    if (!running) return;
    let live = true;
    const toRoute = draft;
    void Promise.all([
      reach(() => runHaulPlan(toPayload(toRoute)), RUN_FAILED),
      reach(() => planStateStamp(toRoute.map((d) => d.existingCopyId)), RUN_FAILED),
    ]).then(([result, stamp]) => {
      if (!live) return;
      setRunning(false);
      if (isUnreached(result)) {
        setError(result.error);
        return;
      }
      setError(null);
      setPlan(result);
      setPlanIsResumed(false);
      setLiveStamp(isUnreached(stamp) ? stateStamp : stamp);
      setCur(0);
      setDone(new Set());
      // A new run is new work: nothing is finished yet, so nothing should arrive folded.
      setCollapsed(new Set());
      setCollapsedSubgroups(new Set());
      setCollectionChoice({});
      setMoved(null);
      // A fresh route is fresh work: nothing on it is "new" against anything.
      setArrived(new Set());
      setJoined(null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- routes the draft standing when `running` turns on
  }, [running]);

  /**
   * The latest screen state, for a re-route that finishes after she has moved on: it merges into what is on
   * screen THEN, not what was on screen when it started. Written after every render, which is what an effect
   * is for; nothing reads it during render.
   */
  const latest = useRef({ draft, done, plan, cur });
  useEffect(() => {
    latest.current = { draft, done, plan, cur };
  });

  /**
   * Re-route the cards still waiting, after one left the plan (UIL-114). The server routes them again
   * against everything she has shelved; `mergeReroute` keeps her shelved cards as they were, keeps the
   * spotlight on the card it was on, and names any waiting card whose home changed. A failure leaves the
   * plan she has, which is still usable, and says so.
   */
  async function reroute(): Promise<void> {
    const at = latest.current;
    if (!at.plan) return;
    const waiting = at.draft.filter((d) => !at.done.has(d.id));
    if (waiting.length === 0) return;
    setUpdating(true);
    const [res, stamp] = await Promise.all([
      reach(() => runHaulPlan(toPayload(waiting)), REROUTE_FAILED),
      reach(() => planStateStamp(waiting.map((d) => d.existingCopyId)), REROUTE_FAILED),
    ]);
    setUpdating(false);
    if (isUnreached(res)) {
      setError(REROUTE_FAILED);
      return;
    }
    const now = latest.current;
    if (!now.plan) return;
    // A card she took off while this ran stays off: route only what is still in the draft.
    const inDraft = new Set(now.draft.map((d) => d.id));
    const gone = new Set(
      flattenPlan(res)
        .map((it) => it.incomingId)
        .filter((id) => !inDraft.has(id)),
    );
    const {
      plan: next,
      moved: changed,
      added,
    } = mergeReroute(now.plan, dropFromPlan(res, gone), now.done);
    const spotId = flattenPlan(now.plan)[now.cur]?.incomingId;
    const flat = flattenPlan(next);
    const at2 = spotId ? flat.findIndex((it) => it.incomingId === spotId) : -1;
    setPlan(next);
    setCur(at2 >= 0 ? at2 : Math.min(now.cur, Math.max(flat.length - 1, 0)));
    // Anything she ticked was against a derivation that no longer exists (UIL-061, UIL-069).
    setFresh(null);
    if (!isUnreached(stamp)) setLiveStamp(stamp);
    setMoved(changed.length > 0 ? changed : null);
    // Arrivals (UIL-114 part C): badged, and named with where they go, so none joins silently.
    if (added.length > 0) {
      setArrived((prev) => new Set([...prev, ...added.map((a) => a.incomingId)]));
      setJoined((prev) => [...(prev ?? []), ...added]);
    }
  }
  const rerouteRef = useRef(reroute);
  useEffect(() => {
    rerouteRef.current = reroute;
  });
  // Made on first use, in an event handler, so no ref is read while rendering.
  const batcher = useRef<ReturnType<typeof createRerouteBatcher> | null>(null);
  useEffect(() => () => batcher.current?.cancel(), []);
  function scheduleReroute() {
    batcher.current ??= createRerouteBatcher(() => rerouteRef.current());
    batcher.current.schedule();
  }
  /**
   * Cards she took off the plan this sitting ("Leave for later", "Not mine"). A left card is still waiting
   * on the server, so the arrivals check must be told about it or it would come straight back.
   */
  const takenOff = useRef<Set<string>>(new Set());
  /** Arrivals checks that could not reach the server, in a row. */
  const failedChecks = useRef(0);

  /**
   * Look for cards that arrived while the page was open (UIL-114 part C): an import finished in another
   * tab, or on her phone. AUTOMATIC, per the ruling: they join the draft and the next re-route places them,
   * badged "New", and the spotlight stays on the card in her hand. A check that cannot reach the server
   * says nothing; the next one tries again.
   */
  async function checkArrivals(): Promise<void> {
    const at = latest.current;
    // Cards in hand but no plan: the page is routing them (an arrival would miss the route in flight and
    // be stranded), or a failed route is waiting on her "Try again". Routing only ever runs with no plan.
    if (!at.plan && at.draft.length > 0) return;
    const known = [...at.draft.map((d) => d.existingCopyId), ...takenOff.current];
    const res = await reach(() => loadArrivals(known), LOST.read);
    if (isUnreached(res)) {
      failedChecks.current += 1;
      if (failedChecks.current >= 2) setChecksLost(true);
      return;
    }
    failedChecks.current = 0;
    setChecksLost(false);
    const now = latest.current;
    const held = new Set([...now.draft.map((d) => d.existingCopyId), ...takenOff.current]);
    const rows = res.filter((r) => !held.has(r.existingCopyId));
    if (rows.length === 0) return;
    setDraft((d) => [...d, ...rows]);
    // Nothing was open: route them, as the page does when it opens with cards waiting.
    if (!now.plan) setRunning(true);
    else scheduleReroute();
  }
  const checkRef = useRef(checkArrivals);
  useEffect(() => {
    checkRef.current = checkArrivals;
  });
  useEffect(() => {
    const watch = createArrivalWatch(() => checkRef.current());
    watch.start();
    return () => watch.stop();
  }, []);

  /**
   * Take a card off the plan now, and re-route the rest shortly (batched: see ./reroute.ts). Used by
   * "Not mine" once its copy is gone, and by "Leave for later", which deletes nothing.
   */
  function takeOffPlan(id: string) {
    if (!plan) return;
    const next = dropFromPlan(plan, new Set([id]));
    setDraft((d) => d.filter((x) => x.id !== id));
    setPlan(next);
    // The next card slides into the spotlight; the cursor stays put unless it ran off the end.
    setCur((c) => Math.min(c, Math.max(flattenPlan(next).length - 1, 0)));
    const omit = <T,>(m: Record<string, T>) => {
      if (!(id in m)) return m;
      const out = { ...m };
      delete out[id];
      return out;
    };
    setOverrides(omit);
    setCollectionChoice(omit);
    takenOff.current.add(id);
    scheduleReroute();
  }

  /** "Leave for later" (UIL-114): off this plan, still waiting in her haul, nothing deleted. */
  function leaveForLater(item: PlanItem) {
    takeOffPlan(item.incomingId);
    flashToast(`Left for later · ${item.name}`);
  }

  /**
   * Shelve ONE card, now (UIL-027). This is what "Done" means: the placement is written before the
   * cursor moves, so the database matches the binder she just put the card in. There is no batch step
   * afterwards and no undo — a misplacement is corrected with Move, like any other card in her
   * collection (her call).
   *
   * A card that fails stays unshelved and stays on the page, which is the correct end state: "any card
   * that has not received a location should still appear on that haul plan page".
   */
  async function shelveCard(
    item: PlanItem,
    /** From the line popup (UIL-117): her line choice, or her "file by its own colour" destination. */
    extra?: { lineChoice?: LineChoice; override?: MoveDestination },
  ): Promise<false | { lineDone: boolean; line?: LineAfterWrite }> {
    if (done.has(item.incomingId) || shelving) return false;
    const entry = draft.find((d) => d.id === item.incomingId);
    if (!entry) return false;

    setError(null);
    setShelving(item.incomingId);
    try {
      const res = await reach(
        () =>
          shelveCardAction({
            card: {
              id: entry.id,
              tcgdexId: entry.card.tcgdexId,
              variant: entry.variant,
              existingCopyId: entry.existingCopyId,
            },
            override: extra?.override ?? overrides[item.incomingId] ?? null,
            // Everything not yet shelved stays queued, so the returned stamp describes what we hold next.
            pendingCopyIds: draft
              .filter((d) => !done.has(d.id) && d.id !== item.incomingId)
              .map((d) => d.existingCopyId),
            // Only when we hold a fresh derivation FOR THIS CARD (UIL-045). Sending the stale forecast's
            // digest would conflict on every interacting card; sending none keeps the old behaviour.
            expectedDigest: fresh?.id === item.incomingId ? fresh.digest : null,
            // Her choice in the line popup for a card headed into a line (UIL-117). Pulls, a colour question and
            // a replace all live in the popup now; an override names its own destination and needs none.
            lineChoice: overrides[item.incomingId] ? null : (extra?.lineChoice ?? null),
            // Her collection for a specialty card (UIL-053). An override names its own destination.
            collectionChoice: overrides[item.incomingId]
              ? null
              : pickedCollection(
                  (fresh?.id === item.incomingId && fresh.item) || item,
                  collectionChoice,
                ),
          }),
        LOST.action,
      );
      if (!res.ok) {
        // Never reached the server (UIL-106): not a refusal, so her override is KEPT (UIL-084 below).
        if ("unreached" in res) {
          setError(res.error);
          return false;
        }
        // The placement moved under her. Nothing was written; show the new one and let her look
        // again rather than reporting a failure for something that is working correctly.
        if (res.changed) {
          // A conflict re-derives server-side, so its pull proposal (and any colour mismatch) may
          // differ too; drop the stale tick list and pick rather than carrying consent across a
          // placement that changed underneath it.
          setFresh({
            id: item.incomingId,
            item: res.fresh,
            digest: res.freshDigest,
            proposedPulls: [],
            bandMismatch: null,
          });
          setError(res.error);
          return false;
        }
        /**
         * THE SERVER REFUSED THIS PLACEMENT, so her override was never written and must not survive
         * (UIL-084). It is what the row's chip, the spotlight's tag and the PARKED SESSION all read
         * from, so keeping it left the screen promising a destination the server had rejected — and
         * surviving a reload, which is why her refusal reproduced instead of clearing. Dropped here,
         * on the one path a refusal comes back, so the row falls back to the cascade's own destination
         * and she can pick again.
         *
         * Only on a RETURNED refusal, never on the `unreached` branch above: a transport failure is not the
         * server rejecting her pick, and throwing her choice away for a dropped connection would be
         * its own small data loss.
         */
        const refused = overrides[item.incomingId];
        if (refused) {
          setOverrides((prev) => {
            const next = { ...prev };
            delete next[item.incomingId];
            return next;
          });
        }
        setError(
          refused
            ? `${res.error} Your manual placement was not saved — pick a destination again.`
            : res.error,
        );
        return false;
      }
      // Roll the cache forward rather than letting the write invalidate it (see shelveCardAction).
      setLiveStamp(res.stamp);
      setDone((prev) => new Set(prev).add(item.incomingId));
      return { lineDone: res.lineDone === true, ...(res.line ? { line: res.line } : {}) };
    } finally {
      setShelving(null);
    }
  }

  function resetAll() {
    setDraft([]);
    setPlan(null);
    setDone(new Set());
    setCollapsed(new Set());
    setCollapsedSubgroups(new Set());
    setCur(0);
    setError(null);
    setOverrides({});
    setCollectionChoice({});
    setMoveTarget(null);
    setPlanIsResumed(false);
    setLiveStamp(stateStamp);
    // A new haul: anything left for later is back in the queue it is about to re-read.
    takenOff.current = new Set();
    // The parked run is spent: it was committed, or she chose to start over.
    clearResume();
    // Re-read the queue: what we just placed is gone from it, and anything she pulled off the draft
    // is still waiting. Runs after the draft is cleared so the seed is not skipped as "in progress".
    reloadPending();
  }

  const flatItems = useMemo<PlanItem[]>(
    () => (plan ? plan.groups.flatMap((g) => g.subgroups.flatMap((s) => s.rows)) : []),
    [plan],
  );
  const flatIndex = useMemo(() => {
    const m = new Map<string, number>();
    flatItems.forEach((it, i) => m.set(it.incomingId, i));
    return m;
  }, [flatItems]);

  // UIL-117: the line card whose popup is open, its place among the haul's line cards, and its model loader.
  const lineCards = flatItems.filter((it) => it.lineProposal);
  const popItem = linePop ? (flatItems.find((it) => it.incomingId === linePop) ?? null) : null;
  // The card's FRESH derivation once it is in (UIL-045): the popup opens on its proposal, never the forecast's.
  // A refresh that failed leaves `item` null, and the forecast stands in.
  const popFresh = popItem && fresh?.id === popItem.incomingId ? fresh : null;
  const popLive = popFresh ? (popFresh.item ?? popItem) : null;
  const popProposal = popLive ? (swapInto ?? popLive.lineProposal ?? null) : null;
  const popCopyId = popItem
    ? (draft.find((d) => d.id === popItem.incomingId)?.existingCopyId ?? null)
    : null;
  const loadLineModelFor = useCallback(
    async (copyId: string, proposal: LineProposal): Promise<LinePopupModel> => {
      const res = await reach(() => lineModelAction(copyId, proposal), LOST.action);
      if (!res.ok) throw new Error(res.error);
      return res.model;
    },
    [],
  );

  /** What "Search haul" matches on beyond the plan item: the set's name and her Dex's variant (UIL-115). */
  const cardInfo = useMemo(
    () =>
      new Map(
        draft.map((d) => [
          d.id,
          { setName: d.card.setName ?? null, dexVariantRaw: d.dexVariantRaw ?? null },
        ]),
      ),
    [draft],
  );

  /**
   * A card picked in "Search haul" (UIL-115): it becomes the spotlight card, its band and sub-group unfold if
   * she had folded them, and its row scrolls into view (the effect below, once the unfold has rendered).
   */
  function revealCard(id: string) {
    const i = flatIndex.get(id);
    if (i === undefined || !plan) return;
    setCur(i);
    for (const g of plan.groups) {
      const sub = g.subgroups.find((s) => s.rows.some((r) => r.incomingId === id));
      if (!sub) continue;
      const band = g.bandKey;
      const key = subgroupKey(band, sub.kind);
      setCollapsed((prev) =>
        prev.has(band) ? new Set([...prev].filter((k) => k !== band)) : prev,
      );
      setCollapsedSubgroups((prev) =>
        prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev,
      );
    }
    setReveal((r) => ({ id, n: (r?.n ?? 0) + 1 }));
  }
  // Scrolling is a DOM side effect after render, which is what an effect is for; it sets no state.
  useEffect(() => {
    if (!reveal) return;
    document
      .getElementById(planRowDomId(reveal.id))
      ?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [reveal]);

  // Name maps for override destination sentences (UIL-037), null until the move options have loaded.
  const overrideNames = useMemo<MoveNameLookups | null>(
    () =>
      moveOptions
        ? {
            ...moveNameLookups(moveOptions),
            // UIL-030: a block override's sentence names the line ("Block · CHARMANDER LINE · …").
            lineLabel: (lineId: string) =>
              plan?.blockNeeds?.find((n) => n.lineId === lineId)?.speciesLabel ?? null,
          }
        : null,
    [moveOptions],
  );

  /**
   * Re-derive the spotlight card whenever the cursor lands on one (UIL-045).
   *
   * Skipped entirely until something has been shelved this sitting: before the first Done, nothing has
   * moved, so the forecast IS current and a round trip would buy nothing. Skipped for an overridden card
   * too — her destination is written verbatim, so it cannot drift.
   *
   * Syncing to an external system (the server's view of placement) is what an effect is for. The
   * response is keyed by draft id and discarded if the cursor has moved on, so an out-of-order reply
   * cannot show one card's pocket on another card.
   */
  const spotlightId = flatItems[cur]?.incomingId ?? null;
  // A plain extra copy too (UIL-126): its "Swap this one into the line…" opens on the fresh derivation.
  const spotIsLineCard = !!flatItems[cur]?.lineProposal || !!flatItems[cur]?.extraCopyOf;
  useEffect(() => {
    // No setState on this path, deliberately: a stale entry is IGNORED at the point of use (it is
    // keyed by draft id and every reader checks the key), so clearing it here would be a cascading
    // render for no observable difference.
    // A line card is re-derived from the very first card (UIL-117): its pulls and colour question live on the
    // fresh derivation, and before this the first card of a sitting was shelved with neither on screen.
    if (!spotlightId || (done.size === 0 && !spotIsLineCard) || overrides[spotlightId]) return;
    const entry = draft.find((d) => d.id === spotlightId);
    if (!entry) return;
    let live = true;
    refreshSpotlightAction({
      card: {
        id: entry.id,
        tcgdexId: entry.card.tcgdexId,
        variant: entry.variant,
        existingCopyId: entry.existingCopyId ?? null,
      },
    })
      .then((res) => {
        if (!live) return;
        // An entry is recorded even when the call FAILED (`item: null`), because "we have an answer
        // for this card" is what the in-flight indicator is derived from — without it a failure would
        // leave "Checking…" on screen forever. A failed refresh keeps showing the forecast, which is
        // still the best available answer and is labelled as an estimate.
        setFresh({
          id: spotlightId,
          item: res.ok ? res.item : null,
          digest: res.ok ? res.digest : null,
          proposedPulls: res.ok ? res.proposedPulls : [],
          bandMismatch: res.ok ? res.bandMismatch : null,
        });
      })
      .catch(() => {
        if (live) {
          setFresh({
            id: spotlightId,
            item: null,
            digest: null,
            proposedPulls: [],
            bandMismatch: null,
          });
        }
      });
    return () => {
      live = false;
    };
    // `done` in full rather than `done.size`: its identity changes on every shelve, and re-deriving
    // then is exactly right — a card was just written, which is the event that can move this card's
    // pocket. The guard above still skips the whole thing before the first Done.
    // `plan` too: a re-route clears `fresh` (UIL-061/069), so the card in her hand is re-derived against it.
  }, [spotlightId, spotIsLineCard, done, draft, overrides, plan]);

  /** Fold / unfold one band (UIL-018). Same shape as `toggleDone` — a set of keys, not a flag map. */
  function toggleCollapse(bandKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bandKey)) next.delete(bandKey);
      else next.add(bandKey);
      return next;
    });
  }
  /**
   * Fold / unfold one sub-group (UIL-075). Keyed by `${bandKey}:${kind}` so BASICS in Red is not the
   * same key as BASICS in Green — she can fold one without the other, and reopening the same band
   * later leaves the sub-groups exactly as she left them.
   */
  function toggleSubgroupCollapse(bandKey: string, kind: "basic" | "nonbasic") {
    const key = subgroupKey(bandKey, kind);
    setCollapsedSubgroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  /** The next line card after this one that is not shelved yet, wrapping round; the step-through's one rule. */
  /** The cards still waiting in this haul, other than this one, as the step-through reads them (UIL-120). */
  function waitingHaulCards(exceptId: string): WaitingHaulCard[] {
    return flatItems
      .filter((it) => it.incomingId !== exceptId && !done.has(it.incomingId))
      .map((it) => ({
        id: it.incomingId,
        dexIds: it.dexIds ?? [],
        locale: localeOfId(it.tcgdexId),
      }));
  }

  /**
   * The next card for THIS line, after this one in the plan, wrapping round (UIL-120, Karvi 2026-09-27: "Confirm &
   * next" never opens another line's card by itself). The line is the server's read of it after her write.
   */
  function nextSameLineCard(afterId: string, line: LineAfterWrite): PlanItem | undefined {
    const same = new Set(sameLineWaiting(line.openDexIds, line.locale, waitingHaulCards(afterId)));
    const after = flatItems.slice((flatIndex.get(afterId) ?? -1) + 1);
    return [...after, ...flatItems].find((it) => same.has(it.incomingId));
  }

  /**
   * UIL-117: open a line card's popup. The spotlight follows it, so the card she is deciding is the one in her hand,
   * and its fresh derivation (which carries any colour question) is the one the popup reads. The move options load
   * once, for the replace view's pickers.
   */
  function openLinePopup(item: PlanItem, swap: LineProposal | null = null) {
    const i = flatIndex.get(item.incomingId);
    if (i !== undefined) setCur(i);
    setError(null);
    setLinePop(item.incomingId);
    setSwapInto(swap);
    if (!moveOptions) {
      getMoveOptions()
        .then(setMoveOptions)
        .catch(() => {
          /* the replace pickers fall back to the bulk box and the front half */
        });
    }
  }

  function closeLinePopup() {
    setLinePop(null);
    setSwapInto(null);
  }

  /** UIL-126: the spotlight's "⇄ Swap this one into the line…" on a plain extra copy, off its fresh derivation. */
  function openSwapIntoLine(item: PlanItem) {
    const x = ((fresh?.id === item.incomingId && fresh.item) || item).extraCopyOf;
    if (!x) return;
    openLinePopup(item, {
      kind: "replace",
      lineId: x.lineId,
      slotId: x.slotId,
      defaultKeep: false,
    });
  }

  /**
   * Her confirm in the line popup, then "Confirm & next": the next line card in the plan that is not shelved yet
   * opens straight away, so a big haul is one pass rather than a hunt (v3 section 1). A refusal keeps the popup
   * open with the reason in it.
   *
   * EXCEPT when the line her confirm concerned is DONE (UIL-120): nothing left in it to chase, which includes a Keep or
   * a Swap on a line that was already complete and a line whose only unfilled stage is a block (`lineDoneFor`). Karvi:
   * "Once the line is complete, it should not open the popup again for the next card automatically." The popup closes
   * and she stays on the plan; the next line card waits for her tap. It is the server's answer, read after the write.
   */
  async function confirmLinePopup(
    item: PlanItem,
    extra: { lineChoice?: LineChoice; override?: MoveDestination },
    /**
     * `lineName`: the line's name as the popup shows it (its top stage), for the "Line closed" toast. `stepOn` false:
     * the swap on a plain extra copy (UIL-126), never in the step-through, so nothing opens after it and no stop needs
     * explaining.
     */
    opts: { lineName?: string | null; stepOn?: boolean } = {},
  ) {
    const shelved = await shelveCard(item, extra);
    if (!shelved) return;
    if (opts.stepOn === false) {
      if (extra.lineChoice) scheduleReroute();
      closeLinePopup();
      advance();
      return;
    }
    // A line write can change what the other cards would do (a card that would have started this line now joins
    // it), so the rest re-route and their badges follow; the batch runs a moment later, as for any change.
    if (extra.lineChoice) scheduleReroute();
    // "Confirm & next" opens only the next card for THIS line (UIL-120, her ruling); a closed line has none.
    const next =
      !shelved.lineDone && shelved.line
        ? nextSameLineCard(item.incomingId, shelved.line)
        : undefined;
    if (next) {
      openLinePopup(next);
      return;
    }
    // A confirm that does not lead on says why, so the popup closing reads as a finish (UX review of #402).
    if (shelved.lineDone) {
      flashToast(opts.lineName ? `Line closed · ${opts.lineName} line` : "Line closed");
    } else if (shelved.line) {
      flashToast(
        opts.lineName
          ? `That's every card you have for the ${opts.lineName} line`
          : "That's every card you have for this line",
      );
    }
    closeLinePopup();
    advance();
  }

  function advance() {
    let i = cur + 1;
    while (i < flatItems.length && done.has(flatItems[i].incomingId)) i++;
    setCur(Math.min(i, Math.max(flatItems.length - 1, 0)));
  }

  return (
    <>
      {error && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{error}</b>
        </div>
      )}

      {droppedTyped.length > 0 ? (
        <DroppedTypedNotice rows={droppedTyped} onDismiss={() => setDroppedTyped([])} />
      ) : null}

      {checksLost ? (
        <div className="alertbar" role="status">
          <span>↻</span>
          <b>{ARRIVALS_LOST}</b>
        </div>
      ) : null}

      {/* UIL-127a: a new account's first import arrives before any binder exists. Nothing can be placed yet. */}
      {plan?.noBinders ? <NoBinderNotice /> : null}

      {running ? (
        // UIL-114: no first screen. The page routes what is waiting as it opens; routing her full haul takes
        // a few seconds (UIL-008), so the bar says what is happening rather than showing an empty page.
        <div className="entry panel">
          <ProgressBar label={`Routing ${draft.length} card${draft.length === 1 ? "" : "s"}…`} />
        </div>
      ) : !plan ? (
        <EmptyHaul
          waiting={draft.length}
          loading={pendingState === "loading"}
          onRetry={() => setRunning(true)}
        />
      ) : (
        <PlanView
          plan={plan}
          flatItems={flatItems}
          flatIndex={flatIndex}
          cur={cur}
          setCur={setCur}
          done={done}
          shelveCard={shelveCard}
          shelving={shelving}
          fresh={fresh}
          onOpenLine={openLinePopup}
          onSwapIntoLine={openSwapIntoLine}
          collectionChoice={collectionChoice}
          onPickCollection={(draftId, collectionId) =>
            setCollectionChoice((prev) => ({ ...prev, [draftId]: collectionId }))
          }
          advance={advance}
          onReset={resetAll}
          onNotMine={notMine}
          onLeaveForLater={leaveForLater}
          updating={updating}
          moved={moved}
          onDismissMoved={() => setMoved(null)}
          arrived={arrived}
          joined={joined}
          onDismissJoined={() => setJoined(null)}
          cardInfo={cardInfo}
          onSearchPick={revealCard}
          overrides={overrides}
          overrideNames={overrideNames}
          onMove={openMove}
          resumed={planIsResumed}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          toggleCollapse={toggleCollapse}
          collapsedSubgroups={collapsedSubgroups}
          toggleSubgroupCollapse={toggleSubgroupCollapse}
        />
      )}

      {popItem && popCopyId && !popLive ? (
        // Until the card's fresh derivation is in: the plan's forecast is per card, so it can be stale by now
        // (Charmander just started the line Charmeleon's forecast would start again), and the fresh one also
        // carries any colour question.
        <div className="lp-overlay">
          <div className="lp-pop panel" role="dialog" aria-label="Line">
            <div className="u rp-hint" role="status">
              Opening its line…
            </div>
            <button type="button" className="btn" onClick={closeLinePopup}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {popLive && popProposal && popCopyId ? (
        <PlanLinePopup
          // A changed proposal is a different popup (UX review of #392).
          key={`${popLive.incomingId}:${JSON.stringify(popProposal)}`}
          item={{ ...popLive, lineProposal: popProposal }}
          extraCopy={!!swapInto}
          copyId={popCopyId}
          moveOptions={moveOptions}
          loadModelFor={loadLineModelFor}
          bandMismatch={popFresh?.bandMismatch ?? null}
          position={
            swapInto
              ? undefined
              : {
                  index: lineCards.findIndex((it) => it.incomingId === popLive.incomingId) + 1,
                  total: lineCards.length,
                }
          }
          // " · next ▶" only when confirming really opens another card for this line (UIL-120; UX review of #392).
          waiting={waitingHaulCards(popLive.incomingId)}
          busy={shelving === popLive.incomingId}
          error={error}
          onConfirm={(choice, lineName) =>
            // On the swap for a plain extra copy (UIL-126), Keep is her normal Done: the front half, no line choice.
            swapInto && choice.mode === "replace" && choice.keep
              ? void confirmLinePopup(popLive, {}, { stepOn: false })
              : void confirmLinePopup(
                  popLive,
                  { lineChoice: choice },
                  swapInto ? { stepOn: false } : { lineName },
                )
          }
          onConfirmOwnColour={(dest) => void confirmLinePopup(popLive, { override: dest })}
          onCancel={closeLinePopup}
        />
      ) : null}

      {moveTarget && moveOptions ? (
        <MoveOverlay
          card={moveTarget}
          options={moveOptions}
          // No `allowLineJoin` here on purpose: MoveOverlay derives it from `card.joinCandidates`,
          // which `moveTargetFor` threads from the line-join lookup (UIL-070 part 1). One signal,
          // owned by the component that renders the picker, so a call site cannot drop it.
          onConfirm={onMoveConfirm}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}

      {toast ? (
        <div className="toast on" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}

/* --------------------------------- intake --------------------------------- */

/**
 * Cards she had typed by hand, parked from a build before UIL-098 part 2, that this screen can no longer
 * place. Named rather than dropped silently — a typed row existed nowhere else, so this is the last place
 * she can see what it was (UIL-092's rule). The remedy is the same one the server's refusal gives.
 */
export function DroppedTypedNotice({
  rows,
  onDismiss,
}: {
  rows: DraftCard[];
  onDismiss: () => void;
}) {
  return (
    <div className="alertbar" role="status" style={{ marginBottom: 12 }}>
      <span>!</span>
      <b>
        {rows.length} card{rows.length === 1 ? "" : "s"} you typed in by hand{" "}
        {rows.length === 1 ? "was" : "were"} taken off this plan:{" "}
        {rows.map((r) => r.card.name).join(", ")}.
      </b>
      <span style={{ fontSize: 11, color: "var(--ink-2)", flexBasis: "100%" }}>
        The Haul Plan now places only cards from your Dex import. If you own{" "}
        {rows.length === 1 ? "it" : "them"}, add {rows.length === 1 ? "it" : "them"} in Dex, then
        import on the Sync page.
      </span>
      <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}

/**
 * The Haul Plan with nothing routed (UIL-114: there is no first screen). Either nothing is waiting, which
 * says where cards come from, or the route failed, which offers to try again (the error above says why).
 */
function EmptyHaul({
  waiting,
  loading,
  onRetry,
}: {
  waiting: number;
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="entry panel">
        <p style={{ fontSize: 11, color: "var(--ink-2)" }}>
          Checking for cards waiting to be placed…
        </p>
      </div>
    );
  }
  if (waiting > 0) {
    return (
      <div className="entry panel">
        <p style={{ fontSize: 12, lineHeight: 1.8 }}>
          {waiting} card{waiting === 1 ? " is" : "s are"} waiting, but the plan could not be routed.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 10 }}
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="entry panel">
      {/* UIL-098 part 2: there is no add form, so the empty state says where cards come from. */}
      <p style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
        Nothing is waiting to be placed. Cards arrive here from your Dex import: add them in Dex,
        then import on the Sync page, and they are routed here to your physical sort.
      </p>
    </div>
  );
}

/* ---------------------------------- plan ---------------------------------- */

/**
 * The Move panel's card for a plan row (UIL-070 part 1). PURE and exported so the wiring the Plan's
 * picker depends on is unit-pinned: `join` present (even with no candidates) puts `joinCandidates` on
 * the card, which is what turns MoveOverlay's line-first flow on; null (a Trainer, or the lookup
 * failed) leaves it absent and the panel plain. `copyId` carries the DRAFT id — no copy exists yet —
 * because the override map is keyed by it.
 */
export function moveTargetFor(
  item: PlanItem,
  join: LineJoinOptions | null,
  initial: MoveDestination | undefined,
  /** UIL-030: the plan's open block needs; attached only when the engine offered THIS card as a block. */
  blockNeeds?: BlockNeedCandidate[],
): MoveTargetCard {
  return {
    ...(item.offerBlockRepurpose && (blockNeeds ?? []).length > 0 ? { blockNeeds } : {}),
    copyId: item.incomingId,
    tcgdexId: item.tcgdexId,
    name: item.name,
    localId: item.localId,
    setCardCountOfficial: item.setCardCountOfficial,
    imageUrl: item.imageUrl ?? null,
    bandKey: item.bandKey,
    currentLabel: item.destination,
    joinCandidates: join?.joinCandidates,
    existingLines: join?.existingLines,
    naturalBandKey: join?.naturalBandKey,
    initial,
  };
}

/**
 * What to SHOW for a card: the destination she overrode to, or — absent an override — the cascade's
 * own suggestion (UIL-037). One function so the spotlight panel and the worklist row cannot disagree
 * with each other about where a card is going, which is the whole of the reported bug.
 *
 * The short `label`/`color` come from `moveMeta`, which reads only the destination KIND, so the chip
 * is right even before the name maps have loaded. The long `destination` sentence needs those maps
 * (`describeMove`); until they arrive it falls back to the suggestion text rather than showing a
 * half-resolved label with raw ids in it.
 */
function displayFor(
  item: PlanItem,
  override: MoveDestination | undefined,
  names: MoveNameLookups | null,
): { big: string; label: string; color: string; dark?: boolean; destination: string } {
  if (override) {
    const m = moveMeta(override);
    return {
      big: m.big,
      label: m.label,
      color: m.color,
      dark: m.dark,
      destination: names ? describeMove(override, names) : item.destination,
    };
  }
  const act = ACTION_META[item.action];
  return {
    big: act.big,
    label: act.label,
    color: act.color,
    dark: act.dark,
    destination: item.destination,
  };
}

function PlanView(props: {
  plan: RunPlanResult;
  flatItems: PlanItem[];
  flatIndex: Map<string, number>;
  cur: number;
  setCur: (i: number) => void;
  done: Set<string>;
  /** Writes ONE card now; resolves true when it was shelved (UIL-027). */
  /** Truthy once written; `lineDone` says the line it concerned has nothing left to chase (UIL-120). */
  shelveCard: (item: PlanItem) => Promise<false | { lineDone: boolean; line?: LineAfterWrite }>;
  /** Draft id of the card mid-write, so only its own control shows a pending state. */
  shelving: string | null;
  /** The spotlight card re-derived against current state, keyed by draft id (UIL-045). */
  fresh: {
    id: string;
    item: PlanItem | null;
    digest: string | null;
    proposedPulls: ProposedPull[];
    bandMismatch: BandMismatchChoice | null;
  } | null;
  /** Open a line card's popup (UIL-117): from its badge, its row box, or Done in the spotlight. */
  onOpenLine: (item: PlanItem) => void;
  /** UIL-126: "⇄ Swap this one into the line…" on a plain extra copy. */
  onSwapIntoLine: (item: PlanItem) => void;
  /** Her collection for a specialty card whose binder holds collections, by draft id (UIL-053). */
  collectionChoice: Record<string, string>;
  onPickCollection: (draftId: string, collectionId: string) => void;
  advance: () => void;
  onReset: () => void;
  /** "Not mine" from the spotlight (UIL-114): deletes the copy, then the plan re-routes around it. */
  onNotMine: (item: PlanItem) => void;
  /** "Leave for later" from the spotlight (UIL-114): off this plan, still waiting, nothing deleted. */
  onLeaveForLater: (item: PlanItem) => void;
  /** A background re-route is running; the plan stays usable meanwhile (UIL-114). */
  updating: boolean;
  /** Waiting cards whose home the last re-route changed. */
  moved: MovedCard[] | null;
  onDismissMoved: () => void;
  /** Cards that arrived while the page was open (UIL-114 part C): badged "New" until shelved. */
  arrived: Set<string>;
  /** The arrivals the plan has placed, named with their homes until dismissed. */
  joined: MovedCard[] | null;
  onDismissJoined: () => void;
  /** The set name and Dex variant of each card, by draft id, for "Search haul" (UIL-115). */
  cardInfo: Map<string, { setName: string | null; dexVariantRaw: string | null }>;
  /** A card picked in "Search haul": spotlight it and scroll to its row. */
  onSearchPick: (incomingId: string) => void;
  overrides: Record<string, MoveDestination>;
  /** Name maps for override destination sentences (UIL-037); null until options load. */
  overrideNames: MoveNameLookups | null;
  onMove: (item: PlanItem) => void;
  /** True when this plan was restored from a parked run rather than just computed (UIL-006). */
  resumed: boolean;
  /** Band keys currently folded away (UIL-018). */
  collapsed: Set<string>;
  setCollapsed: (next: Set<string>) => void;
  toggleCollapse: (bandKey: string) => void;
  /** Sub-group keys currently folded away (UIL-075), each `${bandKey}:${kind}`. */
  collapsedSubgroups: Set<string>;
  toggleSubgroupCollapse: (bandKey: string, kind: "basic" | "nonbasic") => void;
}) {
  const {
    plan,
    flatItems,
    flatIndex,
    cur,
    setCur,
    done,
    shelveCard,
    shelving,
    fresh,
    onOpenLine,
    onSwapIntoLine,
    collectionChoice,
    onPickCollection,
    advance,
    onReset,
    onNotMine,
    onLeaveForLater,
    updating,
    moved,
    onDismissMoved,
    arrived,
    joined,
    onDismissJoined,
    cardInfo,
    onSearchPick,
    overrides,
    overrideNames,
    onMove,
    resumed,
    collapsed,
    setCollapsed,
    toggleCollapse,
    collapsedSubgroups,
    toggleSubgroupCollapse,
  } = props;

  /**
   * UIL-019: the haul bar is now sticky, and the band heads stick too — at `top: 0` each, they would
   * overlap and the bar would cover #78's fold controls. So the bar's real height is published as
   * `--haulbar-h` and the band heads offset by it. Measured rather than assumed a constant: the bar is
   * `flex-wrap`, so it is one row on a desktop and two or three on a phone.
   *
   * A ResizeObserver, not a one-off read: the height changes when the bar wraps on rotate/resize, and
   * when the card count crosses a digit. Writes a CSS property through a ref — a DOM side effect, no
   * setState, so it cannot cascade renders.
   */
  const haulbarRef = useRef<HTMLDivElement | null>(null);

  /**
   * UIL-125: on a phone the spotlight is not pinned (pinned, it covered more than half the screen), so it scrolls
   * away while she works the list. Picking a card from the list puts it in her hand, so it brings the spotlight back
   * into view when its top has scrolled under the pinned haul bar. The row's own box and badge still act in place.
   */
  const spotRef = useRef<HTMLElement | null>(null);
  function selectFromList(i: number) {
    setCur(i);
    const spot = spotRef.current;
    if (!spot || !window.matchMedia?.("(max-width: 720px)").matches) return;
    const barBottom = haulbarRef.current?.getBoundingClientRect().bottom ?? 0;
    if (spot.getBoundingClientRect().top < barBottom) {
      spot.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }
  useEffect(() => {
    const el = haulbarRef.current;
    if (!el) return;
    // On the ROOT, not on the bar: the band heads are in a sibling subtree, and a custom property
    // only inherits downward. Setting it on `.haulbar` would publish it to nothing that needs it.
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--haulbar-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    publish();
    // ResizeObserver AND a viewport listener, deliberately. Verified in a browser: at 375px the bar
    // wraps from 69px to 115px, and the observer alone did NOT re-publish — which left the band heads
    // stuck at the old offset and HIDDEN behind the bar, on a phone, which is where this is a PWA.
    // Rather than rely on working out why the observer missed it, also listen to the event that
    // certainly fires.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    ro?.observe(el);
    window.addEventListener("resize", publish);
    window.addEventListener("orientationchange", publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publish);
      window.removeEventListener("orientationchange", publish);
      // Leaving a stale height behind would offset band heads on a later visit with a shorter bar.
      root.style.removeProperty("--haulbar-h");
    };
  }, []);

  const total = flatItems.length;
  const doneCount = flatItems.filter((it) => done.has(it.incomingId)).length;
  // "Search haul" (UIL-115): every card on the plan, shelved ones too, described as its row describes it.
  const searchEntries: HaulSearchTile[] = flatItems.map((it) => ({
    item: it,
    setName: cardInfo.get(it.incomingId)?.setName ?? null,
    dexVariantRaw: cardInfo.get(it.incomingId)?.dexVariantRaw ?? null,
    done: done.has(it.incomingId),
    destination: displayFor(it, overrides[it.incomingId], overrideNames).destination,
  }));

  /* ---- band folding (UIL-018) ----
     Per-band check-off counts. A folded band is otherwise opaque: its rows are gone from the tree, so
     without a count on the header she cannot tell a finished band from one she has not started. Same
     O(total) walk the `doneCount` line above already does, and it recomputes on the same renders. */
  const doneByBand = new Map<string, number>();
  for (const g of plan.groups) {
    let n = 0;
    for (const sub of g.subgroups) {
      for (const it of sub.rows) if (done.has(it.incomingId)) n += 1;
    }
    doneByBand.set(g.bandKey, n);
  }
  // "Settled" = nothing left to do here: every row checked off, or the band is a reserved zero.
  const settled = plan.groups
    .filter((g) => g.count === 0 || (doneByBand.get(g.bandKey) ?? 0) >= g.count)
    .map((g) => g.bandKey);
  const curBandKey = flatItems[cur]?.bandKey ?? null;

  /**
   * Her three states for the cards in THIS sitting, in her own words (UIL-088): a card is in the haul
   * until she places it, and then it is in a binder or in the bulk box. `done` is the written set
   * (UIL-027), so "in haul" is simply what she has not got to yet — no new read, and it cannot disagree
   * with the queue, which is the same fact from the other side.
   */
  const placedByKind = flatItems.reduce(
    (acc, it) => {
      if (!done.has(it.incomingId)) return acc;
      const over = overrides[it.incomingId];
      const toBulk = over ? over.kind === "bulk" : it.action === "BULK" || it.action === "SWAP";
      return toBulk ? { ...acc, bulk: acc.bulk + 1 } : { ...acc, binder: acc.binder + 1 };
    },
    { binder: 0, bulk: 0 },
  );
  const haulCounts = `In haul ${total - doneCount} · In a binder ${placedByKind.binder} · In the bulk box ${placedByKind.bulk}`;

  const a = plan.summary.byAction;
  const back = (a.FILL ?? 0) + (a.NEWLINE ?? 0) + (a.PULL ?? 0);
  const destSummary = `Front ${a.FRONT ?? 0} · Back ${back} · Specialty ${a.SPEC ?? 0} · Bulk ${
    (a.BULK ?? 0) + (a.SWAP ?? 0)
  }`;

  // Every card in the run is shelved. There is no "commit" left to do — each card was written as she
  // decided it — so this is a finish line, not a gate (UIL-027).
  if (total > 0 && doneCount === total) {
    return (
      <div className="entry panel">
        <div className="alertbar ok" style={{ marginBottom: 12 }}>
          <span>✓</span>
          <b>
            All {total} card{total === 1 ? "" : "s"} shelved.
          </b>
        </div>
        <p style={{ fontSize: 12, lineHeight: 1.9 }}>
          Each one was written as you marked it done, so there is nothing left to save. Anything you
          skip stays on this page until it has a location.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 12 }}
          onClick={onReset}
        >
          Start a new haul
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="haulbar panel" ref={haulbarRef}>
        <span className="hk">HAUL PLAN</span>
        {/* Say so rather than let her wonder whether it recomputed (UIL-006). */}
        {resumed ? (
          <span className="tag" title="Picked up where you left off; nothing has changed since">
            RESUMED
          </span>
        ) : null}
        {updating ? (
          <span
            className="tag"
            role="status"
            title="Re-routing the cards still waiting; keep going"
          >
            Updating…
          </span>
        ) : null}
        <span className="hv">
          {total} card{total === 1 ? "" : "s"}
        </span>
        {/* Bounded pip count (UIL-007): one per card blew the page ~4,800px wide at 685 cards,
            because each pip's 2px borders cannot shrink. Exact below the cap, bucketed above. */}
        <div className="xp" aria-hidden>
          {progressPips(flatItems.map((it) => done.has(it.incomingId))).map((filled, i) => (
            <i key={i} className={filled ? "f" : ""} />
          ))}
        </div>
        <span className="hv">
          {doneCount} / {total}
        </span>
        <span className="hk" style={{ flexBasis: "100%" }}>
          {destSummary}
        </span>
      </div>

      {/* UIL-116: no decisions bar here. Karvi: "completely irrelevant to the user". A card that needs a
          decision still says so on its own row ("Decide") and in the spotlight, and decisions are worked on
          the Lines screen, whose own banner stays. */}

      {moved && moved.length > 0 ? (
        <div className="alertbar" role="status">
          <span>↻</span>
          <b>
            {moved.length} card{moved.length === 1 ? "" : "s"} got a new home after that change:{" "}
            {moved.map((m) => `${m.name} → ${m.destination}`).join(" · ")}
          </b>
          <button
            type="button"
            className="btn sm"
            style={{ marginLeft: "auto" }}
            onClick={onDismissMoved}
          >
            OK
          </button>
        </div>
      ) : null}

      {joined && joined.length > 0 ? (
        <div className="alertbar" role="status">
          <span>+</span>
          <b>
            {joined.length} new card{joined.length === 1 ? "" : "s"} joined the plan:{" "}
            {joined.map((m) => `${m.name} → ${m.destination}`).join(" · ")}
          </b>
          <button
            type="button"
            className="btn sm"
            style={{ marginLeft: "auto" }}
            onClick={onDismissJoined}
          >
            OK
          </button>
        </div>
      ) : null}

      <HaulSearch entries={searchEntries} onPick={onSearchPick} />

      <div className="planwrap">
        <div className="worklist panel">
          {/* Per-band folding is the fine control; these are the bulk ones (UIL-018). At ten bands,
              clearing a finished stack one header at a time is its own chore. Deliberately NOT sticky:
              the document body is the scroll container on this screen (see UIL-019), and a second
              sticky element competing with the band headers would make that worse, not better. */}
          <div className="worktools">
            <span className="hk">BANDS</span>
            <button
              type="button"
              className="btn"
              onClick={() => setCollapsed(new Set(settled))}
              disabled={settled.length === 0}
              title="Fold away every band with nothing left to do"
            >
              Collapse finished · {settled.length}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setCollapsed(new Set(plan.groups.map((g) => g.bandKey)))}
            >
              Collapse all
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setCollapsed(new Set())}
              disabled={collapsed.size === 0}
            >
              Expand all
            </button>
            {/* Say what the list is, once, rather than hedging 685 rows (UIL-045). Only shown once
                something has been shelved, because until then nothing has moved and the forecast is
                exactly current — a standing "these may be wrong" would be false and would train her
                to ignore it. */}
            {done.size > 0 ? (
              <span className="estimate">
                Positions below are from the original run. The card in the spotlight is re-checked
                against your shelves as you reach it.
              </span>
            ) : null}
          </div>
          {plan.groups.map((g) => (
            <BandSection
              key={g.bandKey}
              group={g}
              collapsed={collapsed.has(g.bandKey)}
              onToggleCollapse={() => toggleCollapse(g.bandKey)}
              doneCount={doneByBand.get(g.bandKey) ?? 0}
              holdsCurrent={curBandKey === g.bandKey}
              cur={cur}
              flatIndex={flatIndex}
              done={done}
              onSelect={selectFromList}
              // UIL-053 / UIL-117: a card that joins a collection, or goes into a line, is shelved from the
              // spotlight, where she can see which; its row box brings it there instead of shelving it unseen.
              onShelve={(it) =>
                it.lineProposal && !overrides[it.incomingId]
                  ? onOpenLine(it) // ticked only when she confirms in the popup (the UX Dev's guard)
                  : it.collectionPick && !overrides[it.incomingId]
                    ? selectFromList(flatIndex.get(it.incomingId) ?? cur)
                    : void shelveCard(it)
              }
              onOpenLine={onOpenLine}
              shelving={shelving}
              overrides={overrides}
              overrideNames={overrideNames}
              arrived={arrived}
              collectionChoice={collectionChoice}
              collapsedSubgroups={collapsedSubgroups}
              onToggleSubgroupCollapse={toggleSubgroupCollapse}
            />
          ))}
        </div>

        <aside className="spot panel" ref={spotRef}>
          <div className="cap">
            <span>NOW HANDLING</span>
            <span>{total ? `${Math.min(cur + 1, total)} / ${total}` : "—"}</span>
          </div>
          <div className="body">
            <Spotlight
              item={flatItems[cur]}
              done={flatItems[cur] ? done.has(flatItems[cur].incomingId) : false}
              busy={flatItems[cur] ? shelving === flatItems[cur].incomingId : false}
              onShelve={async () => {
                const item = flatItems[cur];
                if (!item) return;
                // UIL-117: a card headed into a line is decided in its popup, never shelved from here unseen. The
                // fresh derivation decides that when it is in: the plan's forecast is per card and can be stale.
                const live = (fresh?.id === item.incomingId && fresh.item) || item;
                if (live.lineProposal && !overrides[item.incomingId]) return onOpenLine(item);
                // Advance only on a successful write: a card that failed still needs a location, so
                // leaving the cursor on it is the correct behaviour rather than skipping past it.
                if (await shelveCard(item)) advance();
              }}
              lineCard={
                !!flatItems[cur] &&
                !!((fresh?.id === flatItems[cur].incomingId && fresh.item) || flatItems[cur])
                  .lineProposal &&
                !overrides[flatItems[cur].incomingId]
              }
              onBackCard={() => setCur(Math.max(0, cur - 1))}
              onSkip={() => setCur(Math.min(total - 1, cur + 1))}
              onNotMine={() => flatItems[cur] && onNotMine(flatItems[cur])}
              onLeaveForLater={() => flatItems[cur] && onLeaveForLater(flatItems[cur])}
              isNew={flatItems[cur] ? arrived.has(flatItems[cur].incomingId) : false}
              override={flatItems[cur] ? overrides[flatItems[cur].incomingId] : undefined}
              overrideNames={overrideNames}
              blockNeeds={plan.blockNeeds}
              onMove={() => flatItems[cur] && onMove(flatItems[cur])}
              onSwapIntoLine={() => flatItems[cur] && onSwapIntoLine(flatItems[cur])}
              // Only when the reply belongs to the card actually in the spotlight (UIL-045).
              freshItem={
                flatItems[cur] && fresh?.id === flatItems[cur].incomingId ? fresh.item : null
              }
              collectionChoice={collectionChoice}
              onPickCollection={(collectionId) => {
                const id = flatItems[cur]?.incomingId;
                if (id) onPickCollection(id, collectionId);
              }}
              refreshing={
                !!flatItems[cur] &&
                (doneCount > 0 || !!flatItems[cur].lineProposal || !!flatItems[cur].extraCopyOf) &&
                !overrides[flatItems[cur].incomingId] &&
                fresh?.id !== flatItems[cur].incomingId
              }
            />
          </div>
        </aside>
      </div>

      <div className="foot">BAND → BASIC / NON-BASIC → A–Z · WORK TOP TO BOTTOM</div>
      {/* UIL-088: the three states she named, for this sitting. A card is IN HAUL until placed. */}
      <div className="foot u">{haulCounts}</div>
    </>
  );
}

/**
 * One colour band, foldable (UIL-018).
 *
 * WHY IT UNMOUNTS. Karvi's haul was 702 cards, and every row of every band mounted unconditionally.
 * Hiding a folded band with CSS would fix the scrolling and none of the cost — the rows would still be
 * in the tree, still re-render on every check-off, still hold a `CardFace` each (and, since UIL-016,
 * an `<img>` each). So a folded band renders NOTHING below its header. The header stays, because
 * finding the band she is on is the whole point.
 *
 * The header itself is the control rather than a separate caret button: she is standing at a binder
 * with cards in one hand, and a full-width target beats a 20px one. It keeps `.bandhead`'s existing
 * sticky positioning untouched — that rule was already correct and is not re-implemented here.
 */
export function BandSection(props: {
  group: PlanBandGroup;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Rows checked off inside this band — the only progress signal left once it is folded. */
  doneCount: number;
  /** True when the spotlight's current card lives in this band. Surfaced only while folded. */
  holdsCurrent: boolean;
  cur: number;
  flatIndex: Map<string, number>;
  done: Set<string>;
  onSelect: (index: number) => void;
  /** Shelves the card now (UIL-027). No un-shelve: corrections go through Move. */
  onShelve: (item: PlanItem) => void;
  shelving: string | null;
  /** Placement overrides she has set (UIL-037), so a row shows where she moved a card, not the
   *  suggestion. Threaded here because `PlanView` holds the map and the row is two levels down. */
  overrides: Record<string, MoveDestination>;
  /** Name maps for the override destination text; null until options load (UIL-037). */
  overrideNames: MoveNameLookups | null;
  /** Cards that arrived while the page was open (UIL-114 part C). Optional for the render tests. */
  arrived?: Set<string>;
  /** Her collection picks (UIL-053), so a row can say it still needs one. Optional for the render tests. */
  collectionChoice?: Record<string, string>;
  /** Open a line card's popup from its badge (UIL-117). Optional for the render tests. */
  onOpenLine?: (item: PlanItem) => void;
  /**
   * Sub-group keys currently folded away (UIL-075), each `${bandKey}:${kind}`. Same discipline as
   * UIL-018 one level up: a folded sub-group renders NOTHING below its header — rows absent from the
   * tree, not CSS-hidden — so the mount cost UIL-018 exists to remove is really removed at this level
   * too, not just visually hidden.
   */
  collapsedSubgroups: Set<string>;
  onToggleSubgroupCollapse: (bandKey: string, kind: "basic" | "nonbasic") => void;
}) {
  const {
    group,
    collapsed,
    onToggleCollapse,
    doneCount,
    holdsCurrent,
    cur,
    flatIndex,
    done,
    onSelect,
    onShelve,
    shelving,
    overrides,
    overrideNames,
    arrived,
    collectionChoice,
    onOpenLine,
    collapsedSubgroups,
    onToggleSubgroupCollapse,
  } = props;
  const meta = bandMeta(group.bandKey);
  return (
    <div className="bandgroup">
      <button
        type="button"
        className={"bandhead" + (collapsed ? " folded" : "")}
        aria-expanded={!collapsed}
        onClick={onToggleCollapse}
        title={collapsed ? `Show ${meta.display}` : `Hide ${meta.display}`}
      >
        <span className="fold u" aria-hidden>
          {collapsed ? "▶" : "▼"}
        </span>
        <BandChip bandKey={group.bandKey} />
        <span className="nm u">{meta.display}</span>
        <span className="ty">{meta.types}</span>
        <span className="ct">
          {group.count === 0 ? "RESERVED · 0" : `${doneCount} / ${group.count} CARDS`}
          {/* Folded and holding the spotlight card: say so, or the worklist looks like it lost her
              place. The spotlight keeps working either way — it reads `flatItems`, not the DOM. */}
          {collapsed && holdsCurrent ? " · HOLDING NOW" : null}
        </span>
      </button>
      {collapsed ? null : group.count === 0 ? (
        <div className="emptyband">
          <span className="resv" />
          <span>
            {group.bandKey === "pink"
              ? "Reserved. The slot holds even at zero."
              : "Nothing this haul."}
          </span>
        </div>
      ) : (
        group.subgroups.map((sub) => {
          const subFolded = collapsedSubgroups.has(subgroupKey(group.bandKey, sub.kind));
          // Per-sub-group check-off count. Folded, the header is otherwise opaque — same idea as
          // UIL-018's per-band count. The `.subhead` walk is O(rows in the sub-group), and this
          // BandSection is only rendered when the outer band is expanded, so the cost lands only
          // on the band she is actively looking at.
          let subDone = 0;
          for (const it of sub.rows) if (done.has(it.incomingId)) subDone += 1;
          const subHoldsCurrent = sub.rows.some((it) => flatIndex.get(it.incomingId) === cur);
          return (
            <div key={sub.kind}>
              <button
                type="button"
                className={"subhead u" + (subFolded ? " folded" : "")}
                aria-expanded={!subFolded}
                onClick={() => onToggleSubgroupCollapse(group.bandKey, sub.kind)}
                title={subFolded ? `Show ${sub.label}` : `Hide ${sub.label}`}
              >
                <span className="fold u" aria-hidden>
                  {subFolded ? "▶" : "▼"}
                </span>
                <span className="sublabel">{sub.label}</span>
                <span className="ct">
                  {subDone} / {sub.rows.length} CARDS
                  {/* Same signal as the band header: a folded sub-group with the spotlight card in
                      it must announce that, or the worklist looks like it lost her place. */}
                  {subFolded && subHoldsCurrent ? " · HOLDING NOW" : null}
                </span>
              </button>
              {subFolded
                ? null
                : sub.rows.map((it) => (
                    <PlanRow
                      key={it.incomingId}
                      item={it}
                      current={flatIndex.get(it.incomingId) === cur}
                      done={done.has(it.incomingId)}
                      onSelect={() => onSelect(flatIndex.get(it.incomingId) ?? 0)}
                      onShelve={() => onShelve(it)}
                      busy={shelving === it.incomingId}
                      override={overrides[it.incomingId]}
                      overrideNames={overrideNames}
                      isNew={arrived?.has(it.incomingId) ?? false}
                      onOpenLine={onOpenLine ? () => onOpenLine(it) : undefined}
                      needsCollection={
                        !!it.collectionPick &&
                        !overrides[it.incomingId] &&
                        !pickedCollection(it, collectionChoice ?? {})
                      }
                    />
                  ))}
            </div>
          );
        })
      )}
    </div>
  );
}

/** Exported for the render tests — the worklist row is where UIL-016 and UIL-018 both land. */
export function PlanRow(props: {
  item: PlanItem;
  current: boolean;
  /** Shelved — written to the database, not merely ticked (UIL-027). */
  done: boolean;
  onSelect: () => void;
  onShelve: () => void;
  busy?: boolean;
  /** The destination she overrode this card to, if any (UIL-037). */
  override?: MoveDestination | undefined;
  /** Name maps for the override sentence; null until options load (UIL-037). */
  overrideNames?: MoveNameLookups | null;
  /** Arrived while the page was open (UIL-114 part C). */
  isNew?: boolean;
  /** A specialty card that still needs her pick of collection (UIL-053). */
  needsCollection?: boolean;
  /** Open this card's line popup from its badge (UIL-117). */
  onOpenLine?: () => void;
}) {
  const {
    item,
    current,
    done,
    onSelect,
    onShelve,
    busy = false,
    override,
    overrideNames,
    isNew = false,
    needsCollection = false,
    onOpenLine,
  } = props;
  // Show where she MOVED the card, not where the cascade proposed — same source as the spotlight, so
  // the two cannot disagree (UIL-037).
  const disp = displayFor(item, override ?? undefined, overrideNames ?? null);
  const meta = bandMeta(item.bandKey);
  // UIL-117: a card headed into a line wears its badge instead of the action pill, until shelved or moved.
  const showBadge = !!item.lineProposal && !done && !override;
  return (
    <div
      id={planRowDomId(item.incomingId)}
      className={"row" + (current ? " cur" : "") + (done ? " done" : "")}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
    >
      {/* Shelving is a WRITE now, and there is no reverse (her ruling: correct with Move). So an
          already-shelved row's box is disabled rather than a toggle that would silently do nothing. */}
      <button
        type="button"
        className="box"
        aria-label={done ? `${item.name} is shelved` : `Shelve ${item.name}`}
        aria-pressed={done}
        disabled={done || busy}
        onClick={(e) => {
          e.stopPropagation();
          onShelve();
        }}
      />
      <span
        className={"rail" + (meta.dither ? " dither" : "")}
        style={{ background: meta.color }}
      />
      {/* `?? null`, not just `item.imageUrl`: a plan parked in sessionStorage BEFORE UIL-016 shipped
          has no `imageUrl` on its rows, and its stamp still matches (the stamp is DB state only), so
          it resumes with the field `undefined`. Coercing here keeps CardFace's contract honest rather
          than bumping the resume key and throwing away her check-off progress on deploy. */}
      <CardFace
        name={item.name}
        tcgdexId={item.tcgdexId}
        imageUrl={item.imageUrl ?? null}
        size="s"
        zoomable
        caption={cardCaption(null, formatCollectorNumber(item.localId, item.setCardCountOfficial))}
      />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{item.name}</div>
        <div className="meta">
          {formatCollectorNumber(item.localId, item.setCardCountOfficial) ? (
            <span className="no">
              {formatCollectorNumber(item.localId, item.setCardCountOfficial)}
            </span>
          ) : null}
          <span className="u">{disp.destination}</span>
        </div>
      </div>
      <div className="actwrap">
        {/* v3 section 1: the badge replaces the action pill on a line card (at 375 the two stacked and pushed the
            destination onto five lines; UX review of #392). */}
        {showBadge ? null : (
          <span
            className="act u"
            style={{ background: disp.color, color: disp.dark ? "var(--panel)" : "var(--ink)" }}
          >
            {disp.label}
          </span>
        )}
        {/* She overrode this one: mark it so she can pick out her own decisions at a glance (UIL-037).
            MOVED MEANS MOVED (UIL-084). `done` is "written to the database", so before it this reads
            "Will move" — a past-tense chip on a placement the server has not accepted yet is the claim
            that made her hunt a card she was told had landed. The DESTINATION text is unchanged either
            way: she needs to know which pocket to use BEFORE she presses Done. */}
        {override ? <span className="moved u">{done ? "Moved" : "Will move"}</span> : null}
        {item.needsDecision ? <span className="needs u">Decide</span> : null}
        {needsCollection && !done ? <span className="needs u">Pick collection</span> : null}
        {/* UIL-117 (v3 section 1): every card headed into a back half says what it would do to a line, and needs
            her OK; the badge opens its popup. Gone once shelved, or once she moved it instead. */}
        {showBadge && item.lineProposal ? (
          <button
            type="button"
            className={`linebadge ${item.lineProposal.kind} u`}
            // The same words, spoken with ordinary spaces.
            aria-label={lineBadgeText(item.lineProposal.kind, item.lineName ?? null).replace(
              /\u00a0/g,
              " ",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onOpenLine?.();
            }}
          >
            {lineBadgeText(item.lineProposal.kind, item.lineName ?? null)}
          </button>
        ) : null}
        {/* Arrived while she had the page open (UIL-114 part C); gone once shelved, when it is no news. */}
        {isNew && !done ? <span className="newcard u">New</span> : null}
      </div>
    </div>
  );
}

/** Exported for the render tests — the second of UIL-016's two hard-coded `imageUrl={null}` sites. */
export function Spotlight(props: {
  item: PlanItem | undefined;
  /** Shelved — already written to the database (UIL-027). */
  done: boolean;
  /** Mid-write, so the control reads as working rather than unresponsive. */
  busy?: boolean;
  /** Writes this card and advances only if the write succeeded. */
  onShelve: () => void;
  onBackCard: () => void;
  onSkip: () => void;
  /** UIL-114: "Not mine" and "Leave for later", once the haul has run. Absent: neither is offered. */
  onNotMine?: () => void;
  onLeaveForLater?: () => void;
  /** Arrived while the page was open (UIL-114 part C). */
  isNew?: boolean;
  override: MoveDestination | undefined;
  /** Name maps for the override sentence; null until options load (UIL-037). */
  overrideNames?: MoveNameLookups | null;
  /** UIL-030: the plan's open block needs, so the offer can say what is open and lead to the sheet. */
  blockNeeds?: BlockNeedCandidate[];
  onMove: () => void;
  /** UIL-126: a plain extra copy's "⇄ Swap this one into the line…". Absent: not offered. */
  onSwapIntoLine?: () => void;
  /**
   * This card re-derived against current state (UIL-045), when it differs from the forecast row.
   * Undefined means "the forecast is current" — before the first Done, nothing has moved.
   */
  freshItem?: PlanItem | null;
  /** A re-derivation is in flight, so the destination shown may be about to change. */
  refreshing?: boolean;
  /**
   * A card headed into a line (UIL-117): Done opens its line popup, where the line, any pulls and any colour
   * question are decided, instead of shelving it from here.
   */
  lineCard?: boolean;
  /** Her collection picks, by draft id (UIL-053); read for this card through `pickedCollection`. */
  collectionChoice?: Record<string, string>;
  onPickCollection?: (collectionId: string) => void;
}) {
  const {
    item: forecast,
    done,
    busy = false,
    onShelve,
    onBackCard,
    onSkip,
    onNotMine,
    onLeaveForLater,
    isNew = false,
    override,
    overrideNames,
    blockNeeds,
    onMove,
    onSwapIntoLine,
    freshItem,
    refreshing = false,
    lineCard = false,
    collectionChoice = {},
    onPickCollection,
  } = props;
  if (!forecast) return <p style={{ fontSize: 11, color: "var(--ink-2)" }}>No cards to handle.</p>;
  /**
   * The re-derived row wins when we have one (UIL-045). The forecast was computed against pre-haul
   * state, so for a card interacting with one she has already shelved it names a pocket the write will
   * not use — and she reads this panel to decide which pocket to physically use.
   */
  const item = freshItem ?? forecast;
  /**
   * A specialty card bound for a binder that holds collections (UIL-053): it joins the one she picks, and
   * Done waits for the pick, as the server does. Her override names its own destination instead.
   */
  const collectionPick = !override ? (item.collectionPick ?? null) : null;
  const pickedId = collectionPick ? pickedCollection(item, collectionChoice) : null;
  const pickedName = collectionPick?.collections.find((c) => c.id === pickedId)?.name ?? null;
  const pendingCollection = !!collectionPick && !pickedId && !done;
  // Only worth telling her when the pocket actually moved; a reworded reason is not news.
  const movedFrom =
    freshItem && !override && freshItem.destination !== forecast.destination
      ? forecast.destination
      : null;
  // Show where she MOVED the card, not where the cascade proposed — the whole point of the review
  // panel is verifying her own decision before she clicks Done (UIL-037).
  const disp = displayFor(item, override, overrideNames ?? null);
  const meta = bandMeta(item.bandKey);
  return (
    <>
      <div className="hand">
        <CardFace
          name={item.name}
          tcgdexId={item.tcgdexId}
          imageUrl={item.imageUrl ?? null}
          size="l"
          zoomable
          caption={cardCaption(
            null,
            formatCollectorNumber(item.localId, item.setCardCountOfficial),
          )}
        />
        <div style={{ minWidth: 0 }}>
          <div className="nm">
            {item.name}
            {isNew && !done ? (
              <span className="newcard u" style={{ marginLeft: 8 }}>
                New
              </span>
            ) : null}
          </div>
          {formatCollectorNumber(item.localId, item.setCardCountOfficial) ? (
            <div style={{ marginTop: 6 }}>
              <span className="no">
                {formatCollectorNumber(item.localId, item.setCardCountOfficial)}
              </span>
            </div>
          ) : null}
          <div className="sb u">
            {stripLocaleNamespace(item.setId)}
            {cardTag(item.tcgdexId) ? (
              <span className="cpill u" style={{ marginLeft: 6 }}>
                {cardTag(item.tcgdexId)}
              </span>
            ) : null}
            <br />
            {item.stage ?? "—"} · {item.variant}
          </div>
          <div className="bd u">
            <BandChip bandKey={item.bandKey} /> {meta.display}
          </div>
        </div>
      </div>

      <div className="doit">
        <b>{pendingCollection ? "Which collection? Pick one below" : disp.big}</b>
        <span className="sg u">
          {pickedName ? `${disp.destination} · ${pickedName}` : disp.destination}
        </span>
      </div>

      {/* UIL-126: a PLAIN extra copy of a stage her line holds. Done files it in the front half; the swap is hers to
          ask for (Karvi's pick from the UX Dev's mockup). */}
      {item.extraCopyOf && !done && !override ? (
        <div className="extracopy" role="note">
          <span>
            ⓘ Your {item.extraCopyOf.lineName ? `${item.extraCopyOf.lineName} line` : "line"} (
            {item.extraCopyOf.where}) already has {item.extraCopyOf.held}.
          </span>
          {onSwapIntoLine ? (
            <button
              type="button"
              className="btn sm"
              onClick={onSwapIntoLine}
              disabled={busy || refreshing}
            >
              ⇄ Swap this one into the line…
            </button>
          ) : null}
        </div>
      ) : null}

      {/* UIL-117: a card headed into a line is decided in its line popup (its pulls, never ticked for her, and any
          colour question), so this panel shows no controls of its own for it. */}
      {lineCard && !done ? (
        <div className="hk u" style={{ marginTop: 8 }}>
          Confirm its line in the line popup.
        </div>
      ) : null}

      {/* UIL-053 — the binder holds collections, so the card joins one: her pick, with MovePanel's chips.
          None is pre-selected unless the binder holds exactly one (the Senior BA's ruling). */}
      {collectionPick && !done ? (
        <div className="orow">
          <div className="ol">WHICH COLLECTION?</div>
          <span className="oskip">
            This binder holds collections. The card goes on the list of the one you pick.
          </span>
          <div className="ochips" role="group" aria-label="Which collection this card belongs to">
            {collectionPick.collections.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"ochip" + (pickedId === c.id ? " on" : "")}
                aria-pressed={pickedId === c.id}
                onClick={() => onPickCollection?.(c.id)}
                disabled={busy}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* "Moved" as its own label because Done is now the commit (UIL-027) — there is no separate
          commit step for the override to be "at". The `.movedtag u` styling is preserved.
          Gated on `done` (UIL-084): until the write lands this is her INTENT, not a fact, and saying
          "Moved" made a refused placement read as a completed one — across reloads, because the
          override rides in the parked session. */}
      {override ? (
        <div className="movedtag u">
          {done
            ? `Moved · ${disp.destination}`
            : `Your call · ${disp.destination} · not saved until you press Done`}
        </div>
      ) : null}

      {/* An earlier card in this haul changed where this one goes (UIL-045). Saying so is the whole
          point: a silent correction would leave her trusting the worklist row she read a moment ago,
          and the row is what decides which pocket she physically uses. Names the cause, because
          "it changed" without a reason reads like a bug rather than the cascade working. */}
      {movedFrom ? (
        <div className="changedtag u" role="status">
          <b>Changed by this haul</b>
          {/* The old destination only. The NEW one is the `.doit` block immediately above and the
              cascade's reason is the `.wy` immediately below, both already showing the re-derived
              values — repeating either here printed the same sentence twice on one panel (caught at
              375px, where it cost three extra lines of ALL CAPS). What is missing without this line is
              only ever the thing she can no longer see: what the row used to say. */}
          <span>was {movedFrom}</span>
        </div>
      ) : null}

      {/* Only while a re-derivation is actually in flight, and only ever additive: the panel keeps
          showing the forecast rather than blanking, because a stale-but-labelled answer beats none. */}
      {refreshing ? (
        <div className="checkingtag u">Checking this card against your shelves…</div>
      ) : null}

      <button type="button" className="movebtn wide u" style={{ width: "100%" }} onClick={onMove}>
        ↔ Change position
      </button>

      <div className="wy" style={{ marginTop: 11 }}>
        {item.reason}
      </div>

      {item.offerBlockRepurpose && (blockNeeds ?? []).length > 0 && !override ? (
        /* UIL-030: the offer, with its action. Text and action ship together on purpose. */
        <div className="doit" style={{ background: "var(--panel-2)" }}>
          <b style={{ fontSize: 13 }}>Offered as a repurposed binder block</b>
          <span style={{ fontSize: 11, color: "var(--ink-2)" }}>
            {(blockNeeds ?? []).length === 1
              ? `${blockNeeds![0].speciesLabel} has a reserved pocket with nothing in it. `
              : `${(blockNeeds ?? []).length} lines have a reserved pocket with nothing in it. `}
            Pick one under ↔ Change position and this duplicate becomes the block instead of going
            to bulk.
          </span>
        </div>
      ) : null}

      {item.needsDecision ? (
        <div className="doit" style={{ background: "var(--note)" }}>
          <b style={{ fontSize: 13 }}>Needs a decision</b>
          <span style={{ fontSize: 11, color: "var(--ink-2)" }}>
            Confirm or override it on the Lines screen. The proposal is recorded when you shelve it.
          </span>
        </div>
      ) : null}

      <div className="spotbtns">
        {/* One button, one meaning: this writes the placement. No Undo — shelving is a real write and
            a misplacement is corrected with Move, like any other card (her ruling).

            Also disabled while the re-check is in flight (UIL-045). In that window the panel is still
            showing the FORECAST, and the forecast carries no digest — so a Done clicked here would go
            unguarded and could write a pocket other than the one she just read off the screen and put
            the card into. Sub-second, but it is the whole wrong-shelf hazard in miniature, so the
            correct answer is to not accept the click rather than to accept it unguarded.

            On a card headed into a line it opens the line popup instead (UIL-117). */}
        <button
          type="button"
          className="btn btn-primary go"
          onClick={onShelve}
          disabled={done || busy || refreshing || pendingCollection}
        >
          {done
            ? "Shelved ✓"
            : busy
              ? "Shelving…"
              : refreshing
                ? "Checking…"
                : pendingCollection
                  ? "Pick a collection above"
                  : lineCard
                    ? "Confirm its line ▶"
                    : "Done, next card"}
        </button>
        <button type="button" className="btn" onClick={onBackCard}>
          ◀ Back
        </button>
        <button type="button" className="btn" onClick={onSkip}>
          Skip ▶
        </button>
      </div>

      {/* UIL-114: the two ways a card leaves the plan, now the haul has run. Different on purpose: "Not
          mine" deletes the copy (UIL-089, for this haul only, UIL-111); "Leave for later" deletes nothing. */}
      {!done && (onNotMine || onLeaveForLater) ? (
        <div className="spotbtns" style={{ marginTop: 8 }}>
          {onLeaveForLater ? (
            <button
              type="button"
              className="btn sm"
              onClick={onLeaveForLater}
              disabled={busy}
              title={LEAVE_FOR_LATER_HINT}
            >
              {LEAVE_FOR_LATER}
            </button>
          ) : null}
          {onNotMine && forecast ? (
            <RemoveCopyButton
              onRemove={onNotMine}
              busy={busy}
              label="Not mine"
              what={`${forecast.name} from your collection`}
            />
          ) : null}
        </div>
      ) : null}

      {/* "Commit the haul" lived here and is GONE, not relabelled (UIL-027, her ruling). It wrote the
          entire draft — decided or not — which is what treated unshelved cards as inventory. Each card
          is written as she marks it done, so there is nothing left for a batch button to do. The
          progress bar moves with it: the long write it warned about no longer exists, and one card is
          fast enough that a bar would be noise. */}
      {busy ? <ProgressBar label="Shelving this card…" /> : null}
    </>
  );
}
