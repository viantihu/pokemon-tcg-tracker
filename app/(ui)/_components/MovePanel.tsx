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
 */

import { useState } from "react";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { isMoveDestinationComplete } from "@/lib/line/move";
import { bandMeta } from "./plan-meta";

const BULK = "__bulk__";

export function MovePanel({
  options,
  initial,
  confirmLabel = "Place it here ▶",
  onConfirm,
}: {
  options: MoveOptions;
  initial?: MoveDestination;
  confirmLabel?: string;
  onConfirm: (dest: MoveDestination) => void;
}) {
  const firstGeneral = options.binders.find((b) => b.type === "general");
  const [binderId, setBinderId] = useState<string>(() => {
    if (initial?.kind === "bulk") return BULK;
    if (initial && "binderId" in initial) return initial.binderId;
    return firstGeneral?.id ?? options.binders[0]?.id ?? BULK;
  });
  const [half, setHalf] = useState<"front" | "back">(
    initial?.kind === "shelf" ? initial.half : "back",
  );
  const [band, setBand] = useState<string | null>(initial?.kind === "shelf" ? initial.band : null);
  const [collectionId, setCollectionId] = useState<string | null>(
    initial?.kind === "collection" ? initial.collectionId : null,
  );

  const isBulk = binderId === BULK;
  const binder = options.binders.find((b) => b.id === binderId);
  const isSpecialty = binder?.type === "specialty";
  const collections = binder ? (options.collectionsByBinder[binder.id] ?? []) : [];

  const destination: MoveDestination = isBulk
    ? { kind: "bulk" }
    : isSpecialty
      ? { kind: "collection", binderId: binder!.id, collectionId: collectionId ?? "" }
      : { kind: "shelf", binderId: binder?.id ?? "", half, band: band ?? "" };

  const canConfirm = isMoveDestinationComplete(destination);

  function summary(): string {
    if (isBulk) return "BULK BOX · NOT SHELVED";
    if (isSpecialty) {
      const c = collections.find((x) => x.id === collectionId);
      return `${binder?.name ?? "BINDER"} · ${c ? c.name.toUpperCase() : "PICK A COLLECTION"}`;
    }
    const bandLabel = band ? bandMeta(band).display.toUpperCase() : "PICK A BAND";
    return `${binder?.name ?? "BINDER"} · ${half.toUpperCase()} HALF · ${bandLabel}`;
  }

  return (
    <div className="ovr">
      <div className="ohead">
        <span>MANUAL PLACEMENT · YOUR CALL</span>
        <span className="yc">NO RULE</span>
      </div>
      <div className="obody">
        <div className="orow">
          <div className="ol">BINDER</div>
          <div className="ochips">
            {options.binders.map((b) => (
              <button
                key={b.id}
                type="button"
                className={
                  "ochip" +
                  (b.type === "specialty" ? " spec" : "") +
                  (binderId === b.id ? " on" : "")
                }
                aria-pressed={binderId === b.id}
                onClick={() => {
                  setBinderId(b.id);
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
              onClick={() => setBinderId(BULK)}
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
                Bulk box has no internal structure: no binder, no half, no band. It stays in the
                pile until you place it.
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
                    onClick={() => setHalf(h)}
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
            </div>
          </>
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
