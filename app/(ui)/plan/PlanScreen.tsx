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

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Variant } from "@/lib/engine";
import type { PlanItem } from "@/lib/plan";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { BandChip } from "../_components/BandChip";
import { CardFace } from "../_components/CardFace";
import { CardLookup } from "../_components/CardLookup";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { VariantSelector } from "../_components/VariantSelector";
import { ACTION_META, bandMeta } from "../_components/plan-meta";
import {
  commitHaulAction,
  getMoveOptions,
  loadPendingPlacementDraft,
  lookupCatalog,
  runHaulPlan,
} from "./actions";
import type {
  CommitCounts,
  DraftCard,
  DraftPayloadItem,
  LookupCard,
  RunPlanResult,
} from "./plan-types";

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
  source: (typeof SOURCES)[number]["v"];
  notes: string;
  draft: DraftCard[];
  plan: RunPlanResult;
  /** Check-off progress — the part whose loss actually hurts, mid-stack at the binder. */
  done: string[];
  cur: number;
  overrides: Record<string, MoveDestination>;
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
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<CommitCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cur, setCur] = useState(resumed?.cur ?? 0);
  const [done, setDone] = useState<Set<string>>(() => new Set(resumed?.done ?? []));
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
      stamp: stateStamp,
      source,
      notes,
      draft,
      plan,
      done: [...done],
      cur,
      overrides,
    });
  }, [stateStamp, source, notes, draft, plan, done, cur, overrides]);

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
    setCommitted(null);
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
      imageUrl: null,
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
      setCur(0);
      setDone(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run the plan.");
    } finally {
      setRunning(false);
    }
  }

  async function onCommit() {
    setError(null);
    setCommitting(true);
    try {
      const res = await commitHaulAction({
        source,
        notes: notes.trim() || null,
        draft: toPayload(draft),
        overrides,
      });
      if (res.ok) setCommitted(res.counts);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed.");
    } finally {
      setCommitting(false);
    }
  }

  function resetAll() {
    setDraft([]);
    setPlan(null);
    setCommitted(null);
    setDone(new Set());
    setNotes("");
    setCur(0);
    setError(null);
    setOverrides({});
    setMoveTarget(null);
    setPlanIsResumed(false);
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

  function toggleDone(id: string) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
          toggleDone={toggleDone}
          advance={advance}
          onBack={() => setPlan(null)}
          onCommit={onCommit}
          committing={committing}
          committed={committed}
          onReset={resetAll}
          overrides={overrides}
          onMove={openMove}
          resumed={planIsResumed}
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
    </div>
  );
}

/* ---------------------------------- plan ---------------------------------- */

