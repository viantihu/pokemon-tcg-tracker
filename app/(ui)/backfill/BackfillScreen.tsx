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
 */

import { useEffect, useState } from "react";
import type { LineStatus, SlotState, Variant } from "@/lib/engine";
import type { BackLineStageInfo, BackLineStageInput, ResolvedBackLine } from "@/lib/backfill";
import { BandChip } from "../_components/BandChip";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { CardLookup } from "../_components/CardLookup";
import { VariantSelector } from "../_components/VariantSelector";
import { bandMeta } from "../_components/plan-meta";
import type { LookupCard } from "../plan/plan-types";
import {
  commitFrontAction,
  commitLineAction,
  commitSpecialtyAction,
  loadContext,
  lookupCatalog,
  resolveLine,
} from "./actions";
import type { BackfillContextPayload } from "./backfill-types";

type Mode = "front" | "back" | "specialty";

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `bf-${Math.random().toString(36).slice(2)}`;
}

/** DB-key band for a card from its type — the auto-computed band the collector never types. */
function bandKeyForCard(types: string[], map: Record<string, string>): string {
  const t = types.length > 0 ? types[0] : "Colorless";
  return map[t] ?? "white";
}

type Banner = { kind: "ok" | "err"; text: string } | null;

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
  card: LookupCard;
  variant: Variant;
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
  onVariant,
}: {
  row: FrontRow;
  typeColorMap: Record<string, string>;
  onRemove: () => void;
  onVariant: (v: Variant) => void;
}) {
  const key = bandKeyForCard(row.card.types, typeColorMap);
  return (
    <span className="c" style={{ flexDirection: "column", gap: 6 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <BandChip bandKey={key} />
        <CardFace name={row.card.name} imageUrl={row.card.imageUrl} size="s" />
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
      <VariantSelector variants={row.card.variants} value={row.variant} onChange={onVariant} />
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

  function add(card: LookupCard) {
    setRows((r) => [...r, { id: newId(), card, variant: card.variants[0] ?? "normal" }]);
  }
  function setVariant(id: string, v: Variant) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, variant: v } : row)));
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
        cards: rows.map((r) => ({ tcgdexId: r.card.tcgdexId, variant: r.variant })),
      });
      if (res.ok) {
        onResult({ kind: "ok", text: `Saved ${res.counts.copies} card(s) to the front half.` });
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
      <CardLookup search={lookupCatalog} onPick={add} placeholder="Set + number or name…" />

      {rows.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add cards in the physical order they sit. The colour band is computed from each
          card&apos;s type — you never type it.
        </p>
      ) : (
        <div className="seq" style={{ marginTop: 12 }}>
          {rows.map((r) => (
            <FrontRowItem
              key={r.id}
              row={r}
              typeColorMap={ctx.typeColorMap}
              onRemove={() => remove(r.id)}
              onVariant={(v) => setVariant(r.id, v)}
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
  filledCard: LookupCard | null;
  filledVariant: Variant;
  blockMaterial: "basicEnergy" | "repurposedDuplicate";
  blockCard: LookupCard | null;
  blockVariant: Variant;
  pocketCount: number;
}

function defaultEntry(info: BackLineStageInfo): StageEntry {
  return {
    info,
    decision: info.sameColorPrintingExists ? "placeholder" : "block",
    filledCard: null,
    filledVariant: "normal",
    blockMaterial: "basicEnergy",
    blockCard: null,
    blockVariant: "normal",
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
        onResult({ kind: "err", text: "Could not resolve that species from the mirror." });
        return;
      }
      setResolved(r);
      setTerminated(false);
      setEntries(
        r.stages.map((info) => {
          const e = defaultEntry(info);
          if (info.stageIndex === r.seedStageIndex) {
            e.decision = "filled";
            e.filledCard = card;
            e.filledVariant = card.variants[0] ?? "normal";
          }
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
            filledVariant: e.filledVariant,
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
          blockCopyVariant: e.blockVariant,
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
          <CardLookup
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
              terminated={terminated}
              onDecision={(d) => patch(e.info.stageIndex, { decision: d })}
              onFilled={(card) =>
                patch(e.info.stageIndex, {
                  filledCard: card,
                  filledVariant: card.variants[0] ?? "normal",
                })
              }
              onFilledVariant={(v) => patch(e.info.stageIndex, { filledVariant: v })}
              onBlockMaterial={(m) => patch(e.info.stageIndex, { blockMaterial: m })}
              onBlockCard={(card) =>
                patch(e.info.stageIndex, {
                  blockCard: card,
                  blockVariant: card.variants[0] ?? "normal",
                })
              }
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

function StageRow({
  entry,
  terminated,
  onDecision,
  onFilled,
  onFilledVariant,
  onBlockMaterial,
  onBlockCard,
  onPocketCount,
}: {
  entry: StageEntry;
  terminated: boolean;
  onDecision: (d: SlotState) => void;
  onFilled: (card: LookupCard) => void;
  onFilledVariant: (v: Variant) => void;
  onBlockMaterial: (m: "basicEnergy" | "repurposedDuplicate") => void;
  onBlockCard: (card: LookupCard) => void;
  onPocketCount: (n: number) => void;
}) {
  const { info, decision } = entry;
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
                Pick the printing you own:
              </span>
            )}
            <CardLookup search={lookupCatalog} onPick={onFilled} placeholder="Which printing?" />
            {entry.filledCard ? (
              <VariantSelector
                variants={entry.filledCard.variants}
                value={entry.filledVariant}
                onChange={onFilledVariant}
              />
            ) : null}
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
              <CardLookup
                search={lookupCatalog}
                onPick={onBlockCard}
                placeholder="Which duplicate was repurposed?"
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
  card: LookupCard;
  variant: Variant;
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

  function add(card: LookupCard) {
    setRows((r) => [
      ...r,
      { id: newId(), card, variant: card.variants[0] ?? "normal", collectionIds: [] },
    ]);
  }
  function patch(id: string, next: Partial<SpecRow>) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...next } : row)));
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
          variant: r.variant,
          collectionIds: r.collectionIds,
        })),
      });
      if (res.ok) {
        onResult({
          kind: "ok",
          text: `Saved ${res.counts.copies} card(s) to the specialty binder.`,
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
      <CardLookup search={lookupCatalog} onPick={add} placeholder="Set + number or name…" />

      {rows.length === 0 ? (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
          Add specialty cards (ex, V, full art, collection pieces). Tag each into the collections it
          belongs to — that tag is what lets the placement cascade route future copies here.
        </p>
      ) : (
        <div className="draftlist" style={{ maxHeight: "none" }}>
          {rows.map((r) => (
            <div key={r.id} className="draftrow" style={{ alignItems: "flex-start" }}>
              <CardFace name={r.card.name} imageUrl={r.card.imageUrl} size="s" />
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
                  <VariantSelector
                    variants={r.card.variants}
                    value={r.variant}
                    onChange={(v) => patch(r.id, { variant: v })}
                  />
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
