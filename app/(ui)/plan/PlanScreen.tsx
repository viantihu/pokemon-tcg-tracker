"use client";

/**
 * Haul intake + placement plan — the core daily screen (scr-plan; dev-spec §5 M6; system-design §7B).
 *
 * Flow: create a haul (source) → fast card entry (type-ahead + variant per card) → run the M3
 * cascade over the whole haul → a placement plan GROUPED to mirror the physical sort (band in
 * rainbow order → basics vs non-basics → name A–Z), worked top-to-bottom with check-off → commit,
 * which writes every record + audit trail atomically on the server.
 *
 * TWO WAYS CARDS ARRIVE HERE (UIL-003). Typed intake is one. The other is the Sync screen's "Place
 * new cards" handoff (sync-ui-spec §B.6): the draft is SEEDED from `initialPending` — every copy that
 * exists but has never been routed, which is the state sync leaves its additions in on purpose. Those
 * rows are tagged and carry their `existingCopyId`, so committing routes the copy sync already created
 * instead of taking the same card in twice. The queue is read on the server (./page.tsx) so the cards
 * are there in the first paint; `reloadPending` re-reads it after a commit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Variant } from "@/lib/engine";
// Leaf import, NOT the "@/lib/plan" barrel: this is a client component, and the barrel re-exports
// ./session, which pulls lib/supabase/server (and `next/headers`) into the browser bundle. The
// `import type` below is fine because types are erased; a VALUE import is not.
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { progressPips } from "@/lib/plan/progress";
import type { BandMismatchChoice, PlanBandGroup, PlanItem, ProposedPull } from "@/lib/plan";
import type { BlockNeedCandidate, MoveDestination, MoveOptions } from "@/lib/line/types";
import type { LineJoinOptions } from "@/lib/line/join-options";
// Leaf import of the pure move module (its only dependency is ./types; the `WriteOp` it names is a
// type-only import), so bringing `describeMove` into the browser bundle drags in no server code.
import { describeMove, moveNameLookups, type MoveNameLookups } from "@/lib/line/move";
import { localeTag, stripLocaleNamespace } from "@/lib/catalog/locale";
import { BandChip } from "../_components/BandChip";
import { CardFace } from "../_components/CardFace";
import { cardCaption } from "../_components/CardLightbox";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { ProgressBar } from "../_components/ProgressBar";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { VariantSelector } from "../_components/VariantSelector";
import { ACTION_META, bandMeta, moveMeta } from "../_components/plan-meta";
import {
  shelveCardAction,
  getLineJoinOptions,
  getMoveOptions,
  loadPendingPlacementDraft,
  lookupCatalog,
  refreshSpotlightAction,
  runHaulPlan,
} from "./actions";
import type { DraftCard, DraftPayloadItem, LookupCard, RunPlanResult } from "./plan-types";

const SOURCES: { v: "bulk-bin" | "pack-rip" | "show" | "trade"; l: string }[] = [
  { v: "bulk-bin", l: "Bulk bin" },
  { v: "pack-rip", l: "Pack rip" },
  { v: "show", l: "Show" },
  { v: "trade", l: "Trade" },
];

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `d-${Math.random().toString(36).slice(2)}`;
}

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
  /** The haul this sitting opened, so a resumed sitting keeps writing into the same one (UIL-027). */
  haulId?: string | null;
  source: (typeof SOURCES)[number]["v"];
  notes: string;
  draft: DraftCard[];
  plan: RunPlanResult;
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
export function subgroupKey(bandKey: string, kind: "basic" | "nonbasic"): string {
  return `${bandKey}:${kind}`;
}

function readResume(stamp: string): ResumeState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeState;
    // Any drift in the underlying state, or a shape we do not recognise, and we start clean.
    if (!parsed || parsed.stamp !== stamp || !parsed.plan || !Array.isArray(parsed.draft)) {
      window.sessionStorage.removeItem(RESUME_KEY);
      return null;
    }
    return parsed;
  } catch {
    // Corrupt entry, quota error, or storage disabled — never break the screen over a cache.
    return null;
  }
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
    existingCopyId: d.existingCopyId ?? null,
  }));
}