function PlanView(props: {
  plan: RunPlanResult;
  flatItems: PlanItem[];
  flatIndex: Map<string, number>;
  cur: number;
  setCur: (i: number) => void;
  done: Set<string>;
  toggleDone: (id: string) => void;
  advance: () => void;
  onBack: () => void;
  onCommit: () => void;
  committing: boolean;
  committed: CommitCounts | null;
  onReset: () => void;
  overrides: Record<string, MoveDestination>;
  onMove: (item: PlanItem) => void;
  /** True when this plan was restored from a parked run rather than just computed (UIL-006). */
  resumed: boolean;
}) {
  const {
    plan,
    flatItems,
    flatIndex,
    cur,
    setCur,
    done,
    toggleDone,
    advance,
    onBack,
    onCommit,
    committing,
    committed,
    onReset,
    overrides,
    onMove,
    resumed,
  } = props;

  const total = flatItems.length;
  const doneCount = flatItems.filter((it) => done.has(it.incomingId)).length;
  const a = plan.summary.byAction;
  const back = (a.FILL ?? 0) + (a.NEWLINE ?? 0) + (a.PULL ?? 0);
  const destSummary = `Front ${a.FRONT ?? 0} · Back ${back} · Specialty ${a.SPEC ?? 0} · Bulk ${
    (a.BULK ?? 0) + (a.SWAP ?? 0)
  }`;

  if (committed) {
    return (
      <div className="entry panel">
        <div className="alertbar ok" style={{ marginBottom: 12 }}>
          <span>✓</span>
          <b>Haul committed.</b>
        </div>
        <p style={{ fontSize: 12, lineHeight: 1.9 }}>
          {committed.routed > 0
            ? `Placed ${committed.routed} card${committed.routed === 1 ? "" : "s"} already in your collection`
            : null}
          {committed.routed > 0 && committed.copies > 0 ? " · " : null}
          {committed.copies > 0 ? `Wrote ${committed.copies} new copies` : null}
          {committed.routed > 0 || committed.copies > 0 ? " · " : null}
          {committed.lines} new lines · {committed.slots} slots · {committed.wishlist} wishlist
          items · {committed.decisions} placement decisions.
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
      <div className="haulbar panel">
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
        <div className="xp" aria-hidden>
          {flatItems.map((it) => (
            <i key={it.incomingId} className={done.has(it.incomingId) ? "f" : ""} />
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
          {plan.groups.map((g) => {
            const meta = bandMeta(g.bandKey);
            return (
              <div key={g.bandKey} className="bandgroup">
                <div className="bandhead">
                  <BandChip bandKey={g.bandKey} />
                  <span className="nm u">{meta.display}</span>
                  <span className="ty">{meta.types}</span>
                  <span className="ct">{g.count ? `${g.count} CARDS` : "RESERVED · 0"}</span>
                </div>
                {g.count === 0 ? (
                  <div className="emptyband">
                    <span className="resv" />
                    <span>
                      {g.bandKey === "pink"
                        ? "Reserved. The slot holds even at zero."
                        : "Nothing this haul."}
                    </span>
                  </div>
                ) : (
                  g.subgroups.map((sub) => (
                    <div key={sub.kind}>
                      <div className="subhead u">{sub.label}</div>
                      {sub.rows.map((it) => (
                        <PlanRow
                          key={it.incomingId}
                          item={it}
                          current={flatIndex.get(it.incomingId) === cur}
                          done={done.has(it.incomingId)}
                          onSelect={() => setCur(flatIndex.get(it.incomingId) ?? 0)}
                          onToggle={() => toggleDone(it.incomingId)}
                        />
                      ))}
                    </div>
                  ))
                )}
              </div>
            );
          })}
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
              onToggle={() => flatItems[cur] && toggleDone(flatItems[cur].incomingId)}
              advance={advance}
              onBackCard={() => setCur(Math.max(0, cur - 1))}
              onSkip={() => setCur(Math.min(total - 1, cur + 1))}
              onCommit={onCommit}
              committing={committing}
              override={flatItems[cur] ? overrides[flatItems[cur].incomingId] : undefined}
              onMove={() => flatItems[cur] && onMove(flatItems[cur])}
            />
          </div>
        </aside>
      </div>

      <div className="foot">BAND → BASIC / NON-BASIC → ACTION · WORK TOP TO BOTTOM</div>
    </>
  );
}

function PlanRow(props: {
  item: PlanItem;
  current: boolean;
  done: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { item, current, done, onSelect, onToggle } = props;
  const act = ACTION_META[item.action];
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
      <button
        type="button"
        className="box"
        aria-label={done ? "Mark not done" : "Mark done"}
        aria-pressed={done}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      />
      <span
        className={"rail" + (meta.dither ? " dither" : "")}
        style={{ background: meta.color }}
      />
      <CardFace name={item.name} imageUrl={null} size="s" />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{item.name}</div>
        <div className="meta">
          {item.localId ? <span className="no">{item.localId}</span> : null}
          <span className="u">{item.destination}</span>
        </div>
      </div>
      <div className="actwrap">
        <span
          className="act u"
          style={{ background: act.color, color: act.dark ? "var(--panel)" : "var(--ink)" }}
        >
          {act.label}
        </span>
        {item.needsDecision ? <span className="needs u">Decide</span> : null}
      </div>
    </div>
  );
}

function Spotlight(props: {
  item: PlanItem | undefined;
  done: boolean;
  onToggle: () => void;
  advance: () => void;
  onBackCard: () => void;
  onSkip: () => void;
  onCommit: () => void;
  committing: boolean;
  override: MoveDestination | undefined;
  onMove: () => void;
}) {
  const {
    item,
    done,
    onToggle,
    advance,
    onBackCard,
    onSkip,
    onCommit,
    committing,
    override,
    onMove,
  } = props;
  if (!item) return <p style={{ fontSize: 11, color: "var(--ink-2)" }}>No cards to handle.</p>;
  const act = ACTION_META[item.action];
  const meta = bandMeta(item.bandKey);
  return (
    <>
      <div className="hand">
        <CardFace name={item.name} imageUrl={null} size="l" />
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
        <b>{act.big}</b>
        <span className="sg u">{item.destination}</span>
      </div>

      {override ? <div className="movedtag u">Moved · override at commit</div> : null}

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
            Confirm-or-override lands in Lines (M7). The proposal is recorded on commit.
          </span>
        </div>
      ) : null}

      <div className="spotbtns">
        <button
          type="button"
          className="btn btn-primary go"
          onClick={() => {
            onToggle();
            advance();
          }}
        >
          {done ? "Undo" : "Done, next card"}
        </button>
        <button type="button" className="btn" onClick={onBackCard}>
          ◀ Back
        </button>
        <button type="button" className="btn" onClick={onSkip}>
          Skip ▶
        </button>
      </div>

      <button
        type="button"
        className="btn btn-primary"
        style={{ width: "100%", marginTop: 12, justifyContent: "center" }}
        onClick={onCommit}
        disabled={committing}
      >
        {committing ? "Committing…" : "Commit the haul"}
      </button>
    </>
  );
}
