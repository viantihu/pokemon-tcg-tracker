"use client";

/**
 * Haul intake + placement plan — the core daily screen (scr-plan; dev-spec §5 M6; system-design §7B).
 *
 * Flow: create a haul (source) → fast card entry (type-ahead + variant per card) → run the M3
 * cascade over the whole haul → a placement plan GROUPED to mirror the physical sort (band in
 * rainbow order → basics vs non-basics → action), worked top-to-bottom with check-off → commit,
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
import { progressPips } from "@/lib/plan/progress";
import type { PlanBandGroup, PlanItem } from "@/lib/plan";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
// Leaf import of the pure move module (its only dependency is ./types; the `WriteOp` it names is a
// type-only import), so bringing `describeMove` into the browser bundle drags in no server code.
import { describeMove, moveNameLookups, type MoveNameLookups } from "@/lib/line/move";
import { BandChip } from "../_components/BandChip";
import { CardFace } from "../_components/CardFace";
import { CardLookup } from "../_components/CardLookup";
import { ProgressBar } from "../_components/ProgressBar";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { VariantSelector } from "../_components/VariantSelector";
import { ACTION_META, bandMeta, moveMeta } from "../_components/plan-meta";
import {
  shelveCardAction,
  getMoveOptions,
  loadPendingPlacementDraft,
  lookupCatalog,
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
    });
  }, [liveStamp, haulId, source, notes, draft, plan, done, cur, overrides, collapsed]);

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
    const gen = opts.binders.find((b) => b.type === "general");
    const existing = overrides[item.incomingId];
    setMoveTarget({
      copyId: item.incomingId, // carries the draft id; the override is keyed by it (no copy exists yet)
      name: item.name,
      localId: item.localId,
      imageUrl: item.imageUrl ?? null,
      bandKey: item.bandKey,
      currentLabel: item.destination,
      initial:
        existing ??
        (gen ? { kind: "shelf", binderId: gen.id, half: "front", band: item.bandKey } : undefined),
    });
  }

  function onMoveConfirm(dest: MoveDestination) {
    if (!moveTarget) return;
    setOverrides((prev) => ({ ...prev, [moveTarget.copyId]: dest }));
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
      });
      if (!res.ok) {
        setError(res.error);
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
    setNotes("");
    setCur(0);
    setError(null);
    setOverrides({});
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
    () => (moveOptions ? moveNameLookups(moveOptions) : null),
    [moveOptions],
  );

  /** Fold / unfold one band (UIL-018). Same shape as `toggleDone` — a set of keys, not a flag map. */
  function toggleCollapse(bandKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bandKey)) next.delete(bandKey);
      else next.add(bandKey);
      return next;
    });
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
        />
      )}

      {moveTarget && moveOptions ? (
        <MoveOverlay
          card={moveTarget}
          options={moveOptions}
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

      <CardLookup search={lookupCatalog} onPick={onAdd} />

      {draft.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add cards by set + number or name. Each card picks a variant. Then run the plan — the
          cascade routes the whole haul and groups it to your physical sort.
        </p>
      ) : (
        <div className="draftlist">
          {draft.map((d) => (
            <div key={d.id} className="draftrow">
              <CardFace name={d.card.name} imageUrl={d.card.imageUrl} size="s" />
              <div className="di">
                <div className="nm">{d.card.name}</div>
                <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3 }}>
                  {(d.card.setName ?? d.card.setId ?? "").toString()}
                  {d.card.localId ? ` · ${d.card.localId}` : ""}
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
              onMove={() => flatItems[cur] && onMove(flatItems[cur])}
            />
          </div>
        </aside>
      </div>

      <div className="foot">BAND → BASIC / NON-BASIC → ACTION · WORK TOP TO BOTTOM</div>
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
        group.subgroups.map((sub) => (
          <div key={sub.kind}>
            <div className="subhead u">{sub.label}</div>
            {sub.rows.map((it) => (
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
        ))
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
      <CardFace name={item.name} imageUrl={item.imageUrl ?? null} size="s" />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{item.name}</div>
        <div className="meta">
          {item.localId ? <span className="no">{item.localId}</span> : null}
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
        {/* She overrode this one: mark it so she can pick out her own decisions at a glance (UIL-037). */}
        {override ? <span className="moved u">Moved</span> : null}
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
  onMove: () => void;
}) {
  const {
    item,
    done,
    busy = false,
    onShelve,
    onBackCard,
    onSkip,
    override,
    overrideNames,
    onMove,
  } = props;
  if (!item) return <p style={{ fontSize: 11, color: "var(--ink-2)" }}>No cards to handle.</p>;
  // Show where she MOVED the card, not where the cascade proposed — the whole point of the review
  // panel is verifying her own decision before she clicks Done (UIL-037).
  const disp = displayFor(item, override, overrideNames ?? null);
  const meta = bandMeta(item.bandKey);
  return (
    <>
      <div className="hand">
        <CardFace name={item.name} imageUrl={item.imageUrl ?? null} size="l" />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{item.name}</div>
          {item.localId ? (
            <div style={{ marginTop: 6 }}>
              <span className="no">{item.localId}</span>
            </div>
          ) : null}
          <div className="sb u">
            {(item.setId ?? "").toString()}
            <br />
            {item.stage ?? "—"} · {item.variant}
          </div>
          <div className="bd u">
            <BandChip bandKey={item.bandKey} /> {meta.display}
          </div>
        </div>
      </div>

      <div className="doit">
        <b>{disp.big}</b>
        <span className="sg u">{disp.destination}</span>
      </div>

      {/* "Moved" as its own label because Done is now the commit (UIL-027) — there is no separate
          commit step for the override to be "at". The `.movedtag u` styling is preserved. */}
      {override ? <div className="movedtag u">Moved · {disp.destination}</div> : null}

      <button type="button" className="movebtn wide u" style={{ width: "100%" }} onClick={onMove}>
        ↔ Change position
      </button>

      <div className="wy" style={{ marginTop: 11 }}>
        {item.reason}
      </div>

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
            a misplacement is corrected with Move, like any other card (her ruling). */}
        <button
          type="button"
          className="btn btn-primary go"
          onClick={onShelve}
          disabled={done || busy}
        >
          {done ? "Shelved ✓" : busy ? "Shelving…" : "Done, next card"}
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
