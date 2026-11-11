"use client";

/**
 * Sync screen (dev-spec §5 M9; sync-ui-spec §A + §B; prototype visual language). Wraps the M4 engine
 * in its two surfaces: the preview / apply / undo flow and the unresolved queue. Thin client — all
 * parse / reconcile / apply / undo logic lives server-side in `@/lib/sync` (called via ./actions);
 * this component holds interaction state and renders the returned view-models. Reuses the shared
 * primitives (CardFace, BandChip, CardResultsGrid) and the app's 16-bit olive/cream classes.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlagFixRow,
  ReturningRow,
  SyncOverrides,
  SyncPlanBundle,
  SyncPreview,
} from "@/lib/sync";
import { RETURNING_NOTE } from "@/lib/sync/preview";
import { forgottenDismissedLine } from "@/lib/sync/preview";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { BandChip } from "../_components/BandChip";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { StandInForm } from "../_components/StandInForm";
import { ProgressBar } from "../_components/ProgressBar";
import {
  applySync,
  createStandInAndMatch,
  dismissEntryAction,
  forgetSetAliasAction,
  loadSyncState,
  manualMatchEntry,
  previewSync,
  restoreRemovedAction,
  restoreWithheldAction,
  retryUnresolvedNow,
  searchCatalog,
  swapStandInAction,
  fixStandInAction,
  keepStandInAction,
  reviewStandInAgainAction,
  undismissEntryAction,
  undoLastSync,
} from "./actions";
import type {
  ApplyOutcome,
  LearnedAliasView,
  QueueEntryView,
  StandInFormInput,
  StandInOutcome,
  SyncState,
} from "./sync-types";
import { LOST, reach } from "../_components/reach";
import { CountCheckPanel } from "./CountCheckPanel";
import { StandInSwapPanel } from "./StandInSwapPanel";
import { RemovedCardsPanel } from "./RemovedCardsPanel";

type Phase = "idle" | "parsing" | "preview" | "working";

function waited(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return "just now";
}

/** The Dex export's own spelling for a resolver locale, so the screen speaks her language, not codes. */
function localeLabel(locale: string): string {
  return locale === "ja" ? "Japanese" : locale === "en" ? "English" : locale;
}

const aliasKeyOf = (a: LearnedAliasView) => `${a.locale}:${a.dexCode}`;

/**
 * Which learned alias an entry's known set rests on (UIL-047 C3), if any. Shown inside the match sheet, not on the
 * main list: it only matters once she is looking at that card and suspects its set was taught wrong.
 */
export function aliasNote(aliases: LearnedAliasView[], e: QueueEntryView): string | null {
  const a = aliases.find((x) => aliasKeyOf(x) === e.aliasKey);
  return a ? `set known through the learned alias ${a.dexCode} → ${a.tcgdexSetId}` : null;
}

/**
 * A server action that THROWS never reached her data or never answered: the app was redeployed while the page
 * was open (a new deployment retires the old action ids), or the connection dropped. The actions return their own
 * failures as `{ ok: false }`, so a throw is only ever this. Before, nothing caught it and the progress bar ran
 * forever. Each message says only what is true for that call: a preview writes nothing; a write is all-or-nothing,
 * so a reload shows which.
 */
export const LOST_PREVIEW =
  "The app was updated while this page was open, or the connection dropped. Reload the page and import again. Nothing was saved.";
export const LOST_APPLY =
  "The app was updated while this page was open, or the connection dropped. Reload the page to see whether your import was saved; importing again is safe.";
// The generic two are the shared family's (../_components/reach, UIL-106); the import-specific two stay here.
export const LOST_ACTION = LOST.action;
export const LOST_REFRESH = LOST.read;

