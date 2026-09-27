"use client";

/**
 * Backfill wizard — load the existing physical collection through the app (scr backfill; dev-spec
 * §5 M5; system-design §7A). Re-runnable per binder.
 *
 * Three entry modes, matching the way the cards physically sit:
 *   • FRONT HALF — a flat, ordered sequence; band auto-computed from card type (never typed).
 *   • BACK HALF  — line by line: pick a species + colour, then decide each stage: FILLED / a wishlist
 *                  hunt / left empty / a block (a repurposed-duplicate block records WHICH card). Every
 *                  stage opens undecided and the line saves only once she has decided them all: a stage
 *                  goes on her wishlist only when she adds it (UIL-119, UIL-117 PR 5). A terminated line
 *                  hunts nothing.
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
import { band } from "@/lib/engine";
import type { BackLineStageInfo, BackLineStageInput, ResolvedBackLine } from "@/lib/backfill";
import { mixedLanguageNote } from "@/lib/backfill/language";
import { localeOfId } from "@/lib/catalog/locale";
import { LINE_ROW_POCKETS, lineStatusOf, stageLabel } from "@/lib/line/popup";
import { BandChip } from "../_components/BandChip";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { bandMeta } from "../_components/plan-meta";
import { isUnreached, LOST, reach } from "../_components/reach";
import { NoBinderNotice } from "../_components/NoBinderNotice";
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
    // Through `reach` (UIL-109): a failed load says so in the shared words, never the raw error text.
    void reach(() => loadContext(), LOST.load).then((c) => {
      if (!live) return;
      if (isUnreached(c)) {
        setCtxError(c.error);
        return;
      }
      setCtx(c);
      const first = c.binders[0];
      if (first) {
        setBinderId(first.id);
        setMode(first.type === "specialty" ? "specialty" : "front");
      }
    });
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
  // UIL-127a: a new account has no binder yet. Say so, and where to add one; this used to spin forever.
  if (ctx && ctx.binders.length === 0) return <NoBinderNotice />;
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
      // The commit returns `{ ok }` for its own failures, so a throw is a call that never arrived (UIL-109).
      const res = await reach(
        () =>
          commitFrontAction({
            binderId,
            half: "front",
            cards: rows.map((r) => ({
              tcgdexId: r.card.tcgdexId,
              dexVariantRaw: r.card.dexVariantRaw,
            })),
          }),
        LOST.action,
      );
      if (res.ok) {
        onResult({ kind: "ok", text: `Saved ${res.counts.placed} card(s) to the front half.` });
        setRows([]);
      } else onResult({ kind: "err", text: res.error });
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

/**
 * Her choice for a stage (UIL-117 C; UIL-121): the card she has (from her haul), chase a card (her wishlist add),
 * leave it empty (nothing on her wishlist), or a filler in its pocket (a basic energy, or a spare card from her haul).
 * Null until she decides; nothing is decided for her. The shared parts (pick another card to chase, a placeholder
 * card) come with the line sheet; this row chases the suggested card.
 */
type StageChoice = "have" | "chase" | "empty" | "filler";

interface StageEntry {
  info: BackLineStageInfo;
  choice: StageChoice | null;
  /** HAVE: the copy she has, picked from her haul (UIL-098). */
  haveCard: WaitingCard | null;
  fillerMaterial: "energy" | "card";
  /** A filler card is a spare she has too, so it is picked from her haul as well. */
  fillerCard: WaitingCard | null;
}

function defaultEntry(info: BackLineStageInfo): StageEntry {
  return { info, choice: null, haveCard: null, fillerMaterial: "energy", fillerCard: null };
}

/** The status the server will write (`lineStatusOf`), previewed: CLOSED unless a stage is chased or undecided. */
function previewStatus(entries: StageEntry[]): "open" | "closed" {
  return lineStatusOf(
    entries.map((e) =>
      e.choice === "have"
        ? { state: "filled" }
        : { state: e.choice === "filler" ? "block" : "placeholder", stageChoice: e.choice },
    ),
  );
}

