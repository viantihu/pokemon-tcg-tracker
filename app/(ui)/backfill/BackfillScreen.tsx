"use client";

/**
 * Backfill wizard — load the existing physical collection through the app (scr backfill; dev-spec
 * §5 M5; system-design §7A). Re-runnable per binder.
 *
 * Three entry modes, matching the way the cards physically sit:
 *   • FRONT HALF — a flat, ordered sequence; band auto-computed from card type (never typed).
 *   • BACK HALF  — line by line: pick a species + colour, then mark each stage FILLED / a wishlist
 *                  placeholder / a block (a repurposed-duplicate block records WHICH card). A
 *                  terminated line offers no fillable slot.
 *   • SPECIALTY  — a flat list, each card optionally tagged into collections.
 *
 * All catalog access + writes are server-side via server actions; the client never touches TCGdex.
 *
 * EVERY CARD SHE OWNS IS PICKED FROM HER HAUL (UIL-098). Backfill places copies her Dex import made and
 * creates none, so the four card-she-owns pickers (front half, a FILLED stage, a repurposed duplicate,
 * specialty) search only what is waiting (`searchWaiting`), one tile per printing + Dex variant with how
 * many are waiting. The variant is Dex's, shown and never chosen. The species picker that starts a line
 * still searches the catalog: it chooses a chain, not a card she owns.
 */

import { useEffect, useMemo, useState } from "react";
import { band, type LineStatus, type SlotState } from "@/lib/engine";
import type { BackLineStageInfo, BackLineStageInput, ResolvedBackLine } from "@/lib/backfill";
import { BandChip } from "../_components/BandChip";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { bandMeta } from "../_components/plan-meta";
import type { LookupCard } from "../plan/plan-types";
import {
  commitFrontAction,
  commitLineAction,
  commitSpecialtyAction,
  loadContext,
  lookupCatalog,
  resolveLine,
  searchWaiting,
} from "./actions";
import type { BackfillContextPayload, WaitingCard } from "./backfill-types";

type Mode = "front" | "back" | "specialty";

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `bf-${Math.random().toString(36).slice(2)}`;
}

type Banner = { kind: "ok" | "err"; text: string } | null;

/** What a card-she-owns picker says when nothing waiting matches (UIL-098). */
export const NOT_WAITING_EMPTY =
  "Not waiting in your haul. Add it in Dex, import it on the Sync page, then pick it here.";

type Pick = { tcgdexId: string; dexVariantRaw: string };
const pickKey = (p: Pick) => `${p.tcgdexId} ${p.dexVariantRaw}`;

/**
 * The waiting search minus what this form has already picked, so a tile never offers the same copy twice
 * and its count is what is really left. Memoised on the picks: the grid re-runs its search whenever the
 * function changes, so a fresh closure every render would search in a loop.
 */
function useWaitingSearch(picks: Pick[]): (query: string) => Promise<WaitingCard[]> {
  const sig = picks.map(pickKey).sort().join("|");
  return useMemo(() => {
    const used = new Map<string, number>();
    for (const k of sig ? sig.split("|") : []) used.set(k, (used.get(k) ?? 0) + 1);
    return async (query: string) =>
      (await searchWaiting(query)).flatMap((c) => {
        const left = c.waiting - (used.get(pickKey(c)) ?? 0);
        return left > 0
          ? [{ ...c, waiting: left, badge: `${c.dexVariantRaw} · ${left} waiting` }]
          : [];
      });
  }, [sig]);
}

/** A picked card's Dex variant, shown as the row's variant: Dex owns it (sync-architecture §1.1). */
function WaitingTag({ card }: { card: WaitingCard }) {
  return (
    <span className="tag u" title="From your Dex import">
      Waiting from sync · {card.dexVariantRaw}
    </span>
  );
}