export function SyncScreen({ initialState }: { initialState: SyncState }) {
  const [state, setState] = useState<SyncState>(initialState);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [bundle, setBundle] = useState<SyncPlanBundle | null>(null);
  const [overrides, setOverrides] = useState<SyncOverrides>({});
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState<QueueEntryView | null>(null);
  /**
   * Cards a match held back because she had removed them (UIL-099 E2). A panel, not a toast: it carries the
   * one action that returns them, and it stays until she chooses.
   */
  const [withheld, setWithheld] = useState<WithheldView | null>(null);
  /**
   * Stand-ins swapped for their real cards (UIL-060 Half 2). A swap happens on the load that finds it, so each load's
   * swaps are kept here until she has seen them, not replaced by the next load's (which finds none).
   */
  const [swapped, setSwapped] = useState(initialState.standIns.swapped);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await loadSyncState();
      setState(next);
      if (next.standIns.swapped.length > 0) setSwapped((had) => [...had, ...next.standIns.swapped]);
    } catch {
      setError(LOST_REFRESH);
    }
  }, []);

  const busy = phase === "parsing" || phase === "working";
  /**
   * Stage text for the activity bar (UIL-008). Sourced from the real `Phase` transitions, so it can
   * only ever say what is actually happening. "Reading" covers parse + per-row catalog resolve, which
   * is the slow half — it walks every owned CSV row.
   */
  const busyLabel =
    phase === "parsing" ? "Reading your export and matching cards…" : "Saving your changes…";

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = ""; // let re-selecting the same file re-trigger
    if (!f) return;
    setError(null);
    setToast(null);
    setPhase("parsing");
    const fd = new FormData();
    fd.append("file", f);
    const res = await reach(() => previewSync(fd), LOST_PREVIEW);
    if (!res.ok) {
      setError(res.error);
      setPhase("idle");
      return;
    }
    if (res.preview.kind === "noop") {
      setToast("Already in sync — nothing to apply.");
      setPhase("idle");
      await refresh();
      return;
    }
    if (res.preview.kind === "fastpath") {
      // Fast-path: additions only → auto-apply + notify, no gate (sync-ui-spec §B.1). The bar now says it is
      // saving, so a stall can be told apart from a slow read.
      setPhase("working");
      const applied = await reach(() => applySync(res.bundle), LOST_APPLY);
      if (!applied.ok) setError(applied.error);
      else setToast(applied.notification);
      setPhase("idle");
      await refresh();
      return;
    }
    // Gated: any removal / variant change → stop for review, write nothing yet.
    setPreview(res.preview);
    setBundle(res.bundle);
    setOverrides({});
    setPhase("preview");
  }

  async function onApply() {
    if (!bundle) return;
    setError(null);
    setPhase("working");
    const res = await reach(() => applySync(bundle, overrides), LOST_APPLY);
    if (!res.ok) {
      setError(res.error);
      setPhase("preview");
      return;
    }
    setToast(appliedToast(res));
    setPreview(null);
    setBundle(null);
    setPhase("idle");
    await refresh();
  }

  function onCancel() {
    setError(null);
    setPreview(null);
    setBundle(null);
    setOverrides({});
    setPhase("idle");
  }

  async function run(label: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setPhase("working");
    const res = await reach(fn, LOST_ACTION);
    if (!res.ok && res.error) setError(res.error);
    else if (label) setToast(label);
    setPhase("idle");
    await refresh();
  }

  function toggleReject(migrationKey: string) {
    setOverrides((o) => {
      const set = new Set(o.rejectedMigrations ?? []);
      if (set.has(migrationKey)) set.delete(migrationKey);
      else set.add(migrationKey);
      return { ...o, rejectedMigrations: [...set] };
    });
  }

  function chooseRetire(presenceKey: string, copyId: string) {
    setOverrides((o) => ({
      ...o,
      retireChoice: { ...(o.retireChoice ?? {}), [presenceKey]: [copyId] },
    }));
  }

  return (
    <div
      style={{ maxWidth: 940, margin: "0 auto", padding: "18px 14px", display: "grid", gap: 16 }}
    >
      <div className="panel" style={{ padding: 16 }}>
        <h1 className="u" style={{ fontSize: 18, letterSpacing: "0.1em", marginBottom: 8 }}>
          Sync
        </h1>
        <p style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 14, maxWidth: 560 }}>
          Import the CSV you exported from Dex to bring your collection up to date. New cards are
          added right away. Anything that would remove or change a card waits for your OK, and you
          can always undo the last sync.
        </p>
        <label className="btn btn-primary" style={{ cursor: busy ? "wait" : "pointer" }}>
          {phase === "parsing" ? "Reading…" : "Import Dex export"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        {busy ? <ProgressBar label={busyLabel} /> : null}
      </div>

      {/* While a preview is open its error shows beside Apply, where she is looking (UIL-139). */}
      {error && preview === null ? <ErrorPanel message={error} /> : null}

      {/* The last sync's result sits right under the import, where the eye goes after importing. */}
      <UndoBar
        state={state}
        busy={busy}
        pending={preview !== null}
        onUndo={() => run("Reverted the last sync.", undoLastSync)}
      />

      {preview ? (
        <PreviewPanel
          preview={preview}
          overrides={overrides}
          busy={busy}
          error={error}
          onToggleReject={toggleReject}
          onChooseRetire={chooseRetire}
          onApply={onApply}
          onCancel={onCancel}
        />
      ) : null}

      {/* A count that does not add up is a problem to act on, so it comes before the routine panels. */}
      {state.countCheck.status === "mismatch" ? <CountCheckPanel check={state.countCheck} /> : null}

      <StandInSwapPanel
        swapped={swapped}
        unsure={state.standIns.unsure}
        kept={state.standIns.kept}
        busy={busy}
        search={searchCatalog}
        onSwap={(standInId, realId) =>
          run("Swapped your stand-in for the real card.", () =>
            swapStandInAction(standInId, realId),
          )
        }
        onFix={(standInId, fix) =>
          run("Stand-in fixed and checked against the catalog again.", () =>
            fixStandInAction(standInId, fix),
          )
        }
        onKeep={(standInId, candidateIds) =>
          run("Kept as a stand-in. You will be asked again only if a new match appears.", () =>
            keepStandInAction(standInId, candidateIds),
          )
        }
        onReviewAgain={(standInId) => run(null, () => reviewStandInAgainAction(standInId))}
        onDismissSwapped={() => setSwapped([])}
      />

      {withheld ? (
        <WithheldNotice
          notice={withheld}
          busy={busy}
          onKeep={() => setWithheld(null)}
          onAddBack={() =>
            run(null, async () => {
              const r = await restoreWithheldAction(withheld.entryId);
              if (r.ok) {
                setWithheld(null);
                setToast(
                  r.alreadyRestored
                    ? "Already added back."
                    : r.restored > 0
                      ? `Added back ${r.restored} ${withheld.name}. Ready to place.`
                      : "Nothing to add back: the removal no longer applies.",
                );
              }
              return r;
            })
          }
        />
      ) : null}

      <QueuePanel
        state={state}
        busy={busy}
        onRetry={() =>
          run(null, async () => {
            const r = await retryUnresolvedNow();
            if (r.ok)
              setToast(
                r.applied
                  ? `${r.promoted} card(s) matched — ready to place.`
                  : "Still waiting — none of these are in the catalog yet.",
              );
            return r;
          })
        }
        onMatch={setMatching}
        onDismiss={(id) => run("Dismissed.", () => dismissEntryAction(id))}
        onUndismiss={(id) => run("Back in the list.", () => undismissEntryAction(id))}
      />

      {/* Routine status and rarely-needed tools: quiet, at the bottom, folded until asked for. */}
      {state.countCheck.status !== "mismatch" ? <CountCheckPanel check={state.countCheck} /> : null}

      <RemovedCardsPanel
        removed={state.removed}
        busy={busy}
        onAddBack={(card) =>
          run(null, async () => {
            const r = await restoreRemovedAction(card.catalogCardId, card.dexVariantRaw);
            if (r.ok) {
              setToast(
                r.alreadyRestored
                  ? "Already added back."
                  : r.restored > 0
                    ? `Added back ${r.restored} ${card.name}. Ready to place.`
                    : "Nothing to add back: your Dex file no longer lists it.",
              );
            }
            return r;
          })
        }
      />

      <AliasPanel
        aliases={state.aliases}
        busy={busy}
        onForget={(a) =>
          run(null, async () => {
            const r = await forgetSetAliasAction(a.locale, a.dexCode);
            if (r.ok)
              setToast(
                r.reparked > 0
                  ? `Forgot ${a.dexCode} → ${a.tcgdexSetId}. ${r.reparked} card(s) back to waiting on catalog.`
                  : `Forgot ${a.dexCode} → ${a.tcgdexSetId}. No waiting cards were affected.`,
              );
            return r;
          })
        }
      />

      {matching ? (
        <MatchOverlay
          entry={matching}
          aliasNote={aliasNote(state.aliases, matching)}
          cardTypes={state.cardTypes}
          onClose={() => setMatching(null)}
          onStandIn={async (input) => {
            // UIL-060 Half 1: create the stand-in and match in one transaction. A twin comes back as a
            // refusal the overlay renders with "match to it instead"; only a success closes it.
            const r = await reach(() => createStandInAndMatch(matching.id, input), LOST_ACTION);
            if (r.ok) {
              setMatching(null);
              setToast("Created a stand-in and matched — ready to place.");
              await refresh();
            } else if (!("twin" in r)) {
              setError(r.error);
            }
            return r;
          }}
          onPicked={async (tcgdexId) => {
            const entry = matching;
            setMatching(null);
            await run(null, async () => {
              const r = await manualMatchEntry(entry.id, tcgdexId);
              if (!r.ok) return r;
              if (r.withheld > 0) {
                // The notice says what happened; a "ready to place" toast would be wrong when nothing was added.
                setWithheld({ entryId: entry.id, name: entry.dexName, count: r.withheld });
              } else {
                setToast(
                  r.alreadyMatched
                    ? "Already matched. Nothing was added twice."
                    : r.drainedSet
                      ? "Matched — learned the set; retry to drain the rest of the set."
                      : "Matched and ready to place.",
                );
              }
              return r;
            });
          }}
        />
      ) : null}

      {toast ? (
        <div className="toast" onClick={() => setToast(null)} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/** What a match held back for a removal, as the notice shows it (UIL-099 E2). */
export interface WithheldView {
  entryId: string;
  /** The card's name as her Dex export spells it. */
  name: string;
  count: number;
}

/**
 * "You removed this card, so the match did not bring it back" (UIL-099 E2). The match itself landed; this
 * is the visible half of honouring her removal, with the one way to take the removal back.
 */
export function WithheldNotice({
  notice,
  busy,
  onAddBack,
  onKeep,
}: {
  notice: WithheldView;
  busy: boolean;
  onAddBack: () => void;
  onKeep: () => void;
}) {
  const one = notice.count === 1;
  const it = one ? "it" : "them";
  return (
    <div
      className="panel"
      role="status"
      style={{
        padding: 12,
        fontSize: 12,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      <b style={{ flexBasis: "100%" }}>
        Matched, but {notice.count} {notice.name} {one ? "was" : "were"} not added: you removed{" "}
        {one ? "this card" : "these cards"} from the app earlier.
      </b>
      <span style={{ flexBasis: "100%", color: "var(--ink-2)" }}>
        If you do have {it}, add {it} back and {one ? "it goes" : "they go"} to your Haul Plan.
      </span>
      <button type="button" className="btn btn-primary" onClick={onAddBack} disabled={busy}>
        Add {it} back
      </button>
      <button type="button" className="btn" onClick={onKeep} disabled={busy}>
        Keep {it} removed
      </button>
    </div>
  );
}

/**
 * Cards whose stored variant flag this import corrects (UIL-102), each NAMED — the public Actions log cannot
 * carry card names, so this is where she learns which to check. A card placed while it carried the wrong
 * flag says so; nothing is moved for her.
 */
export function FlagFixSection({ rows }: { rows: FlagFixRow[] }) {
  return (
    <section>
      <div className="hd u">Variant flags corrected · nothing moved</div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((f) => {
          const number = formatCollectorNumber(f.localId, f.setCardCountOfficial);
          return (
            <div key={f.copyId} className="plate" style={{ padding: 10 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <CardFace name={f.name} tcgdexId={f.catalogCardId} imageUrl={f.imageUrl} size="s" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>
                    {f.name}
                    {f.setName ? ` · ${f.setName}` : ""}
                    {number ? <span className="no"> {number}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                    Dex: {f.dexVariantRaw} · {f.change}
                  </div>
                  {f.placedNote ? (
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      <b>{f.placedNote}</b>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Cards this import hands back after a "Not mine" (UIL-111): "Not mine" lasts for the haul, Dex still lists
 * them, and they must not reappear unannounced, so each is named here and the import is a reviewed one.
 */
export function ReturningSection({ rows }: { rows: ReturningRow[] }) {
  return (
    <section>
      <div className="hd u">Coming back · you marked these Not mine</div>
      <p style={{ fontSize: 11, color: "var(--ink-2)", margin: "0 0 8px" }}>{RETURNING_NOTE}</p>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r) => {
          const number = formatCollectorNumber(r.localId, r.setCardCountOfficial);
          return (
            <div
              key={`${r.catalogCardId}|${r.dexVariantRaw}`}
              className="plate"
              style={{ padding: 10 }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <CardFace name={r.name} tcgdexId={r.catalogCardId} imageUrl={r.imageUrl} size="s" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>
                    {r.name}
                    {r.setName ? ` · ${r.setName}` : ""}
                    {number ? <span className="no"> {number}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                    Dex: {r.dexVariantRaw} · ×{r.count}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The toast after an apply. Names corrected variant flags in the preview's own words (UIL-102), and points
 * back at the preview's list, which is where the cards to check are named.
 */
export function appliedToast(
  res: Pick<ApplyOutcome, "added" | "removed" | "variantChanges" | "flagFixes">,
): string {
  const flags =
    res.flagFixes > 0
      ? ` · ${res.flagFixes} variant flag${res.flagFixes === 1 ? "" : "s"} corrected (check the pockets listed in the preview)`
      : "";
  return `Applied · ${res.added} added · ${res.removed} removed · ${res.variantChanges} variant changes${flags}. Undo available.`;
}

/**
 * The LAST SYNC bar: the sync before this one, with "Place new cards" and its Undo.
 *
 * While a preview is waiting for her Apply, both belong to the OLD sync, not to the import she is looking at: she
 * tapped "Place new cards" there, never pressed Apply, and her import looked like it had failed (2026-10-02). So
 * while one is pending, "Place new cards" is not offered at all (the new cards are not in until she applies), and
 * the old sync cannot be undone underneath the preview built on it: the bar says to apply this preview first. Once
 * she applies it, the bar is THIS sync's, with both back.
 */
function UndoBar({
  state,
  busy,
  pending,
  onUndo,
}: {
  state: SyncState | null;
  busy: boolean;
  /** A preview is waiting for her Apply. */
  pending: boolean;
  onUndo: () => void;
}) {
  if (!state?.undo.available) return null;
  const s = state.undo.summary;
  const bits = s
    ? [
        s.creates ? `${s.creates} added` : null,
        s.retires ? `${s.retires} removed` : null,
        s.variantUpdates ? `${s.variantUpdates} variant changes` : null,
        s.flagFixes ? `${s.flagFixes} variant flags corrected` : null,
        s.promotions ? `${s.promotions} resolved` : null,
      ].filter(Boolean)
    : [];
  return (
    <div
      className="panel"
      style={{ padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
    >
      <span className="tag">LAST SYNC</span>
      <span style={{ fontSize: 11, color: "var(--ink-2)", flex: 1, minWidth: 160 }}>
        {bits.length ? bits.join(" · ") : "no collection changes"}
        {state.undo.createdAt ? ` · ${waited(state.undo.createdAt)} ago` : ""}
      </span>
      {pending ? (
        <span className="u" role="note" style={{ fontSize: 11 }}>
          Apply this preview first
        </span>
      ) : (
        <Link href="/plan" className="btn" style={{ textDecoration: "none" }}>
          Place new cards
        </Link>
      )}
      <button
        type="button"
        className="btn"
        disabled={busy || pending}
        title={pending ? "Apply or cancel this preview first" : undefined}
        onClick={onUndo}
      >
        Undo last sync
      </button>
    </div>
  );
}

/**
 * A refusal or a lost call, in words, announced to a screen reader (UIL-139). `reveal` scrolls it into view when
 * it appears: the Apply button is at the bottom of a preview that can run to hundreds of rows, so an error
 * somewhere else on the page reads as a button that did nothing.
 */
export function ErrorPanel({ message, reveal }: { message: string; reveal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [message, reveal]);
  return (
    <div
      ref={ref}
      className="panel"
      role="alert"
      style={{ padding: 12, background: "#F4C86B", fontSize: 12 }}
    >
      {message}
    </div>
  );
}

/** Exported so the collector-number rendering can be pinned without driving a sync (UIL-077). */
export function PreviewPanel({
  preview,
  overrides,
  busy,
  error,
  onToggleReject,
  onChooseRetire,
  onApply,
  onCancel,
}: {
  preview: SyncPreview;
  overrides: SyncOverrides;
  busy: boolean;
  /** Why the last Apply did not go through; shown right above Apply, not at the top of the page (UIL-139). */
  error?: string | null;
  onToggleReject: (migrationKey: string) => void;
  onChooseRetire: (presenceKey: string, copyId: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { sections } = preview;
  const rejected = new Set(overrides.rejectedMigrations ?? []);
  return (
    <div className="panel" style={{ padding: 16, display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">PREVIEW</span>
        <strong style={{ fontSize: 12, letterSpacing: "0.06em" }}>
          {preview.summary.summaryLine}
        </strong>
      </div>

      {sections.removals.length > 0 ? (
        <section>
          <div className="hd u">Leaving your collection · check these</div>
          <div style={{ display: "grid", gap: 8 }}>
            {sections.removals.map((r) => {
              const opts = preview.retireOptions[r.presenceKey] ?? [];
              const canSwap = opts.length > 1;
              const chosen = overrides.retireChoice?.[r.presenceKey]?.[0] ?? r.copyId;
              return (
                <div key={r.copyId} className="plate" style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <CardFace
                      name={r.name}
                      tcgdexId={r.catalogCardId}
                      imageUrl={r.imageUrl}
                      size="s"
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>
                        {r.name}{" "}
                        {formatCollectorNumber(r.localId, r.setCardCountOfficial) ? (
                          <span className="no">
                            {formatCollectorNumber(r.localId, r.setCardCountOfficial)}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                        {r.dexVariantRaw} · {r.consequenceLabel}
                        {r.placementLabel ? ` · ${r.placementLabel}` : ""}
                      </div>
                      {r.needsReview ? (
                        <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>
                          BINDER BLOCK — kept as-is; free it from the line detail if you want the
                          pockets back.
                        </div>
                      ) : null}
                    </div>
                    <BandChip bandKey={r.bandKey} />
                  </div>
                  {canSwap ? (
                    <label style={{ display: "block", marginTop: 8, fontSize: 11 }}>
                      Which copy leaves:{" "}
                      <select
                        value={chosen}
                        disabled={busy}
                        onChange={(e) => onChooseRetire(r.presenceKey, e.target.value)}
                      >
                        {opts.map((o) => (
                          <option key={o.copyId} value={o.copyId}>
                            {o.label || "unplaced"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {sections.flagFixes.length > 0 ? <FlagFixSection rows={sections.flagFixes} /> : null}

      {(sections.returning ?? []).length > 0 ? (
        <ReturningSection rows={sections.returning} />
      ) : null}

      {sections.variantChanges.length > 0 ? (
        <section>
          <div className="hd u">Variant changes · stays in its pocket</div>
          <div style={{ display: "grid", gap: 8 }}>
            {sections.variantChanges.map((v) => {
              const isRejected = rejected.has(v.migrationKey);
              return (
                <div key={v.copyId} className="plate" style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <CardFace
                      name={v.name}
                      tcgdexId={v.catalogCardId}
                      imageUrl={v.imageUrl}
                      size="s"
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>
                        {v.name}{" "}
                        {formatCollectorNumber(v.localId, v.setCardCountOfficial) ? (
                          <span className="no">
                            {formatCollectorNumber(v.localId, v.setCardCountOfficial)}
                          </span>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-2)",
                          textDecoration: isRejected ? "line-through" : "none",
                        }}
                      >
                        {v.fromVariantRaw} → {v.toVariantRaw} · placement preserved
                      </div>
                      {isRejected ? (
                        <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>
                          Treated as a different card: the old one is removed and this one is added
                          new, so its pocket is freed.
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => onToggleReject(v.migrationKey)}
                    >
                      {isRejected ? "Keep as migration" : "Not the same card"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {sections.additions.length > 0 ? (
        <section>
          <div className="hd u">New cards · ready to place after you apply</div>
          <div style={{ display: "grid", gap: 6 }}>
            {sections.additions.map((a) => (
              <div
                key={`${a.catalogCardId} ${a.dexVariantRaw}`}
                style={{ display: "flex", gap: 10, alignItems: "center" }}
              >
                <CardFace name={a.name} tcgdexId={a.catalogCardId} imageUrl={a.imageUrl} size="s" />
                <span style={{ flex: 1 }}>
                  {a.name}{" "}
                  {formatCollectorNumber(a.localId, a.setCardCountOfficial) ? (
                    <span className="no">
                      {formatCollectorNumber(a.localId, a.setCardCountOfficial)}
                    </span>
                  ) : null}{" "}
                  · {a.dexVariantRaw}
                </span>
                <BandChip bandKey={a.bandKey} />
                <span className="tag">×{a.count}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {sections.unresolved.newParks.length > 0 || sections.unresolved.stillWaiting > 0 ? (
        <section>
          <div className="hd u">Not matched yet</div>
          <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
            {sections.unresolved.newParks.length} new from this import ·{" "}
            {sections.unresolved.stillWaiting} waiting in total. Nothing is lost: they are listed
            under Cards to match below and match on their own once the card is in the catalog.
          </div>
        </section>
      ) : null}

      {sections.unresolved.forgottenDismissed > 0 ? (
        <section>
          <div className="hd u">Dismissed rows</div>
          <div style={{ fontSize: 11, color: "var(--ink-2)" }} data-testid="forgotten-dismissed">
            {forgottenDismissedLine(sections.unresolved.forgottenDismissed)}
          </div>
        </section>
      ) : null}

      <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
        {sections.unchanged} cards unchanged — left exactly as they are.
      </div>

      {error ? <ErrorPanel message={error} reveal /> : null}

      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onApply}>
          Apply
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Cards from her export the app could not match yet. The healthy state is one quiet line. When there are some, the
 * ones she can act on ("Needs your match") come first; the ones that fix themselves ("Waiting on catalog") come
 * second and say so; dismissed rows are folded away.
 */
function QueuePanel({
  state,
  busy,
  onRetry,
  onMatch,
  onDismiss,
  onUndismiss,
}: {
  state: SyncState | null;
  busy: boolean;
  onRetry: () => void;
  onMatch: (e: QueueEntryView) => void;
  onDismiss: (id: string) => void;
  onUndismiss: (id: string) => void;
}) {
  if (!state) return null;
  const { waiting, dismissed, counts } = state;
  const needs = waiting.unknownCard.length;
  const parked = waiting.unknownSet.length;
  if (counts.waiting === 0 && dismissed.length === 0) {
    return (
      <div className="panel" style={{ padding: 12, fontSize: 12 }} data-testid="queue-empty">
        <b>✓ Every card in your export is matched.</b>
      </div>
    );
  }
  const headline = [
    needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} your match` : null,
    parked > 0 ? `${parked} waiting on the catalog` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="panel" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">CARDS TO MATCH</span>
        <span style={{ fontSize: 11, color: "var(--ink-2)", flex: 1 }}>
          {headline || "Nothing waiting"}
        </span>
        {counts.waiting > 0 ? (
          <button type="button" className="btn sm" disabled={busy} onClick={onRetry}>
            Check again
          </button>
        ) : null}
      </div>

      <QueueGroup
        title="Needs your match"
        note="The set is known, but this card was not found in it. Pick the right card."
        entries={waiting.unknownCard}
        busy={busy}
        onMatch={onMatch}
        onDismiss={onDismiss}
      />
      <QueueGroup
        title="Waiting on catalog"
        note="This set is not in the catalog yet. These match on their own once it is. Nothing is lost."
        entries={waiting.unknownSet}
        busy={busy}
        onMatch={onMatch}
        onDismiss={onDismiss}
      />

      {dismissed.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 11 }}>
            <b>Dismissed</b> ({dismissed.length}) — left out of your collection.
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {dismissed.map((e) => (
              <div
                key={e.id}
                style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}
              >
                <span style={{ flex: 1, color: "var(--ink-2)" }}>
                  {e.dexName || e.dexId} · {e.dexSetName} {e.dexNumber} · {e.dexVariantRaw}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => onUndismiss(e.id)}
                >
                  Bring back
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function QueueGroup({
  title,
  note,
  entries,
  busy,
  onMatch,
  onDismiss,
}: {
  title: string;
  /** One plain line: what this group means and whether she needs to do anything. */
  note: string;
  entries: QueueEntryView[];
  busy: boolean;
  onMatch: (e: QueueEntryView) => void;
  onDismiss: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <div className="hd u">
        {title} · {entries.length}
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-2)", margin: "0 0 8px" }}>{note}</p>
      <div style={{ display: "grid", gap: 8 }}>
        {entries.map((e) => (
          <div key={e.id} className="plate" style={{ padding: 10 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>
                  {e.dexName || e.dexId}{" "}
                  {e.dexNumber ? <span className="no">{e.dexNumber}</span> : null}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                  {e.dexSetName} · {e.dexVariantRaw} · ×{e.quantity} · waited{" "}
                  {waited(e.firstSeenSync)}
                </div>
              </div>
              <button type="button" className="btn sm" disabled={busy} onClick={() => onMatch(e)}>
                Match manually
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => onDismiss(e.id)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Learned set aliases (UIL-047 C3, second half) — an edge-case tool, so it lives folded under "Advanced" at the
 * bottom of the page and is absent until something has been learned. Each row is one `(locale, code) → set` the app
 * has been taught; every card from that Dex set resolves through it. Forgetting is two-step and inline: the first
 * tap opens the consequences UNDER the row, the second tap forgets. Nothing happens without the condition being
 * named first.
 */
function AliasPanel({
  aliases,
  busy,
  onForget,
}: {
  aliases: LearnedAliasView[];
  busy: boolean;
  onForget: (a: LearnedAliasView) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (aliases.length === 0) return null;
  return (
    <details className="panel" style={{ padding: 12, fontSize: 12 }} data-testid="sync-advanced">
      <summary style={{ cursor: "pointer" }}>
        <b>Advanced</b> · set codes the app has learned ({aliases.length})
      </summary>
      <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="tag">LEARNED SET ALIASES</span>
          <span style={{ fontSize: 11, color: "var(--ink-2)", flex: 1 }}>
            {aliases.length} learned · a Dex set code the app reads as one catalog set. You only
            need this if a whole set is landing on the wrong cards: forget its code here, then match
            one of its cards by hand.
          </span>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {aliases.map((a) => {
            const key = aliasKeyOf(a);
            const open = confirming === key;
            return (
              <div key={key} className="plate" style={{ padding: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>
                      {a.dexCode} → {a.tcgdexSetId}{" "}
                      <span className="tag">
                        {a.source === "manual" ? "YOU TAUGHT IT" : "FROM THE SET NAME"}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                      {localeLabel(a.locale)}
                      {a.dexSetName ? ` · ${a.dexSetName}` : ""} · learned {waited(a.createdAt)} ago
                      {a.reparks > 0 ? ` · ${a.reparks} waiting card(s) resolve through it` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => setConfirming(open ? null : key)}
                  >
                    {open ? "Keep it" : "Forget…"}
                  </button>
                </div>

                {open ? (
                  <div
                    style={{
                      marginTop: 8,
                      display: "grid",
                      gap: 6,
                      fontSize: 11,
                      color: "var(--ink-2)",
                    }}
                  >
                    <div>
                      {a.reparks > 0
                        ? `${a.reparks} card(s) under "Needs your match" go back to "Waiting on catalog" — their set will be unknown again.`
                        : "No waiting cards are affected."}
                    </div>
                    <div>
                      Cards already matched through it stay exactly where they are. Your next import
                      re-checks every card from this set and lists anything it can no longer place
                      as a removal, for your review.
                    </div>
                    <div>
                      {a.source === "name-resolved"
                        ? "This one was learned from the set name, so the next import learns it again if the name still matches."
                        : "To teach a different set, match any card from this set by hand afterwards."}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          onForget(a);
                        }}
                      >
                        Forget alias
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

export function MatchOverlay({
  entry,
  aliasNote,
  cardTypes,
  onClose,
  onPicked,
  onStandIn,
}: {
  entry: QueueEntryView;
  /** Which learned set alias this entry's set rests on, if any (UIL-047 C3): the thing to forget if it is wrong. */
  aliasNote?: string | null;
  /** Every card type the band map knows — the Pokémon stand-in's type pick (UIL-060). */
  cardTypes: string[];
  onClose: () => void;
  onPicked: (tcgdexId: string) => void;
  /** UIL-060 Half 1: create a stand-in and match to it. Resolves with the outcome so a twin refusal
   *  can be shown in place, with the existing stand-in offered. */
  onStandIn: (input: StandInFormInput) => Promise<StandInOutcome>;
}) {
  return (
    <div className="veil on" onClick={onClose}>
      <div className="dsheet panel" onClick={(e) => e.stopPropagation()}>
        <div className="cap">
          <span className="t">MANUAL MATCH</span>
          <span className="n">{entry.dexName || entry.dexId}</span>
          <button
            type="button"
            className="btn sm"
            style={{ background: "var(--panel-2)", color: "var(--ink)" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="body" style={{ padding: 14, display: "grid", gap: 12 }}>
          <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
            {entry.dexSetName} · #{entry.dexNumber} · {entry.dexVariantRaw} · ×{entry.quantity}
          </div>
          <p style={{ fontSize: 11, color: "var(--ink-2)" }}>
            Search for the real card and tap it. If its set was unknown, the app learns the set and
            the rest of that set matches on the next check.
          </p>
          {aliasNote ? (
            <p style={{ fontSize: 10, color: "var(--ink-3)" }}>
              {aliasNote}. If that set is wrong, forget it under Advanced at the bottom of the Sync
              page.
            </p>
          ) : null}
          <CardResultsGrid
            search={searchCatalog}
            onPick={(card) => onPicked(card.tcgdexId)}
            placeholder="Find the real card…"
          />
          <StandInForm
            entry={entry}
            cardTypes={cardTypes}
            onStandIn={onStandIn}
            onPicked={onPicked}
          />
        </div>
      </div>
    </div>
  );
}