/** What fills a complete short line's third pocket (UIL-121 Q4), until she picks. */
interface ThirdPocketEntry {
  material: "energy" | "card" | "empty" | null;
  card: WaitingCard | null;
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
  /** The card she picked the species by: the server resolves the same chain from it to check her line. */
  const [seedId, setSeedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<StageEntry[]>([]);
  const [third, setThird] = useState<ThirdPocketEntry>({ material: null, card: null });
  const [mixedOk, setMixedOk] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);

  async function startLine(card: LookupCard) {
    setResolving(true);
    onResult(null);
    try {
      // A read that throws for a server failure too, so its words name no single cause (UIL-109).
      const r = await reach(() => resolveLine(card.tcgdexId, bandKey), LOST.load);
      if (isUnreached(r)) {
        onResult({ kind: "err", text: r.error });
        return;
      }
      if (!r) {
        onResult({ kind: "err", text: "Could not find that species' evolution line." });
        return;
      }
      setResolved(r);
      setSeedId(card.tcgdexId);
      // Every stage opens undecided, the one she picked the species by too (UIL-117 PR 5): the species picker
      // searches the catalog, so it says nothing about which card she has (UIL-098).
      setEntries(r.stages.map(defaultEntry));
      setThird({ material: null, card: null });
      setMixedOk(false);
    } finally {
      setResolving(false);
    }
  }

  function patch(stageIndex: number, next: Partial<StageEntry>) {
    setEntries((es) => es.map((e) => (e.info.stageIndex === stageIndex ? { ...e, ...next } : e)));
  }

  function reset() {
    setResolved(null);
    setSeedId(null);
    setEntries([]);
    setThird({ material: null, card: null });
    setMixedOk(false);
  }

  const status = previewStatus(entries);
  const chases = entries.filter((e) => e.choice === "chase").length;
  const empties = entries.filter((e) => e.choice === "empty").length;
  const fillers = entries.filter((e) => e.choice === "filler").length;
  // A complete line shorter than three pockets has a third pocket; she says what fills it (UIL-121 Q4).
  const needsThird =
    entries.length > 0 &&
    entries.length < LINE_ROW_POCKETS &&
    entries.every((e) => e.choice === "have");
  // The line reads as its lowest card's language (UIL-090); mixing them needs her OK (the Senior BA's ruling).
  const haveLocales = entries.flatMap((e) =>
    e.choice === "have" && e.haveCard ? [localeOfId(e.haveCard.tcgdexId)] : [],
  );
  const mixed = mixedLanguageNote(
    haveLocales,
    haveLocales[0] ?? localeOfId(seedId ?? resolved?.stages[0]?.suggestedTargetId ?? ""),
  );

  /** What still stops the save, in her words; null when the line can be saved. */
  const blocker = (() => {
    const undecided = entries.filter((e) => e.choice === null).length;
    if (undecided > 0) return `Decide every stage (${undecided} left), then save the line.`;
    const noCard = entries.find(
      (e) =>
        (e.choice === "have" && !e.haveCard) ||
        (e.choice === "filler" && e.fillerMaterial === "card" && !e.fillerCard),
    );
    if (noCard)
      return `Pick the card for the ${stageLabel(noCard.info.stage)} stage from your haul.`;
    if (needsThird && (third.material === null || (third.material === "card" && !third.card))) {
      return "Choose what fills the third pocket.";
    }
    if (mixed && !mixedOk) return "Confirm the line's language below.";
    return null;
  })();