export function BackfillScreen() {
  const [ctx, setCtx] = useState<BackfillContextPayload | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [binderId, setBinderId] = useState<string>("");
  const [mode, setMode] = useState<Mode>("front");
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    let live = true;
    loadContext()
      .then((c) => {
        if (!live) return;
        setCtx(c);
        const first = c.binders[0];
        if (first) {
          setBinderId(first.id);
          setMode(first.type === "specialty" ? "specialty" : "front");
        }
      })
      .catch(
        (e) => live && setCtxError(e instanceof Error ? e.message : "Could not load binders."),
      );
    return () => {
      live = false;
    };
  }, []);

  const binder = ctx?.binders.find((b) => b.id === binderId) ?? null;

  function pickBinder(id: string) {
    setBinderId(id);
    setBanner(null);
    const b = ctx?.binders.find((x) => x.id === id);
    setMode(b?.type === "specialty" ? "specialty" : "front");
  }

  if (ctxError) {
    return (
      <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
        <span>!</span>
        <b>{ctxError}</b>
      </div>
    );
  }
  if (!ctx || !binder) {
    return (
      <div className="entry panel">
        <p style={{ fontSize: 12, color: "var(--ink-2)" }}>Loading binders…</p>
      </div>
    );
  }

  return (
    <>
      <div className="bfhead panel">
        <div className="entryhead" style={{ marginBottom: 0 }}>
          <span className="hk u" style={{ fontSize: 11, letterSpacing: "0.14em" }}>
            Backfill
          </span>
          <label className="hk u" htmlFor="bf-binder">
            Binder
          </label>
          <select
            id="bf-binder"
            className="field"
            style={{ width: "auto" }}
            value={binderId}
            onChange={(e) => pickBinder(e.target.value)}
          >
            {ctx.binders.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.type}
                {b.isActive ? " · active" : ""}
              </option>
            ))}
          </select>
          {binder.type === "general" ? (
            <div className="seg3" role="group" aria-label="Section">
              <button
                type="button"
                className={mode === "front" ? "on" : ""}
                onClick={() => setMode("front")}
              >
                Front half
              </button>
              <button
                type="button"
                className={mode === "back" ? "on" : ""}
                onClick={() => setMode("back")}
              >
                Back half
              </button>
            </div>
          ) : (
            <span className="tag">Specialty · flat list</span>
          )}
        </div>
        <p className="bfnote">
          Enter the cards as they physically sit, one binder at a time. Front halves are a flat
          ordered run; back halves go line by line. Save as often as you like — backfill is
          re-runnable per binder.
        </p>
      </div>

      {banner && (
        <div className={"alertbar" + (banner.kind === "ok" ? " ok" : "")} role="status">
          <span>{banner.kind === "ok" ? "✓" : "!"}</span>
          <b>{banner.text}</b>
        </div>
      )}

      {binder.type === "specialty" ? (
        <SpecialtyPanel ctx={ctx} binderId={binderId} onResult={setBanner} />
      ) : mode === "front" ? (
        <FrontHalfPanel ctx={ctx} binderId={binderId} onResult={setBanner} />
      ) : (
        <BackHalfPanel ctx={ctx} binderId={binderId} onResult={setBanner} />
      )}
    </>
  );
}

/* ------------------------------- front half ------------------------------- */

interface FrontRow {
  id: string;
  card: WaitingCard;
}

/**
 * One card in the front-half sequence, with its auto-computed colour band. Exported so the band
 * derivation can be rendered in a test with a Trainer/Energy card — the case where a local re-derivation
 * from `types` alone and the engine's canonical `band()` can disagree (UIL-080).
 */
