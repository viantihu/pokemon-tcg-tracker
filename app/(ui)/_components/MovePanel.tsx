"use client";

/**
 * The reusable placement-override panel (dev-spec §5 M7; design/prototype.html `ovrBlock`/move
 * overlay). Any owned/shelved card can be moved to a binder + half + band, into a collection in a
 * specialty binder, or to the Bulk Box ("don't shelf"). No rule applies here — it is her call
 * (system-design §12 coarse location).
 *
 * Self-contained: it owns the draft destination (seeded from the card's current home) and calls
 * `onConfirm` with the chosen `MoveDestination`. Reused by the line strip, the plan spotlight, and
 * (later) lookup — anywhere a card shows. Presentational + local state only; the write is a server
 * action the host passes down.
 *
 * `allowLineJoin` (UIL-056, opt-in, default off; UIL-064 reshaped the flow): the back half IS the
 * lines area, so a back-half destination resolves to a line — an existing one's open slot, or a new
 * one. Off by default so the plan spotlight and Collections' existing usage are untouched; only the
 * Line screen turns it on. When it is on, "JOIN A LINE" is the FIRST thing offered — flat across
 * every band (`joinCandidates`, computed server-side from lines already loaded), each candidate
 * carrying its own binder + band, so picking one derives the whole destination instead of asking her
 * to supply binder/half/band before a line ever appears (her UIL-064 complaint: "too many picks; it
 * should ask for the line"). Binder/half/band stay reachable behind "place it manually" for the
 * front-half / bulk / collection cases, or a genuine forced override.
 */

import { useState } from "react";
import type {
  ExistingLineBlock,
  LineJoinCandidate,
  LineJoinChoice,
  MoveDestination,
  MoveOptions,
} from "@/lib/line/types";
import { defaultMoveHalf, isMoveDestinationComplete } from "@/lib/line/move";
import { bandMeta } from "./plan-meta";

const BULK = "__bulk__";