export function PlanScreen({
  initialPending = [],
  stateStamp = "",
}: {
  initialPending?: DraftCard[];
  stateStamp?: string;
}) {
  // Read once, during the first render, so a resumed plan is there in the first paint rather than
  // flashing an empty form and swapping. Safe in a lazy initializer: no effect, no cascading render.
  const [resumed] = useState<ResumeState | null>(() => readResume(stateStamp));

  const [source, setSource] = useState<(typeof SOURCES)[number]["v"]>(
    resumed?.source ?? "bulk-bin",
  );
  const [notes, setNotes] = useState(resumed?.notes ?? "");
  const [draft, setDraft] = useState<DraftCard[]>(resumed?.draft ?? initialPending);
  const [plan, setPlan] = useState<RunPlanResult | null>(resumed?.plan ?? null);
  // Whether the plan CURRENTLY on screen is the restored one. `resumed` stays non-null for the life of
  // the component, so using it directly would keep claiming "resumed" after she re-runs.
  const [planIsResumed, setPlanIsResumed] = useState(resumed !== null);
  const [running, setRunning] = useState(false);
  // The id of the haul this sitting opened, threaded through every card so the sitting stays one haul
  // in the audit trail even though each card is its own transaction (UIL-027).
  const [haulId, setHaulId] = useState<string | null>(resumed?.haulId ?? null);
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
   * Pulls she has ticked, per draft id (UIL-061). Starts EMPTY for every card and is never
   * pre-populated: starting a line must move nothing she has not explicitly agreed to, and a
   * pre-checked box is not agreement. Cleared with the plan, like the overrides map.
   */
  const [confirmedPulls, setConfirmedPulls] = useState<Record<string, string[]>>({});
  /**
   * Her resolution of a colour mismatch, per draft id (UIL-069). Starts unset for every card —
   * neither option is a default, so there is nothing to pre-populate. "own-color" also sets
   * `overrides` in the same click (that IS the resolution); this only has to carry "line", the one
   * choice with no override to prove it happened.
   */
  const [bandChoice, setBandChoice] = useState<Record<string, "line" | "own-color">>({});
  const [error, setError] = useState<string | null>(null);
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
  const [seededCount, setSeededCount] = useState(initialPending.length);

  // Park the run whenever it changes. Writing to sessionStorage is exactly what an effect is for —
  // syncing React state out to an external system — and it sets no state, so it cannot cascade.
  // Nothing is parked until a plan exists: a bare draft has nothing worth resuming.
  useEffect(() => {
    if (!plan) {
      clearResume();
      return;
    }
    writeResume({
      stamp: liveStamp,
      haulId,
      source,
      notes,
      draft,
      plan,
      done: [...done],
      cur,
      overrides,
      collapsed: [...collapsed],
      collapsedSubgroups: [...collapsedSubgroups],
    });
  }, [
    liveStamp,
    haulId,
    source,
    notes,
    draft,
    plan,
    done,
    cur,
    overrides,
    collapsed,
    collapsedSubgroups,
  ]);

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
        setSeededCount(rows.length);
        // Only seed when nothing is in progress, so a re-read never discards typed entry.
        setDraft((cur) => (cur.length === 0 ? rows : cur));
      })
      .catch(() => {
        setSeededCount(0);
        setError("Could not load the cards waiting to be placed.");
      })
      .finally(() => setPendingState("ready"));
  }, []);

  // Editing the draft invalidates a computed plan / prior commit (and its overrides).
  function mutateDraft(next: DraftCard[]) {
    setDraft(next);
    setPlan(null);
    setOverrides({});
    // Consent was given against a plan that no longer exists (UIL-061).
    setConfirmedPulls({});
    // Any colour-mismatch pick was against a plan that no longer exists too (UIL-069).
    setBandChoice({});
  }

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
    // A manual Move is her OWN third choice, superseding whatever the mismatch radios held (UIL-069).
    setBandChoice((prev) => {
      const next = { ...prev };
      delete next[moveTarget.copyId];
      return next;
    });
    flashToast(`Placement override set · ${moveTarget.name}`);
    setMoveTarget(null);
  }
  function addCard(card: LookupCard) {
    mutateDraft([...draft, { id: newId(), card, variant: card.variants[0] ?? "normal" }]);
  }
  function setVariant(id: string, v: Variant) {
    mutateDraft(draft.map((d) => (d.id === id ? { ...d, variant: v } : d)));
  }
  function removeCard(id: string) {
    mutateDraft(draft.filter((d) => d.id !== id));
  }

  async function onRun() {
    setError(null);
    setRunning(true);
    try {
      const result = await runHaulPlan(toPayload(draft));
      setPlan(result);
      setPlanIsResumed(false);
      setHaulId(null);
      setLiveStamp(stateStamp);
      setCur(0);
      setDone(new Set());
      // A new run is new work: nothing is finished yet, so nothing should arrive folded.
      setCollapsed(new Set());
      setCollapsedSubgroups(new Set());
      setConfirmedPulls({});
      setBandChoice({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run the plan.");
    } finally {
      setRunning(false);
    }
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
  async function shelveCard(item: PlanItem): Promise<boolean> {
    if (done.has(item.incomingId) || shelving) return false;
    const entry = draft.find((d) => d.id === item.incomingId);
    if (!entry) return false;

    setError(null);
    setShelving(item.incomingId);
    try {
      const res = await shelveCardAction({
        source,
        notes: notes.trim() || null,
        card: {
          id: entry.id,
          tcgdexId: entry.card.tcgdexId,
          variant: entry.variant,
          existingCopyId: entry.existingCopyId ?? null,
        },
        override: overrides[item.incomingId] ?? null,
        haulId,
        // Everything not yet shelved stays queued, so the returned stamp describes what we hold next.
        pendingCopyIds: draft
          .filter((d) => d.existingCopyId && !done.has(d.id) && d.id !== item.incomingId)
          .map((d) => d.existingCopyId as string),
        // Only when we hold a fresh derivation FOR THIS CARD (UIL-045). Sending the stale forecast's
        // digest would conflict on every interacting card; sending none keeps the old behaviour.
        expectedDigest: fresh?.id === item.incomingId ? fresh.digest : null,
        // Only what she ticked FOR THIS CARD, and only while the derivation it was ticked against is
        // still the current one — consent is specific to a placement, not to a card (UIL-061).
        confirmedPulls:
          fresh?.id === item.incomingId ? (confirmedPulls[item.incomingId] ?? []) : [],
        // Only her pick FOR THIS CARD's current derivation, same rule as confirmedPulls (UIL-069).
        bandChoice: fresh?.id === item.incomingId ? (bandChoice[item.incomingId] ?? null) : null,
      });
      if (!res.ok) {
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
          setConfirmedPulls((prev) => ({ ...prev, [item.incomingId]: [] }));
          setBandChoice((prev) => {
            const next = { ...prev };
            delete next[item.incomingId];
            return next;
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
         * Only on a RETURNED refusal, never in the `catch` below: a transport failure is not the
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
      if (res.haulId) setHaulId(res.haulId);
      setDone((prev) => new Set(prev).add(item.incomingId));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not shelve that card.");
      return false;
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
    setNotes("");
    setCur(0);
    setError(null);
    setOverrides({});
    setConfirmedPulls({});
    setBandChoice({});
    setMoveTarget(null);
    setPlanIsResumed(false);
    setHaulId(null);
    setLiveStamp(stateStamp);
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
  useEffect(() => {
    // No setState on this path, deliberately: a stale entry is IGNORED at the point of use (it is
    // keyed by draft id and every reader checks the key), so clearing it here would be a cascading
    // render for no observable difference.
    if (!spotlightId || done.size === 0 || overrides[spotlightId]) return;
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
  }, [spotlightId, done, draft, overrides]);

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
  /** Tick or untick one proposed pull for one card (UIL-061). */
  function onTogglePull(draftId: string, copyId: string) {
    setConfirmedPulls((prev) => {
      const cur = prev[draftId] ?? [];
      return {
        ...prev,
        [draftId]: cur.includes(copyId) ? cur.filter((c) => c !== copyId) : [...cur, copyId],
      };
    });
  }

  /**
   * Her resolution of a colour mismatch (UIL-069). "Own colour" also sets `overrides` in the same
   * click — that IS the resolution, reusing the manual-override write path verbatim (drift-proof by
   * construction) rather than a second write mechanism. "Line" sets no override: it is the cascade's
   * own placement, confirmed instead by sending `bandChoice: "line"` at Done alongside the digest.
   */
  function onPickBandChoice(draftId: string, choice: "line" | "own-color") {
    setBandChoice((prev) => ({ ...prev, [draftId]: choice }));
    if (choice === "own-color" && fresh?.id === draftId && fresh.bandMismatch) {
      setOverrides((prev) => ({
        ...prev,
        [draftId]: fresh.bandMismatch!.ownColorMoveDestination,
      }));
    } else if (choice === "line") {
      // Switching back from a previously-picked "own colour" must drop that override, or Done would
      // still send it and silently win over her new pick.
      setOverrides((prev) => {
        if (!(draftId in prev)) return prev;
        const next = { ...prev };
        delete next[draftId];
        return next;
      });
    }
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

      {!plan ? (
        <IntakePanel
          source={source}
          setSource={setSource}
          notes={notes}
          setNotes={setNotes}
          draft={draft}
          onAdd={addCard}
          onVariant={setVariant}
          onRemove={removeCard}
          onRun={onRun}
          running={running}
          pendingState={pendingState}
          seededCount={seededCount}
          onReloadPending={reloadPending}
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
          confirmedPulls={confirmedPulls}
          onTogglePull={onTogglePull}
          bandChoice={bandChoice}
          onPickBandChoice={onPickBandChoice}
          advance={advance}
          onBack={() => setPlan(null)}
          onReset={resetAll}
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
 * The pending-placement status line (UIL-003). It exists so arriving from Sync's "Place new cards"
 * never looks like an empty form with no explanation: it says how many copies are waiting, that they
 * are already counted in the collection, and that this pass gives them a home rather than re-adding
 * them. Silent only when the queue is genuinely empty and nothing was seeded.
 */
function PendingBar({
  state,
  seededCount,
  routedInDraft,
  onReload,
}: {
  state: "loading" | "ready";
  seededCount: number;
  routedInDraft: number;
  onReload: () => void;
}) {
  if (state === "loading") {
    return (
      <div className="alertbar" style={{ marginBottom: 12 }}>
        <span>…</span>
        <b>Checking for cards waiting to be placed…</b>
      </div>
    );
  }
  if (seededCount === 0) return null;
  return (
    <div className="alertbar" style={{ marginBottom: 12 }}>
      <span>↯</span>
      <b>
        {routedInDraft > 0
          ? `${routedInDraft} card${routedInDraft === 1 ? "" : "s"} from your Dex sync, waiting to be placed.`
          : `${seededCount} card${seededCount === 1 ? "" : "s"} from your Dex sync are still waiting to be placed.`}
      </b>
      <span style={{ fontSize: 11, color: "var(--ink-2)", flexBasis: "100%" }}>
        These are already in your collection — running the plan gives them a home, it does not add
        them again.
      </span>
      <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={onReload}>
        Refresh
      </button>
    </div>
  );
}

function IntakePanel(props: {
  source: (typeof SOURCES)[number]["v"];
  setSource: (v: (typeof SOURCES)[number]["v"]) => void;
  notes: string;
  setNotes: (s: string) => void;
  draft: DraftCard[];
  onAdd: (c: LookupCard) => void;
  onVariant: (id: string, v: Variant) => void;
  onRemove: (id: string) => void;
  onRun: () => void;
  running: boolean;
  pendingState: "loading" | "ready";
  seededCount: number;
  onReloadPending: () => void;
}) {
  const {
    source,
    setSource,
    notes,
    setNotes,
    draft,
    onAdd,
    onVariant,
    onRemove,
    onRun,
    running,
    pendingState,
    seededCount,
    onReloadPending,
  } = props;
  const routedInDraft = draft.filter((d) => d.existingCopyId).length;
  return (
    <div className="entry panel">
      <PendingBar
        state={pendingState}
        seededCount={seededCount}
        routedInDraft={routedInDraft}
        onReload={onReloadPending}
      />
      <div className="entryhead">
        <span className="hk u" style={{ fontSize: 11, letterSpacing: "0.14em" }}>
          New haul
        </span>
        <select
          className="field"
          style={{ width: "auto" }}
          value={source}
          onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number]["v"])}
          aria-label="Haul source"
        >
          {SOURCES.map((s) => (
            <option key={s.v} value={s.v}>
              {s.l}
            </option>
          ))}
        </select>
        <input
          className="field"
          style={{ flex: 1, minWidth: 160 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
        />
      </div>

      <CardResultsGrid search={lookupCatalog} onPick={onAdd} />

      {draft.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add cards by set + number or name. Each card picks a variant. Then run the plan — the
          cascade routes the whole haul and groups it to your physical sort.
        </p>
      ) : (
        <div className="draftlist">
          {draft.map((d) => (
            <div key={d.id} className="draftrow">
              <CardFace
                name={d.card.name}
                imageUrl={d.card.imageUrl}
                size="s"
                zoomable
                caption={cardCaption(
                  d.card.setName ?? d.card.setId,
                  formatCollectorNumber(d.card.localId, d.card.setCardCountOfficial),
                )}
              />
              <div className="di">
                <div className="nm">{d.card.name}</div>
                <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3 }}>
                  {(d.card.setName ?? d.card.setId ?? "").toString()}
                  {formatCollectorNumber(d.card.localId, d.card.setCardCountOfficial)
                    ? ` · ${formatCollectorNumber(d.card.localId, d.card.setCardCountOfficial)}`
                    : ""}
                </div>
                <div style={{ marginTop: 6 }}>
                  {d.existingCopyId ? (
                    // Dex owns the variant of a synced copy (sync-architecture §1.1), so it is shown,
                    // not edited: a local change here would be silently reverted by the next import.
                    <span className="tag u" title="Already in your collection from a Dex sync">
                      Waiting from sync · {d.dexVariantRaw ?? d.variant}
                    </span>
                  ) : (
                    <VariantSelector
                      variants={d.card.variants}
                      value={d.variant}
                      onChange={(v) => onVariant(d.id, v)}
                    />
                  )}
                </div>
              </div>
              <button
                type="button"
                className="iconbtn"
                onClick={() => onRemove(d.id)}
                aria-label={`Remove ${d.card.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="hk">
          {draft.length} card{draft.length === 1 ? "" : "s"} in the haul
        </span>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          disabled={draft.length === 0 || running}
          onClick={onRun}
        >
          {running ? "Running…" : "Run the plan ▶"}
        </button>
      </div>
      {/* UIL-008: the cascade over a synced stack takes long enough that a dead button reads as a
          hang. Indeterminate by necessity — `runHaulPlan` is one server action that returns once. */}
      {running ? <ProgressBar label={`Routing ${draft.length} cards…`} /> : null}
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
    name: item.name,
    localId: item.localId,
    setCardCountOfficial: item.setCardCountOfficial,
    imageUrl: item.imageUrl ?? null,
    bandKey: item.bandKey,
    currentLabel: item.destination,
    joinCandidates: join?.joinCandidates,
    existingLineByBinderBand: join?.existingLineByBinderBand,
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
  shelveCard: (item: PlanItem) => Promise<boolean>;
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
  /** Pulls she has ticked, by draft id (UIL-061). */
  confirmedPulls: Record<string, string[]>;
  onTogglePull: (draftId: string, copyId: string) => void;
  /** Her colour-mismatch pick, by draft id (UIL-069). */
  bandChoice: Record<string, "line" | "own-color">;
  onPickBandChoice: (draftId: string, choice: "line" | "own-color") => void;
  advance: () => void;
  onBack: () => void;
  onReset: () => void;
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
    confirmedPulls,
    onTogglePull,
    bandChoice,
    onPickBandChoice,
    advance,
    onBack,
    onReset,
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

      <div className={"alertbar" + (plan.summary.decisions === 0 ? " ok" : "")}>
        <span className={plan.summary.decisions ? "blink" : ""}>
          {plan.summary.decisions ? "!" : "✓"}
        </span>
        <b>
          {plan.summary.decisions
            ? `${plan.summary.decisions} decision${plan.summary.decisions > 1 ? "s" : ""} flagged (resolve in Lines · M7)`
            : "No decisions flagged · ready to commit"}
        </b>
        <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={onBack}>
          ◀ Edit haul
        </button>
      </div>

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
              onSelect={setCur}
              onShelve={shelveCard}
              shelving={shelving}
              overrides={overrides}
              overrideNames={overrideNames}
              collapsedSubgroups={collapsedSubgroups}
              onToggleSubgroupCollapse={toggleSubgroupCollapse}
            />
          ))}
        </div>

        <aside className="spot panel">
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
                // Advance only on a successful write: a card that failed still needs a location, so
                // leaving the cursor on it is the correct behaviour rather than skipping past it.
                if (item && (await shelveCard(item))) advance();
              }}
              onBackCard={() => setCur(Math.max(0, cur - 1))}
              onSkip={() => setCur(Math.min(total - 1, cur + 1))}
              override={flatItems[cur] ? overrides[flatItems[cur].incomingId] : undefined}
              overrideNames={overrideNames}
              blockNeeds={plan.blockNeeds}
              onMove={() => flatItems[cur] && onMove(flatItems[cur])}
              // Only when the reply belongs to the card actually in the spotlight (UIL-045).
              freshItem={
                flatItems[cur] && fresh?.id === flatItems[cur].incomingId ? fresh.item : null
              }
              /* Derived, not stored (UIL-045): a re-derivation is outstanding exactly when one is
                 expected for this card and we do not hold its answer yet. Keeping this out of state
                 is also what keeps the effect free of a synchronous setState. */
              proposedPulls={
                flatItems[cur] && fresh?.id === flatItems[cur].incomingId ? fresh.proposedPulls : []
              }
              confirmedPulls={
                flatItems[cur] ? (confirmedPulls[flatItems[cur].incomingId] ?? []) : []
              }
              onTogglePull={(copyId) => {
                const id = flatItems[cur]?.incomingId;
                if (id) onTogglePull(id, copyId);
              }}
              // Same rule as proposedPulls (UIL-069): only when the reply belongs to the spotlight card.
              bandMismatch={
                flatItems[cur] && fresh?.id === flatItems[cur].incomingId
                  ? fresh.bandMismatch
                  : null
              }
              bandChoice={flatItems[cur] ? (bandChoice[flatItems[cur].incomingId] ?? null) : null}
              onPickBandChoice={(choice) => {
                const id = flatItems[cur]?.incomingId;
                if (id) onPickBandChoice(id, choice);
              }}
              refreshing={
                !!flatItems[cur] &&
                doneCount > 0 &&
                !overrides[flatItems[cur].incomingId] &&
                fresh?.id !== flatItems[cur].incomingId
              }
            />
          </div>
        </aside>
      </div>

      <div className="foot">BAND → BASIC / NON-BASIC → A–Z · WORK TOP TO BOTTOM</div>
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
}) {
  const { item, current, done, onSelect, onShelve, busy = false, override, overrideNames } = props;
  // Show where she MOVED the card, not where the cascade proposed — same source as the spotlight, so
  // the two cannot disagree (UIL-037).
  const disp = displayFor(item, override ?? undefined, overrideNames ?? null);
  const meta = bandMeta(item.bandKey);
  return (
    <div
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
        <span
          className="act u"
          style={{ background: disp.color, color: disp.dark ? "var(--panel)" : "var(--ink)" }}
        >
          {disp.label}
        </span>
        {/* She overrode this one: mark it so she can pick out her own decisions at a glance (UIL-037).
            MOVED MEANS MOVED (UIL-084). `done` is "written to the database", so before it this reads
            "Will move" — a past-tense chip on a placement the server has not accepted yet is the claim
            that made her hunt a card she was told had landed. The DESTINATION text is unchanged either
            way: she needs to know which pocket to use BEFORE she presses Done. */}
        {override ? <span className="moved u">{done ? "Moved" : "Will move"}</span> : null}
        {item.needsDecision ? <span className="needs u">Decide</span> : null}
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
  override: MoveDestination | undefined;
  /** Name maps for the override sentence; null until options load (UIL-037). */
  overrideNames?: MoveNameLookups | null;
  /** UIL-030: the plan's open block needs, so the offer can say what is open and lead to the sheet. */
  blockNeeds?: BlockNeedCandidate[];
  onMove: () => void;
  /**
   * This card re-derived against current state (UIL-045), when it differs from the forecast row.
   * Undefined means "the forecast is current" — before the first Done, nothing has moved.
   */
  freshItem?: PlanItem | null;
  /** A re-derivation is in flight, so the destination shown may be about to change. */
  refreshing?: boolean;
  /** Cards of hers this placement would relocate, each needing an explicit tick (UIL-061). */
  proposedPulls?: ProposedPull[];
  /** Which of them she has ticked. */
  confirmedPulls?: string[];
  onTogglePull?: (copyId: string) => void;
  /** Present only when this card's own colour differs from the line it would join (UIL-069). */
  bandMismatch?: BandMismatchChoice | null;
  /** Her pick, if any. Neither is a default — `null` means genuinely unresolved, not "line". */
  bandChoice?: "line" | "own-color" | null;
  onPickBandChoice?: (choice: "line" | "own-color") => void;
}) {
  const {
    item: forecast,
    done,
    busy = false,
    onShelve,
    onBackCard,
    onSkip,
    override,
    overrideNames,
    blockNeeds,
    onMove,
    freshItem,
    refreshing = false,
    proposedPulls = [],
    confirmedPulls = [],
    onTogglePull,
    bandMismatch,
    bandChoice,
    onPickBandChoice,
  } = props;
  if (!forecast) return <p style={{ fontSize: 11, color: "var(--ink-2)" }}>No cards to handle.</p>;
  /**
   * The re-derived row wins when we have one (UIL-045). The forecast was computed against pre-haul
   * state, so for a card interacting with one she has already shelved it names a pocket the write will
   * not use — and she reads this panel to decide which pocket to physically use.
   */
  const item = freshItem ?? forecast;
  /**
   * A mismatch with no pick yet and no override (UIL-069) — the moment `bandChoice` becomes "line" or
   * she picks "own colour" (which sets `override` in the same click), this goes false and the ordinary
   * destination display below is already correct for whichever she chose. Neither option is shown as
   * decided until then: `item.destination` alone would read as "line wins", which is the silent
   * default her ruling rejects.
   */
  const pendingBandChoice = !!bandMismatch && !override && bandChoice == null;
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
          imageUrl={item.imageUrl ?? null}
          size="l"
          zoomable
          caption={cardCaption(
            null,
            formatCollectorNumber(item.localId, item.setCardCountOfficial),
          )}
        />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{item.name}</div>
          {formatCollectorNumber(item.localId, item.setCardCountOfficial) ? (
            <div style={{ marginTop: 6 }}>
              <span className="no">
                {formatCollectorNumber(item.localId, item.setCardCountOfficial)}
              </span>
            </div>
          ) : null}
          <div className="sb u">
            {stripLocaleNamespace(item.setId)}
            {localeTag(item.tcgdexId) ? (
              <span className="cpill u" style={{ marginLeft: 6 }}>
                {localeTag(item.tcgdexId)}
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
        <b>{pendingBandChoice ? "Colour mismatch — pick one below" : disp.big}</b>
        <span className="sg u">{pendingBandChoice ? "" : disp.destination}</span>
      </div>

      {/* UIL-069 — her ruling reverses UIL-065's "the line's band wins" default: neither option is
          shown as decided, and Done stays disabled until she picks one. Reuses the `.pullrow` row
          styling (a labelled control + name + location) rather than a new shape for one radio pair. */}
      {bandMismatch ? (
        <div
          className="pulls"
          role="radiogroup"
          aria-label="Colour mismatch — choose a destination"
        >
          <div className="pullhead u">
            <b>Colour mismatch — choose</b>
            <span>
              This card&apos;s own colour differs from the line it would join. Neither wins by
              default.
            </span>
          </div>
          {(
            [
              {
                value: "line" as const,
                label: `Join ${bandMismatch.lineSpeciesLabel}`,
                where: bandMismatch.lineDestination,
              },
              {
                value: "own-color" as const,
                label: "File by its own colour",
                where: bandMismatch.ownColorDestination,
              },
            ] as const
          ).map((opt) => {
            const on = bandChoice === opt.value;
            return (
              <label key={opt.value} className={"pullrow" + (on ? " on" : "")}>
                <input
                  type="radio"
                  name={`bandmismatch-${item.incomingId}`}
                  checked={on}
                  onChange={() => onPickBandChoice?.(opt.value)}
                  disabled={done || busy}
                />
                <span className="pullnm">{opt.label}</span>
                <span className="pullfrom u">{opt.where}</span>
              </label>
            );
          })}
        </div>
      ) : null}

      {/* UIL-061 — every card of HERS this would move, named, each an explicit opt-in.
          Unticked by default and never pre-checked: "the user must validate each and every single
          line", and a pre-ticked box is not validation. An unticked stage stays a placeholder, so
          declining costs her nothing but the line does not pretend to hold a card still in her binder. */}
      {proposedPulls.length > 0 ? (
        <div className="pulls">
          <div className="pullhead u">
            <b>Also move your own cards?</b>
            <span>
              Starting this line can pull {proposedPulls.length} card
              {proposedPulls.length === 1 ? "" : "s"} you already own. Nothing moves unless you tick
              it.
            </span>
          </div>
          {proposedPulls.map((pull) => {
            const on = confirmedPulls.includes(pull.copyId);
            return (
              <label key={pull.copyId} className={"pullrow" + (on ? " on" : "")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onTogglePull?.(pull.copyId)}
                  disabled={done || busy}
                />
                <span className="pullnm">{pull.name}</span>
                <span className="pullfrom u">from {pull.fromLabel}</span>
                {/* Worth saying on its own: taking it leaves the OTHER line a card short. */}
                {pull.fromLine ? <span className="pullwarn u">in another line</span> : null}
              </label>
            );
          })}
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
            Confirm-or-override lands in Lines (M7). The proposal is recorded when you shelve it.
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

            Also disabled while a colour mismatch is unresolved (UIL-069): a default here is exactly
            what her ruling rejects, so the button simply will not fire until she has picked one. */}
        <button
          type="button"
          className="btn btn-primary go"
          onClick={onShelve}
          disabled={done || busy || refreshing || pendingBandChoice}
        >
          {done
            ? "Shelved ✓"
            : busy
              ? "Shelving…"
              : refreshing
                ? "Checking…"
                : pendingBandChoice
                  ? "Pick one above"
                  : "Done, next card"}
        </button>
        <button type="button" className="btn" onClick={onBackCard}>
          ◀ Back
        </button>
        <button type="button" className="btn" onClick={onSkip}>
          Skip ▶
        </button>
      </div>

      {/* "Commit the haul" lived here and is GONE, not relabelled (UIL-027, her ruling). It wrote the
          entire draft — decided or not — which is what treated unshelved cards as inventory. Each card
          is written as she marks it done, so there is nothing left for a batch button to do. The
          progress bar moves with it: the long write it warned about no longer exists, and one card is
          fast enough that a bar would be noise. */}
      {busy ? <ProgressBar label="Shelving this card…" /> : null}
    </>
  );
}