  async function save() {
    if (!resolved || !seedId || blocker) return;
    setSaving(true);
    onResult(null);
    try {
      const stages: BackLineStageInput[] = entries.map((e) => {
        const base = { stageIndex: e.info.stageIndex, stage: e.info.stage, dexId: e.info.dexId };
        switch (e.choice) {
          case "have":
            return {
              ...base,
              choice: {
                kind: "have",
                tcgdexId: e.haveCard!.tcgdexId,
                dexVariantRaw: e.haveCard!.dexVariantRaw,
              },
            };
          case "chase":
            // Her wishlist add, for exactly this card (UIL-119: only a chase goes on her wishlist).
            return { ...base, choice: { kind: "chase", catalogCardId: e.info.suggestedTargetId! } };
          case "empty":
            return { ...base, choice: { kind: "empty" } };
          default:
            return {
              ...base,
              choice: {
                kind: "filler",
                filler:
                  e.fillerMaterial === "card" && e.fillerCard
                    ? {
                        material: "card",
                        tcgdexId: e.fillerCard.tcgdexId,
                        dexVariantRaw: e.fillerCard.dexVariantRaw,
                      }
                    : { material: "energy" },
              },
            };
        }
      });
      // The commit returns `{ ok }` for its own failures, so a throw is a call that never arrived (UIL-109).
      const res = await reach(
        () =>
          commitLineAction({
            binderId,
            bandKey: resolved.bandKey,
            seedTcgdexId: seedId,
            rootDexId: resolved.rootDexId,
            stages,
            ...(needsThird && third.material
              ? {
                  thirdPocket:
                    third.material === "card" && third.card
                      ? {
                          material: "card" as const,
                          tcgdexId: third.card.tcgdexId,
                          dexVariantRaw: third.card.dexVariantRaw,
                        }
                      : { material: third.material === "card" ? "energy" : third.material },
                }
              : {}),
            ...(mixed && mixedOk ? { mixedLanguageOk: true as const } : {}),
          }),
        LOST.action,
      );
      if (res.ok) {
        onResult({
          kind: "ok",
          text: `Saved the ${bandMeta(resolved.bandKey).display} ${resolved.speciesName} line (${res.counts.slots} slots, ${res.counts.wishlist} on your wishlist, ${empties} left empty, ${res.counts.blocks} fillers).`,
        });
        reset();
      } else onResult({ kind: "err", text: res.error });
    } finally {
      setSaving(false);
    }
  }

  const allPicks = (except: StageEntry | null) => [
    ...entries.filter((o) => o !== except).flatMap(stagePicks),
    ...(third.material === "card" && third.card ? [third.card] : []),
  ];

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
              : "Choose the line colour, then pick any card of the species. The stages come from the catalog; you decide each one: a card you have, a card to chase, left empty, or a filler."}
          </p>
        </>
      ) : (
        <div className="lineform">
          <div className="cap2">
            <span>
              {bandMeta(resolved.bandKey).display} · {resolved.speciesName}
            </span>
            <span>
              {status.toUpperCase()}
              {chases ? ` · ${chases} CHASED` : ""}
              {empties ? ` · ${empties} EMPTY` : ""}
              {fillers ? ` · ${fillers} FILLER${fillers > 1 ? "S" : ""}` : ""}
            </span>
          </div>

          {entries.map((e) => (
            <StageRow
              key={e.info.stageIndex}
              entry={e}
              otherPicks={allPicks(e)}
              onChoice={(d) => patch(e.info.stageIndex, { choice: d })}
              onHaveCard={(card) => patch(e.info.stageIndex, { haveCard: card })}
              onFillerMaterial={(m) => patch(e.info.stageIndex, { fillerMaterial: m })}
              onFillerCard={(card) => patch(e.info.stageIndex, { fillerCard: card })}
            />
          ))}

          {needsThird ? (
            <ThirdPocketRow
              value={third}
              otherPicks={allPicks(null).filter((c) => c !== third.card)}
              onChange={setThird}
            />
          ) : null}

          {mixed ? (
            <div className="lf" style={{ gridTemplateColumns: "70px minmax(0,1fr)" }}>
              <span className="st">LANGUAGE</span>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={mixedOk}
                  onChange={(ev) => setMixedOk(ev.target.checked)}
                />
                {mixed} Save it that way.
              </label>
            </div>
          ) : null}

          <div className="lf" style={{ gridTemplateColumns: "1fr auto auto", gap: 8 }}>
            <span className="st">
              {blocker ?? `Every stage decided. This line will read as ${status}.`}
            </span>
            <button type="button" className="btn" onClick={reset} disabled={saving}>
              Discard
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !!blocker}
            >
              {saving ? "Saving…" : "Save line"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The waiting copies a stage takes as entered: the card she has, or its filler card. */
function stagePicks(e: StageEntry): WaitingCard[] {
  if (e.choice === "have" && e.haveCard) return [e.haveCard];
  if (e.choice === "filler" && e.fillerMaterial === "card" && e.fillerCard) return [e.fillerCard];
  return [];
}

/** A picked card from her haul: its face, number and Dex variant. */
function PickedCard({ card }: { card: WaitingCard }) {
  const number = formatCollectorNumber(card.localId, card.setCardCountOfficial);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <CardFace name={card.name} tcgdexId={card.tcgdexId} imageUrl={card.imageUrl} size="s" />
      <span className="nm" style={{ fontSize: 12 }}>
        {card.name}
        {number ? ` · ${number}` : ""}
      </span>
    </div>
  );
}