export function MovePanel({
  options,
  initial,
  confirmLabel = "Place it here ▶",
  allowLineJoin = false,
  joinCandidates,
  existingLineByBand,
  naturalBandKey,
  onConfirm,
}: {
  options: MoveOptions;
  initial?: MoveDestination;
  confirmLabel?: string;
  allowLineJoin?: boolean;
  /** Flat across every band (UIL-064) — present (even empty) turns the line-first flow on. */
  joinCandidates?: LineJoinCandidate[];
  /** A line already exists for this band but has no open slot for this card (UIL-056 note 3) —
   *  explains an otherwise-empty candidate list rather than leaving it looking broken. */
  existingLineByBand?: Record<string, ExistingLineBlock>;
  /** This card's own type-derived band — the default for "start a new line"'s one remaining pick
   *  (UIL-064): the app's own answer, not ten empty chips. */
  naturalBandKey?: string;
  onConfirm: (dest: MoveDestination) => void;
}) {
  const firstGeneral = options.binders.find((b) => b.type === "general");
  const [binderId, setBinderId] = useState<string>(() => {
    if (initial?.kind === "bulk") return BULK;
    if (initial && "binderId" in initial) return initial.binderId;
    return firstGeneral?.id ?? options.binders[0]?.id ?? BULK;
  });
  const [half, setHalf] = useState<"front" | "back">(() => defaultMoveHalf(initial, allowLineJoin));
  const [band, setBand] = useState<string | null>(() => {
    if (initial?.kind === "shelf") return initial.band;
    return naturalBandKey ?? null;
  });
  const [collectionId, setCollectionId] = useState<string | null>(
    initial?.kind === "collection" ? initial.collectionId : null,
  );
  const [lineJoin, setLineJoin] = useState<LineJoinChoice | undefined>(
    initial?.kind === "shelf" ? initial.lineJoin : undefined,
  );

  const isBulk = binderId === BULK;
  const binder = options.binders.find((b) => b.id === binderId);
  const isSpecialty = binder?.type === "specialty";
  const collections = binder ? (options.collectionsByBinder[binder.id] ?? []) : [];
  const blockingLine = allowLineJoin && band ? existingLineByBand?.[band] : undefined;

  const destination: MoveDestination = isBulk
    ? { kind: "bulk" }
    : isSpecialty
      ? { kind: "collection", binderId: binder!.id, collectionId: collectionId ?? "" }
      : {
          kind: "shelf",
          binderId: binder?.id ?? "",
          half,
          band: band ?? "",
          ...(half === "back" && allowLineJoin ? { lineJoin } : {}),
        };

  const canConfirm = isMoveDestinationComplete(destination);

  function summary(): string {
    if (isBulk) return "BULK BOX · NOT SHELVED";
    if (isSpecialty) {
      const c = collections.find((x) => x.id === collectionId);
      return `${binder?.name ?? "BINDER"} · ${c ? c.name.toUpperCase() : "PICK A COLLECTION"}`;
    }
    const bandLabel = band ? bandMeta(band).display.toUpperCase() : "PICK A BAND";
    const joinLabel =
      half === "back" && allowLineJoin
        ? lineJoin?.mode === "new"
          ? " · NEW LINE"
          : lineJoin?.mode === "existing"
            ? ` · ${(joinCandidates ?? []).find((c) => c.slotId === lineJoin.slotId)?.speciesLabel ?? "LINE"}`
            : " · PICK A LINE"
        : "";
    return `${binder?.name ?? "BINDER"} · ${half.toUpperCase()} HALF · ${bandLabel}${joinLabel}`;
  }

  const manualBody = (
    <>
      <div className="orow">
        <div className="ol">BINDER</div>
        <div className="ochips">
          {options.binders.map((b) => (
            <button
              key={b.id}
              type="button"
              className={
                "ochip" + (b.type === "specialty" ? " spec" : "") + (binderId === b.id ? " on" : "")
              }
              aria-pressed={binderId === b.id}
              onClick={() => {
                setBinderId(b.id);
                setLineJoin(undefined); // a manually forced binder may no longer match the line's own
                if (b.type !== "specialty") setCollectionId(null);
              }}
            >
              {b.name}
            </button>
          ))}
          <button
            type="button"
            className={"ochip bulk" + (isBulk ? " on" : "")}
            aria-pressed={isBulk}
            onClick={() => {
              setBinderId(BULK);
              setLineJoin(undefined);
            }}
          >
            ▤ Bulk box · don&apos;t shelf
          </button>
        </div>
      </div>

      {isBulk ? (
        <div className="orow">
          <div className="ol" />
          <div className="ochips">
            <span className="oskip">
              Bulk box has no internal structure: no binder, no half, no band. It stays in the pile
              until you place it.
            </span>
          </div>
        </div>
      ) : isSpecialty ? (
        <div className="orow">
          <div className="ol">COLLECTION IN {binder?.name?.toUpperCase()}</div>
          <div className="ochips">
            {collections.length === 0 ? (
              <span className="oskip">
                No collection lives in this binder yet. Create one on the Collections screen.
              </span>
            ) : (
              collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"ochip" + (collectionId === c.id ? " on" : "")}
                  aria-pressed={collectionId === c.id}
                  onClick={() => setCollectionId(c.id)}
                >
                  {c.name}
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="orow">
            <div className="ol">HALF</div>
            <div className="ochips">
              {(["front", "back"] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  className={"ochip" + (half === h ? " on" : "")}
                  aria-pressed={half === h}
                  onClick={() => {
                    setHalf(h);
                    setLineJoin(undefined);
                  }}
                >
                  {h.toUpperCase()} HALF
                </button>
              ))}
            </div>
          </div>
          <div className="orow">
            <div className="ol">COLOR BAND · RAINBOW ORDER</div>
            <div className="ochips">
              {options.bands.map((b) => {
                const m = bandMeta(b.key);
                return (
                  <button
                    key={b.key}
                    type="button"
                    className={"ochip" + (band === b.key ? " on" : "")}
                    aria-pressed={band === b.key}
                    onClick={() => {
                      setBand(b.key);
                      setLineJoin(undefined);
                    }}
                  >
                    <span
                      className={"sw" + (m.dither ? " dither" : "")}
                      style={{ background: m.color }}
                    />
                    {b.display}
                    {b.key === "pink" ? <span className="rt">RSV</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          {half === "back" && !allowLineJoin ? (
            <div className="orow">
              <div className="ol" />
              <div className="ochips">
                <span className="oskip">
                  Back-half moves choose a line. Do this from the Lines page.
                </span>
              </div>
            </div>
          ) : null}
          {half === "back" && allowLineJoin ? (
            <div className="orow">
              <div className="ol" />
              <div className="ochips">
                <span className="oskip">
                  {lineJoin
                    ? "Line picked above — change it there, or pick Bulk / a Collection / the front half here."
                    : "Back-half moves need a line — pick one above, or choose Bulk / a Collection / the front half here."}
                </span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <div className="ovr">
      <div className="ohead">
        <span>MANUAL PLACEMENT · YOUR CALL</span>
        <span className="yc">NO RULE</span>
      </div>
      <div className="obody">
        {allowLineJoin ? (
          <>
            <div className="orow">
              <div className="ol">JOIN A LINE</div>
              <div className="ochips">
                {(joinCandidates ?? []).map((c) => {
                  const on =
                    lineJoin?.mode === "existing" &&
                    lineJoin.lineId === c.lineId &&
                    lineJoin.slotId === c.slotId;
                  const m = bandMeta(c.bandKey);
                  return (
                    <button
                      key={c.slotId}
                      type="button"
                      className={"ochip" + (on ? " on" : "")}
                      aria-pressed={on}
                      onClick={() => {
                        setLineJoin({ mode: "existing", lineId: c.lineId, slotId: c.slotId });
                        setBinderId(
                          c.binderId ?? firstGeneral?.id ?? options.binders[0]?.id ?? BULK,
                        );
                        setHalf("back");
                        setBand(c.bandKey);
                      }}
                    >
                      <span
                        className={"sw" + (m.dither ? " dither" : "")}
                        style={{ background: m.color }}
                      />
                      {c.speciesLabel} · {m.display} · {c.filledCount}/{c.totalCount} FILLED ·{" "}
                      {c.stage.toUpperCase()} SLOT
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={"ochip" + (lineJoin?.mode === "new" ? " on" : "")}
                  aria-pressed={lineJoin?.mode === "new"}
                  onClick={() => {
                    setLineJoin({ mode: "new" });
                    setHalf("back");
                    setBand(naturalBandKey ?? options.bands[0]?.key ?? null);
                  }}
                >
                  + Start a new line
                </button>
              </div>
            </div>

            {lineJoin?.mode === "new" ? (
              <div className="orow">
                <div className="ol">COLOR BAND · RAINBOW ORDER</div>
                <div className="ochips">
                  {options.bands.map((b) => {
                    const m = bandMeta(b.key);
                    return (
                      <button
                        key={b.key}
                        type="button"
                        className={"ochip" + (band === b.key ? " on" : "")}
                        aria-pressed={band === b.key}
                        onClick={() => setBand(b.key)}
                      >
                        <span
                          className={"sw" + (m.dither ? " dither" : "")}
                          style={{ background: m.color }}
                        />
                        {b.display}
                        {b.key === "pink" ? <span className="rt">RSV</span> : null}
                      </button>
                    );
                  })}
                </div>
                {blockingLine ? (
                  <div className="oskip" style={{ marginTop: 6 }}>
                    {blockingLine.speciesLabel} already exists here ({blockingLine.filledCount}/
                    {blockingLine.totalCount} filled), but this card&apos;s own stage is already
                    filled by another copy — lines are tracked once, so this one starts its own line
                    instead.
                  </div>
                ) : null}
              </div>
            ) : null}

            <details className="orow" style={{ display: "block" }}>
              <summary className="ol" style={{ cursor: "pointer" }}>
                Not this — place it manually
              </summary>
              <div style={{ marginTop: 8 }}>{manualBody}</div>
            </details>
          </>
        ) : (
          manualBody
        )}

        <div className="osum">
          PLACING · <b>{summary()}</b>
        </div>
        <button
          type="button"
          className="oconfirm"
          disabled={!canConfirm}
          onClick={() => canConfirm && onConfirm(destination)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
