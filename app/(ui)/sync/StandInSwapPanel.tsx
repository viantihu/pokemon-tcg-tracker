"use client";

/**
 * UIL-060 Half 2 on the Sync screen: the stand-ins swapped for their real cards, and the ones the swap was not sure
 * of, each with the real cards it might be (Karvi 2026-10-22: swap on its own only when certain; else ask her).
 */

import type { StandInCardView, SwappedStandIn, UnsureStandIn } from "@/lib/sync";
import { CardFace } from "../_components/CardFace";

const describe = (c: StandInCardView) =>
  [c.setName, c.localId ? `#${c.localId}` : null].filter(Boolean).join(" · ");

export function StandInSwapPanel({
  swapped,
  unsure,
  busy,
  onSwap,
  onDismissSwapped,
}: {
  swapped: SwappedStandIn[];
  unsure: UnsureStandIn[];
  busy: boolean;
  onSwap: (standInId: string, realId: string) => void;
  onDismissSwapped: () => void;
}) {
  if (swapped.length === 0 && unsure.length === 0) return null;
  return (
    <div className="panel" style={{ padding: 12, fontSize: 12, display: "grid", gap: 12 }}>
      {swapped.length > 0 ? (
        <section role="status" style={{ display: "grid", gap: 6 }}>
          <b>
            {swapped.length === 1
              ? "A stand-in is now in the catalog and was swapped for the real card."
              : `${swapped.length} stand-ins are now in the catalog and were swapped for the real cards.`}
          </b>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {swapped.map((s) => (
              <li key={s.standIn.id}>
                {s.real.name} · {describe(s.real)}
              </li>
            ))}
          </ul>
          <div>
            <button type="button" className="btn" onClick={onDismissSwapped}>
              OK
            </button>
          </div>
        </section>
      ) : null}

      {unsure.length > 0 ? (
        <section style={{ display: "grid", gap: 10 }}>
          <b>
            {unsure.length === 1
              ? "This stand-in may now be in the catalog. Pick the real card to swap it for."
              : "These stand-ins may now be in the catalog. Pick the real card to swap each one for."}
          </b>
          {unsure.map((u) => (
            <div key={u.standIn.id} style={{ display: "grid", gap: 6 }}>
              <span>
                Your stand-in: <b>{u.standIn.name}</b> · {describe(u.standIn)}
              </span>
              {u.blocked ? <span style={{ color: "var(--ink-2)" }}>{u.blocked}</span> : null}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {u.candidates.map((c) => (
                  <div key={c.id} style={{ display: "grid", gap: 4, justifyItems: "start" }}>
                    <CardFace name={c.name} imageUrl={c.imageUrl} tcgdexId={c.id} zoomable />
                    <span>
                      {c.name} · {describe(c)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || Boolean(u.blocked)}
                      onClick={() => onSwap(u.standIn.id, c.id)}
                    >
                      Swap for this card
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