export function FrontRowItem({
  row,
  typeColorMap,
  onRemove,
}: {
  row: FrontRow;
  typeColorMap: Record<string, string>;
  onRemove: () => void;
}) {
  // The engine's canonical derivation (UIL-080), not a local copy: effectiveType first — a Trainer
  // resolves to its trainerType or "Trainer", an Energy to "Colorless" — then the map, falling back to
  // the map's OWN white key rather than a literal (UIL-012). The local helper this replaces read
  // types[0] or "Colorless" straight into the map, so a Trainer could get a different band from the one
  // the haul cascade would give the same card.
  const key = band(row.card, typeColorMap);
  return (
    <span className="c" style={{ flexDirection: "column", gap: 6 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <BandChip bandKey={key} />
        <CardFace
          name={row.card.name}
          tcgdexId={row.card.tcgdexId}
          imageUrl={row.card.imageUrl}
          size="s"
        />
        <span className="tx">
          <span className="nm">{row.card.name}</span>
          {formatCollectorNumber(row.card.localId, row.card.setCardCountOfficial) ? (
            <span className="no">
              {formatCollectorNumber(row.card.localId, row.card.setCardCountOfficial)}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="iconbtn"
          onClick={onRemove}
          aria-label={`Remove ${row.card.name}`}
        >
          ✕
        </button>
      </span>
      <WaitingTag card={row.card} />
    </span>
  );
}

function FrontHalfPanel({
  ctx,
  binderId,
  onResult,
}: {
  ctx: BackfillContextPayload;
  binderId: string;
  onResult: (b: Banner) => void;
}) {
  const [rows, setRows] = useState<FrontRow[]>([]);
  const [saving, setSaving] = useState(false);
  const search = useWaitingSearch(rows.map((r) => r.card));

  function add(card: WaitingCard) {
    setRows((r) => [...r, { id: newId(), card }]);
  }
  function remove(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
  }

  async function save() {
    setSaving(true);
    onResult(null);
    try {
      const res = await commitFrontAction({
        binderId,
        half: "front",
        cards: rows.map((r) => ({
          tcgdexId: r.card.tcgdexId,
          dexVariantRaw: r.card.dexVariantRaw,
        })),
      });
      if (res.ok) {
        onResult({ kind: "ok", text: `Saved ${res.counts.placed} card(s) to the front half.` });
        setRows([]);
      } else onResult({ kind: "err", text: res.error });
    } catch (e) {
      onResult({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="entry panel">
      <div className="hd u">Front half · in order</div>
      <CardResultsGrid
        search={search}
        onPick={add}
        placeholder="Set + number or name…"
        emptyText={NOT_WAITING_EMPTY}
      />

      {rows.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add cards in the physical order they sit, from the cards waiting in your haul. The colour
          band is computed from each card&apos;s type — you never type it.
        </p>
      ) : (
        <div className="seq" style={{ marginTop: 12 }}>
          {rows.map((r) => (
            <FrontRowItem
              key={r.id}
              row={r}
              typeColorMap={ctx.typeColorMap}
              onRemove={() => remove(r.id)}
            />
          ))}
        </div>
      )}

      <div className="bfbar" style={{ marginTop: 14 }}>
        <span className="hk">
          {rows.length} card{rows.length === 1 ? "" : "s"} · front half
        </span>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          disabled={rows.length === 0 || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save front half"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- back half ------------------------------- */

interface StageEntry {
  info: BackLineStageInfo;
  decision: SlotState;
  /** FILLED: the copy she owns, picked from her haul (UIL-098). */
  filledCard: WaitingCard | null;
  blockMaterial: "basicEnergy" | "repurposedDuplicate";
  /** A repurposed duplicate is a card she owns too, so it is picked from her haul as well. */
  blockCard: WaitingCard | null;
  pocketCount: number;
}

function defaultEntry(info: BackLineStageInfo): StageEntry {
  return {
    info,
    decision: info.sameColorPrintingExists ? "placeholder" : "block",
    filledCard: null,
    blockMaterial: "basicEnergy",
    blockCard: null,
    pocketCount: 1,
  };
}

function deriveStatus(entries: StageEntry[], terminated: boolean): LineStatus {
  if (terminated) return "terminated";
  if (entries.some((e) => e.decision === "placeholder" && e.info.specialtyOnly)) return "capped";
  if (entries.length > 0 && entries.every((e) => e.decision === "filled")) return "complete";
  return "open";
}

function BackHalfPanel({
  ctx,
  binderId,
  onResult,
}: {
  ctx: BackfillContextPayload;
  binderId: string;
  onResult: (b: Banner) => void;
}) {
  const [bandKey, setBandKey] = useState<string>(ctx.bands[0]?.key ?? "red");
  const [resolved, setResolved] = useState<ResolvedBackLine | null>(null);
  const [entries, setEntries] = useState<StageEntry[]>([]);
  const [terminated, setTerminated] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);

  async function startLine(card: LookupCard) {
    setResolving(true);
    onResult(null);
    try {
      const r = await resolveLine(card.tcgdexId, bandKey);
      if (!r) {
        onResult({ kind: "err", text: "Could not find that species' evolution line." });
        return;
      }
      setResolved(r);
      setTerminated(false);
      setEntries(
        r.stages.map((info) => {
          const e = defaultEntry(info);
          // The stage she picked the species by is one she owns — but the species picker searches the
          // catalog, so the COPY still comes from her haul, picked in the stage's own row (UIL-098).
          if (info.stageIndex === r.seedStageIndex) e.decision = "filled";
          return e;
        }),
      );
    } catch (e) {
      onResult({ kind: "err", text: e instanceof Error ? e.message : "Resolve failed." });
    } finally {
      setResolving(false);
    }
  }

  function patch(stageIndex: number, next: Partial<StageEntry>) {
    setEntries((es) => es.map((e) => (e.info.stageIndex === stageIndex ? { ...e, ...next } : e)));
  }

  function reset() {
    setResolved(null);
    setEntries([]);
    setTerminated(false);
  }

  const status = deriveStatus(entries, terminated);
  const hunts = entries.filter((e) => e.decision === "placeholder").length;
  const blocks = entries.filter((e) => e.decision === "block").length;

  async function save() {
    if (!resolved) return;
    // Validate required selections.
    for (const e of entries) {
      if (e.decision === "filled" && !e.filledCard) {
        onResult({
          kind: "err",
          text: `Pick the ${e.info.stage} card you own, or mark it a hunt/block.`,
        });
        return;
      }
      if (e.decision === "block" && e.blockMaterial === "repurposedDuplicate" && !e.blockCard) {
        onResult({
          kind: "err",
          text: `Pick which duplicate was repurposed for the ${e.info.stage} block.`,
        });
        return;
      }
    }
    setSaving(true);
    onResult(null);
    try {
      const stages: BackLineStageInput[] = entries.map((e) => {
        const base = { stageIndex: e.info.stageIndex, stage: e.info.stage, dexId: e.info.dexId };
        if (e.decision === "filled") {
          return {
            ...base,
            decision: "filled" as const,
            filledTcgdexId: e.filledCard!.tcgdexId,
            filledDexVariantRaw: e.filledCard!.dexVariantRaw,
          };
        }
        if (e.decision === "placeholder") {
          return {
            ...base,
            decision: "placeholder" as const,
            targetCatalogCardId: e.info.suggestedTargetId,
            alternateCatalogCardIds: e.info.alternateTargetIds,
            specialtyOnly: e.info.specialtyOnly,
          };
        }
        return {
          ...base,
          decision: "block" as const,
          blockMaterial: e.blockMaterial,
          blockCopyTcgdexId: e.blockCard?.tcgdexId ?? null,
          blockCopyDexVariantRaw: e.blockCard?.dexVariantRaw ?? null,
          pocketCount: e.pocketCount,
        };
      });
      const res = await commitLineAction({
        binderId,
        bandKey: resolved.bandKey,
        rootDexId: resolved.rootDexId,
        requiredType: resolved.requiredType,
        terminated,
        stages,
      });
      if (res.ok) {
        onResult({
          kind: "ok",
          text: `Saved the ${bandMeta(resolved.bandKey).display} ${resolved.speciesName} line (${res.counts.slots} slots, ${res.counts.wishlist} hunts, ${res.counts.blocks} blocks).`,
        });
        reset();
      } else onResult({ kind: "err", text: res.error });
    } catch (e) {
      onResult({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="entry panel">
      <div className="hd u">Back half · line by line</div>

      {!resolved ? (
        <>
          <div className="entryhead">
            <label className="hk u" htmlFor="bf-band">
              Line colour
            </label>
            <select
              id="bf-band"
              className="field"
              style={{ width: "auto" }}
              value={bandKey}
              onChange={(e) => setBandKey(e.target.value)}
            >
              {ctx.bands.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.display}
                </option>
              ))}
            </select>
            <span className="hk" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <BandChip bandKey={bandKey} label />
            </span>
          </div>
          <CardResultsGrid
            search={lookupCatalog}
            onPick={startLine}
            placeholder="Pick a species in this line (any stage)…"
          />
          <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
            {resolving
              ? "Resolving the chain…"
              : "Choose the line colour, then pick any card of the species. The stages come from the catalog; you mark each one as owned, a wishlist hunt, or a block."}
          </p>
        </>
      ) : (
        <div className="lineform">
          <div className="cap2">
            <span>
              {bandMeta(resolved.bandKey).display} · {resolved.speciesName}
            </span>
            <span>
              {String(status).toUpperCase()}
              {hunts ? ` · ${hunts} HUNT${hunts > 1 ? "S" : ""}` : ""}
              {blocks ? ` · ${blocks} BLOCK${blocks > 1 ? "S" : ""}` : ""}
            </span>
          </div>

          {entries.map((e) => (
            <StageRow
              key={e.info.stageIndex}
              entry={e}
              otherPicks={entries.filter((o) => o !== e).flatMap(stagePicks)}
              terminated={terminated}
              onDecision={(d) => patch(e.info.stageIndex, { decision: d })}
              onFilled={(card) => patch(e.info.stageIndex, { filledCard: card })}
              onBlockMaterial={(m) => patch(e.info.stageIndex, { blockMaterial: m })}
              onBlockCard={(card) => patch(e.info.stageIndex, { blockCard: card })}
              onPocketCount={(n) => patch(e.info.stageIndex, { pocketCount: n })}
            />
          ))}

          <div className="lf" style={{ gridTemplateColumns: "70px minmax(0,1fr)" }}>
            <span className="st">STATUS</span>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={terminated}
                onChange={(ev) => setTerminated(ev.target.checked)}
              />
              Line terminated (no same-colour evolution) — offers no fillable slot
            </label>
          </div>

          <div className="lf" style={{ gridTemplateColumns: "1fr auto auto", gap: 8 }}>
            <span className="st">
              {terminated
                ? "Terminated — the strip is read-only."
                : "Mark each stage, then save the line."}
            </span>
            <button type="button" className="btn" onClick={reset} disabled={saving}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save line"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The waiting copies a stage takes as entered: its FILLED card, or its repurposed duplicate. */
function stagePicks(e: StageEntry): WaitingCard[] {
  if (e.decision === "filled" && e.filledCard) return [e.filledCard];
  if (e.decision === "block" && e.blockMaterial === "repurposedDuplicate" && e.blockCard) {
    return [e.blockCard];
  }
  return [];
}

function StageRow({
  entry,
  otherPicks,
  terminated,
  onDecision,
  onFilled,
  onBlockMaterial,
  onBlockCard,
  onPocketCount,
}: {
  entry: StageEntry;
  /** What the line's OTHER stages have picked, so this stage's picker counts what is really left. */
  otherPicks: WaitingCard[];
  terminated: boolean;
  onDecision: (d: SlotState) => void;
  onFilled: (card: WaitingCard) => void;
  onBlockMaterial: (m: "basicEnergy" | "repurposedDuplicate") => void;
  onBlockCard: (card: WaitingCard) => void;
  onPocketCount: (n: number) => void;
}) {
  const { info, decision } = entry;
  const search = useWaitingSearch(otherPicks);
  const faceClass = decision === "placeholder" ? "f ph" : decision === "block" ? "f blk" : "f";

  return (
    <div className="lf">
      <span className="st">{info.stage.toUpperCase()}</span>
      <span className={faceClass}>
        {decision === "filled" && entry.filledCard ? (
          entry.filledCard.name
        ) : decision === "placeholder" ? (
          <>
            HUNT · {info.name}
            {info.specialtyOnly ? <br /> : null}
            {info.specialtyOnly ? "SPECIALTY · CAPS LINE" : ""}
          </>
        ) : decision === "block" ? (
          <>
            BLOCK · {info.name}
            {entry.blockMaterial === "repurposedDuplicate" && entry.blockCard ? (
              <>
                <br />
                WEDGE · {entry.blockCard.name}
              </>
            ) : null}
          </>
        ) : (
          info.name
        )}
      </span>

      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {/* FILLED: which printing do you own */}
        {!terminated && decision === "filled" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {entry.filledCard ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <CardFace
                  name={entry.filledCard.name}
                  tcgdexId={entry.filledCard.tcgdexId}
                  imageUrl={entry.filledCard.imageUrl}
                  size="s"
                />
                <span className="nm" style={{ fontSize: 12 }}>
                  {entry.filledCard.name}
                  {formatCollectorNumber(
                    entry.filledCard.localId,
                    entry.filledCard.setCardCountOfficial,
                  )
                    ? ` · ${formatCollectorNumber(entry.filledCard.localId, entry.filledCard.setCardCountOfficial)}`
                    : ""}
                </span>
              </div>
            ) : (
              <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
                Pick the card you own from your haul:
              </span>
            )}
            <CardResultsGrid
              search={search}
              onPick={onFilled}
              placeholder="Which card?"
              emptyText={NOT_WAITING_EMPTY}
            />
            {entry.filledCard ? <WaitingTag card={entry.filledCard} /> : null}
          </div>
        )}

        {/* BLOCK: material + (repurposed) which card + pocket count */}
        {!terminated && decision === "block" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="variants" role="group" aria-label="Block material">
              <button
                type="button"
                className={entry.blockMaterial === "basicEnergy" ? "on" : ""}
                onClick={() => onBlockMaterial("basicEnergy")}
              >
                Basic energy
              </button>
              <button
                type="button"
                className={entry.blockMaterial === "repurposedDuplicate" ? "on" : ""}
                onClick={() => onBlockMaterial("repurposedDuplicate")}
              >
                Repurposed dup
              </button>
            </div>
            {entry.blockMaterial === "repurposedDuplicate" && (
              <CardResultsGrid
                search={search}
                onPick={onBlockCard}
                placeholder="Which duplicate was repurposed?"
                emptyText={NOT_WAITING_EMPTY}
              />
            )}
            <label
              style={{
                fontSize: 10,
                color: "var(--ink-2)",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              Pockets
              <input
                className="field"
                style={{ width: 64 }}
                type="number"
                min={1}
                value={entry.pocketCount}
                onChange={(ev) => onPocketCount(Math.max(1, Number(ev.target.value) || 1))}
              />
            </label>
          </div>
        )}

        {/* PLACEHOLDER: nothing to enter — the wishlist target + alternates come from the catalog */}
        {!terminated && decision === "placeholder" && (
          <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
            {info.suggestedTargetId
              ? `Wishlist target set · ${info.alternateTargetIds.length} alternate(s)`
              : "No same-colour printing found for the wishlist target."}
          </span>
        )}
      </div>

      {terminated ? (
        <span className="st">—</span>
      ) : (
        <span className="seg3" role="group" aria-label={`${info.stage} decision`}>
          <button
            type="button"
            className={decision === "filled" ? "on" : ""}
            onClick={() => onDecision("filled")}
          >
            Filled
          </button>
          <button
            type="button"
            className={decision === "placeholder" ? "on ph" : ""}
            disabled={!info.sameColorPrintingExists}
            title={info.sameColorPrintingExists ? undefined : "No same-colour printing to hunt"}
            onClick={() => onDecision("placeholder")}
          >
            Hunt
          </button>
          <button
            type="button"
            className={decision === "block" ? "on blk" : ""}
            onClick={() => onDecision("block")}
          >
            Block
          </button>
        </span>
      )}
    </div>
  );
}

/* -------------------------------- specialty ------------------------------- */

interface SpecRow {
  id: string;
  card: WaitingCard;
  collectionIds: string[];
}

function SpecialtyPanel({
  ctx,
  binderId,
  onResult,
}: {
  ctx: BackfillContextPayload;
  binderId: string;
  onResult: (b: Banner) => void;
}) {
  const [rows, setRows] = useState<SpecRow[]>([]);
  const [saving, setSaving] = useState(false);
  const search = useWaitingSearch(rows.map((r) => r.card));

  function add(card: WaitingCard) {
    setRows((r) => [...r, { id: newId(), card, collectionIds: [] }]);
  }
  function toggleCollection(id: string, collectionId: string) {
    setRows((r) =>
      r.map((row) => {
        if (row.id !== id) return row;
        const has = row.collectionIds.includes(collectionId);
        return {
          ...row,
          collectionIds: has
            ? row.collectionIds.filter((c) => c !== collectionId)
            : [...row.collectionIds, collectionId],
        };
      }),
    );
  }
  function remove(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
  }

  async function save() {
    setSaving(true);
    onResult(null);
    try {
      const res = await commitSpecialtyAction({
        binderId,
        cards: rows.map((r) => ({
          tcgdexId: r.card.tcgdexId,
          dexVariantRaw: r.card.dexVariantRaw,
          collectionIds: r.collectionIds,
        })),
      });
      if (res.ok) {
        onResult({
          kind: "ok",
          text: `Saved ${res.counts.placed} card(s) to the specialty binder.`,
        });
        setRows([]);
      } else onResult({ kind: "err", text: res.error });
    } catch (e) {
      onResult({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="entry panel">
      <div className="hd u">Specialty · flat list with collection tags</div>
      <CardResultsGrid
        search={search}
        onPick={add}
        placeholder="Set + number or name…"
        emptyText={NOT_WAITING_EMPTY}
      />

      {rows.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add specialty cards (ex, V, full art, collection pieces). Tag each into the collections it
          belongs to — that tag is what lets the placement cascade route future copies here.
        </p>
      ) : (
        <div className="draftlist" style={{ maxHeight: "none" }}>
          {rows.map((r) => (
            <div key={r.id} className="draftrow" style={{ alignItems: "flex-start" }}>
              <CardFace
                name={r.card.name}
                tcgdexId={r.card.tcgdexId}
                imageUrl={r.card.imageUrl}
                size="s"
              />
              <div className="di">
                <div className="nm">
                  {r.card.name}
                  {r.card.cardClass === "specialty" ? <span className="tag">specialty</span> : null}
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3 }}>
                  {(r.card.setName ?? r.card.setId ?? "").toString()}
                  {formatCollectorNumber(r.card.localId, r.card.setCardCountOfficial)
                    ? ` · ${formatCollectorNumber(r.card.localId, r.card.setCardCountOfficial)}`
                    : ""}
                </div>
                <div style={{ marginTop: 6 }}>
                  <WaitingTag card={r.card} />
                </div>
                {ctx.collections.length > 0 && (
                  <div className="taglist" role="group" aria-label="Collection tags">
                    {ctx.collections.map((c) => {
                      const on = r.collectionIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={"chiptag" + (on ? " on" : "")}
                          aria-pressed={on}
                          onClick={() => toggleCollection(r.id, c.id)}
                        >
                          {on ? "✓ " : "+ "}
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="iconbtn"
                onClick={() => remove(r.id)}
                aria-label={`Remove ${r.card.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bfbar" style={{ marginTop: 14 }}>
        <span className="hk">
          {rows.length} card{rows.length === 1 ? "" : "s"} · specialty
        </span>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: "auto" }}
          disabled={rows.length === 0 || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save specialty"}
        </button>
      </div>
    </div>
  );
}