function StageRow({
  entry,
  otherPicks,
  onChoice,
  onHaveCard,
  onFillerMaterial,
  onFillerCard,
}: {
  entry: StageEntry;
  /** What the line's OTHER stages have picked, so this stage's picker counts what is really left. */
  otherPicks: WaitingCard[];
  onChoice: (d: StageChoice) => void;
  onHaveCard: (card: WaitingCard) => void;
  onFillerMaterial: (m: "energy" | "card") => void;
  onFillerCard: (card: WaitingCard) => void;
}) {
  const { info, choice } = entry;
  const search = useWaitingSearch(otherPicks);
  const faceClass =
    choice === "chase"
      ? "f ph"
      : choice === "empty"
        ? "f em"
        : choice === "filler"
          ? "f blk"
          : choice === null
            ? "f und"
            : "f";
  const chaseOff = !info.suggestedTargetId;

  return (
    <div className="lf">
      <span className="st">{info.stage.toUpperCase()}</span>
      <span className={faceClass}>
        {choice === "have" && entry.haveCard ? (
          entry.haveCard.name
        ) : choice === "chase" ? (
          <>CHASE · {info.name}</>
        ) : choice === "empty" ? (
          <>EMPTY · {info.name}</>
        ) : choice === "filler" ? (
          <>
            FILLER · {info.name}
            {entry.fillerMaterial === "card" && entry.fillerCard ? (
              <>
                <br />
                {entry.fillerCard.name}
              </>
            ) : null}
          </>
        ) : (
          info.name
        )}
      </span>

      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {choice === null ? (
          <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
            {chaseOff
              ? "Not decided yet: I have it, Leave empty or Filler. Chase is off: no same-colour printing to chase."
              : "Not decided yet: I have it, Chase, Leave empty or Filler."}
          </span>
        ) : null}

        {choice === "have" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {entry.haveCard ? (
              <PickedCard card={entry.haveCard} />
            ) : (
              <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
                Pick the card you have from your haul:
              </span>
            )}
            <CardResultsGrid
              search={search}
              onPick={onHaveCard}
              placeholder="Which card?"
              emptyText={NOT_WAITING_EMPTY}
            />
            {entry.haveCard ? <WaitingTag card={entry.haveCard} /> : null}
          </div>
        )}

        {choice === "chase" && (
          <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
            Goes on your wishlist · {info.alternateTargetIds.length} alternate(s)
          </span>
        )}

        {choice === "empty" && (
          <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
            An empty slot · not on your wishlist
          </span>
        )}

        {choice === "filler" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="variants" role="group" aria-label="Filler">
              <button
                type="button"
                className={entry.fillerMaterial === "energy" ? "on" : ""}
                aria-pressed={entry.fillerMaterial === "energy"}
                onClick={() => onFillerMaterial("energy")}
              >
                Basic energy
              </button>
              <button
                type="button"
                className={entry.fillerMaterial === "card" ? "on" : ""}
                aria-pressed={entry.fillerMaterial === "card"}
                onClick={() => onFillerMaterial("card")}
              >
                A spare card
              </button>
            </div>
            {entry.fillerMaterial === "card" && (
              <CardResultsGrid
                search={search}
                onPick={onFillerCard}
                placeholder="Which spare card fills it?"
                emptyText={NOT_WAITING_EMPTY}
              />
            )}
          </div>
        )}
      </div>

      <span className="seg3" role="group" aria-label={`${info.stage} decision`}>
        <button
          type="button"
          className={choice === "have" ? "on" : ""}
          aria-pressed={choice === "have"}
          onClick={() => onChoice("have")}
        >
          I have it
        </button>
        <button
          type="button"
          className={choice === "chase" ? "on ph" : ""}
          aria-pressed={choice === "chase"}
          disabled={chaseOff}
          title={chaseOff ? "No same-colour printing to chase" : "Goes on your wishlist"}
          onClick={() => onChoice("chase")}
        >
          Chase
        </button>
        <button
          type="button"
          className={choice === "empty" ? "on em" : ""}
          aria-pressed={choice === "empty"}
          title="An empty slot, not on your wishlist"
          onClick={() => onChoice("empty")}
        >
          Leave empty
        </button>
        <button
          type="button"
          className={choice === "filler" ? "on blk" : ""}
          aria-pressed={choice === "filler"}
          onClick={() => onChoice("filler")}
        >
          Filler
        </button>
      </span>
    </div>
  );
}

