"use client";

/**
 * Sync screen (dev-spec §5 M9; sync-ui-spec §A + §B; prototype visual language). Wraps the M4 engine
 * in its two surfaces: the preview / apply / undo flow and the unresolved queue. Thin client — all
 * parse / reconcile / apply / undo logic lives server-side in `@/lib/sync` (called via ./actions);
 * this component holds interaction state and renders the returned view-models. Reuses the shared
 * primitives (CardFace, BandChip, CardResultsGrid) and the app's 16-bit olive/cream classes.
 */

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { SyncOverrides, SyncPlanBundle, SyncPreview } from "@/lib/sync";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { BandChip } from "../_components/BandChip";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { ProgressBar } from "../_components/ProgressBar";
import {
  applySync,
  dismissEntryAction,
  forgetSetAliasAction,
  loadSyncState,
  manualMatchEntry,
  previewSync,
  retryUnresolvedNow,
  searchCatalog,
  undismissEntryAction,
  undoLastSync,
} from "./actions";
import type { LearnedAliasView, QueueEntryView, SyncState } from "./sync-types";

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

export function SyncScreen({ initialState }: { initialState: SyncState }) {
  const [state, setState] = useState<SyncState>(initialState);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [bundle, setBundle] = useState<SyncPlanBundle | null>(null);
  const [overrides, setOverrides] = useState<SyncOverrides>({});
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState<QueueEntryView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setState(await loadSyncState());
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
    const res = await previewSync(fd);
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
      // Fast-path: additions only → auto-apply + notify, no gate (sync-ui-spec §B.1).
      const applied = await applySync(res.bundle);
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
    setPhase("working");
    const res = await applySync(bundle, overrides);
    if (!res.ok) {
      setError(res.error);
      setPhase("preview");
      return;
    }
    setToast(
      `Applied · ${res.added} added · ${res.removed} removed · ${res.variantChanges} variant changes. Undo available.`,
    );
    setPreview(null);
    setBundle(null);
    setPhase("idle");
    await refresh();
  }

  function onCancel() {
    setPreview(null);
    setBundle(null);
    setOverrides({});
    setPhase("idle");
  }

  async function run(label: string | null, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setPhase("working");
    const res = await fn();
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
        <p style={{ fontSize: 11, color: "var(--ink-2)", marginBottom: 14 }}>
          Import a Dex export. Pure additions apply on their own; anything that could move a card
          stops here for your review. The last sync is always one tap to undo.
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

      {error ? (
        <div className="panel" style={{ padding: 12, background: "#F4C86B", fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      <UndoBar
        state={state}
        busy={busy}
        onUndo={() => run("Reverted the last sync.", undoLastSync)}
      />

      {preview ? (
        <PreviewPanel
          preview={preview}
          overrides={overrides}
          busy={busy}
          onToggleReject={toggleReject}
          onChooseRetire={chooseRetire}
          onApply={onApply}
          onCancel={onCancel}
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
                  ? `${r.promoted} previously-unresolved card(s) resolved — ready to place.`
                  : "No unresolved cards resolved yet.",
              );
            return r;
          })
        }
        onMatch={setMatching}
        onDismiss={(id) => run("Dismissed.", () => dismissEntryAction(id))}
        onUndismiss={(id) => run("Back in the queue.", () => undismissEntryAction(id))}
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
          onClose={() => setMatching(null)}
          onPicked={async (tcgdexId) => {
            const entryId = matching.id;
            setMatching(null);
            await run(null, async () => {
              const r = await manualMatchEntry(entryId, tcgdexId);
              if (r.ok)
                setToast(
                  r.drainedSet
                    ? "Matched — learned the set; retry to drain the rest of the set."
                    : "Matched and ready to place.",
                );
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

function UndoBar({
  state,
  busy,
  onUndo,
}: {
  state: SyncState | null;
  busy: boolean;
  onUndo: () => void;
}) {
  if (!state?.undo.available) return null;
  const s = state.undo.summary;
  const bits = s
    ? [
        s.creates ? `${s.creates} added` : null,
        s.retires ? `${s.retires} removed` : null,
        s.variantUpdates ? `${s.variantUpdates} variant changes` : null,
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
      <Link href="/plan" className="btn" style={{ textDecoration: "none" }}>
        Place new cards
      </Link>
      <button type="button" className="btn" disabled={busy} onClick={onUndo}>
        Undo last sync
      </button>
    </div>
  );
}

/** Exported so the collector-number rendering can be pinned without driving a sync (UIL-077). */
export function PreviewPanel({
  preview,
  overrides,
  busy,
  onToggleReject,
  onChooseRetire,
  onApply,
  onCancel,
}: {
  preview: SyncPreview;
  overrides: SyncOverrides;
  busy: boolean;
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
          <div className="hd u">Removals · highest risk</div>
          <div style={{ display: "grid", gap: 8 }}>
            {sections.removals.map((r) => {
              const opts = preview.retireOptions[r.presenceKey] ?? [];
              const canSwap = opts.length > 1;
              const chosen = overrides.retireChoice?.[r.presenceKey]?.[0] ?? r.copyId;
              return (
                <div key={r.copyId} className="plate" style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <CardFace name={r.name} imageUrl={r.imageUrl} size="s" />
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

      {sections.variantChanges.length > 0 ? (
        <section>
          <div className="hd u">Variant changes · placement preserved</div>
          <div style={{ display: "grid", gap: 8 }}>
            {sections.variantChanges.map((v) => {
              const isRejected = rejected.has(v.migrationKey);
              return (
                <div key={v.copyId} className="plate" style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <CardFace name={v.name} imageUrl={v.imageUrl} size="s" />
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
                          REJECTED — will be a real remove + a real add; placement released.
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
          <div className="hd u">Additions · headed to the cascade unplaced</div>
          <div style={{ display: "grid", gap: 6 }}>
            {sections.additions.map((a) => (
              <div
                key={`${a.catalogCardId} ${a.dexVariantRaw}`}
                style={{ display: "flex", gap: 10, alignItems: "center" }}
              >
                <CardFace name={a.name} imageUrl={a.imageUrl} size="s" />
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
          <div className="hd u">Unresolved · waiting on catalog</div>
          <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
            {sections.unresolved.newParks.length} newly parked · {sections.unresolved.stillWaiting}{" "}
            waiting total. These are safe — nothing is lost; they resolve automatically once the
            card is in the catalog.
          </div>
        </section>
      ) : null}

      <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
        {sections.unchanged} cards unchanged — left exactly as they are.
      </div>

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
  const empty = counts.waiting === 0 && counts.dismissed === 0;
  // "Needs your match" means the set IS known. When that is only because of a learned alias, say which
  // one — that alias is the thing to forget if the set was taught wrong (UIL-047 C3).
  const aliasByKey = new Map(state.aliases.map((a) => [aliasKeyOf(a), a]));
  const aliasHint = (e: QueueEntryView): string | null => {
    const a = aliasByKey.get(e.aliasKey);
    return a ? `set known through the learned alias ${a.dexCode} → ${a.tcgdexSetId}` : null;
  };
  return (
    <div className="panel" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">UNRESOLVED QUEUE</span>
        <span style={{ fontSize: 11, color: "var(--ink-2)", flex: 1 }}>
          {counts.waiting} waiting on catalog
        </span>
        <button type="button" className="btn sm" disabled={busy} onClick={onRetry}>
          Retry now
        </button>
      </div>

      {empty ? (
        <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
          Nothing waiting. This is the healthy, normal state.
        </div>
      ) : null}

      <QueueGroup
        title="Waiting on catalog"
        entries={waiting.unknownSet}
        busy={busy}
        onMatch={onMatch}
        onDismiss={onDismiss}
      />
      <QueueGroup
        title="Needs your match"
        entries={waiting.unknownCard}
        busy={busy}
        hint={aliasHint}
        onMatch={onMatch}
        onDismiss={onDismiss}
      />

      {dismissed.length > 0 ? (
        <section>
          <div className="hd u">Dismissed</div>
          <div style={{ display: "grid", gap: 6 }}>
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
                  Un-dismiss
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function QueueGroup({
  title,
  entries,
  busy,
  hint,
  onMatch,
  onDismiss,
}: {
  title: string;
  entries: QueueEntryView[];
  busy: boolean;
  /** An optional one-line note under an entry (e.g. which learned alias its set came from). */
  hint?: (e: QueueEntryView) => string | null;
  onMatch: (e: QueueEntryView) => void;
  onDismiss: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <div className="hd u">
        {title} · {entries.length}
      </div>
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
                {hint?.(e) ? (
                  <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>{hint(e)}</div>
                ) : null}
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
 * Learned set aliases (UIL-047 C3, second half). Each row is one `(locale, code) → set` the app has been
 * taught; every card from that Dex set resolves through it. Forgetting is two-step and inline: the first
 * tap opens the consequences UNDER the row (how many queue entries change, what does not change, what
 * the next import will do), the second tap forgets. Nothing is gated silently and nothing happens
 * without the condition being named first.
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
  return (
    <div className="panel" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">LEARNED SET ALIASES</span>
        <span style={{ fontSize: 11, color: "var(--ink-2)", flex: 1 }}>
          {aliases.length} learned · a Dex set code the app reads as one TCGdex set. Every card from
          that set resolves through it, so a wrong one mis-files the whole set.
        </span>
      </div>

      {aliases.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
          Nothing learned yet. Matching a card whose set is unknown teaches one.
        </div>
      ) : (
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
      )}
    </div>
  );
}

function MatchOverlay({
  entry,
  onClose,
  onPicked,
}: {
  entry: QueueEntryView;
  onClose: () => void;
  onPicked: (tcgdexId: string) => void;
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
            Pin this to the real catalog card. Matching a card whose set is unknown teaches the app
            that set, so the rest of it drains on the next retry.
          </p>
          <CardResultsGrid
            search={searchCatalog}
            onPick={(card) => onPicked(card.tcgdexId)}
            placeholder="Find the real card…"
          />
        </div>
      </div>
    </div>
  );
}