/** A complete line shorter than three pockets: what fills its third pocket (UIL-121 Q4). */
function ThirdPocketRow({
  value,
  otherPicks,
  onChange,
}: {
  value: ThirdPocketEntry;
  otherPicks: WaitingCard[];
  onChange: (v: ThirdPocketEntry) => void;
}) {
  const search = useWaitingSearch(otherPicks);
  const pick = (material: ThirdPocketEntry["material"]) =>
    onChange({ material, card: material === "card" ? value.card : null });
  const onPickCard = (card: WaitingCard) => onChange({ material: "card", card });
  return (
    <div className="lf">
      <span className="st">3RD POCKET</span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
          This line is complete in fewer than three pockets. What fills the third?
        </span>
        {value.material === "card" ? (
          value.card ? (
            <PickedCard card={value.card} />
          ) : (
            <CardResultsGrid
              search={search}
              onPick={onPickCard}
              placeholder="Which spare card fills it?"
              emptyText={NOT_WAITING_EMPTY}
            />
          )
        ) : null}
      </div>
      <span className="seg3" role="group" aria-label="Third pocket">
        <button
          type="button"
          className={value.material === "energy" ? "on blk" : ""}
          aria-pressed={value.material === "energy"}
          onClick={() => pick("energy")}
        >
          Basic energy
        </button>
        <button
          type="button"
          className={value.material === "card" ? "on blk" : ""}
          aria-pressed={value.material === "card"}
          onClick={() => pick("card")}
        >
          A spare card
        </button>
        <button
          type="button"
          className={value.material === "empty" ? "on em" : ""}
          aria-pressed={value.material === "empty"}
          onClick={() => pick("empty")}
        >
          Leave empty
        </button>
      </span>
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
      // The commit returns `{ ok }` for its own failures, so a throw is a call that never arrived (UIL-109).
      const res = await reach(
        () =>
          commitSpecialtyAction({
            binderId,
            cards: rows.map((r) => ({
              tcgdexId: r.card.tcgdexId,
              dexVariantRaw: r.card.dexVariantRaw,
              collectionIds: r.collectionIds,
            })),
          }),
        LOST.action,
      );
      if (res.ok) {
        onResult({
          kind: "ok",
          text: `Saved ${res.counts.placed} card(s) to the specialty binder.`,
        });
        setRows([]);
      } else onResult({ kind: "err", text: res.error });
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
