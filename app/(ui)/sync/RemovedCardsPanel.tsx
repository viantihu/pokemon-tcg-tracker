"use client";

/**
 * The count check's "you removed", card by card, each with "Add it back". A removal is remembered so the next import
 * does not hand the card back; a card removed by mistake (removed as "wrong", then a stand-in made for it) had no
 * way back from here, and every import kept subtracting it.
 */

import { CardFace } from "../_components/CardFace";
import type { RemovedCardView } from "./sync-types";

const describe = (c: RemovedCardView) =>
  [c.setName, c.localId ? `#${c.localId}` : null, c.dexVariantRaw].filter(Boolean).join(" · ");

export function RemovedCardsPanel({
  removed,
  busy,
  onAddBack,
}: {
  removed: RemovedCardView[];
  busy: boolean;
  onAddBack: (card: RemovedCardView) => void;
}) {
  if (removed.length === 0) return null;
  return (
    <details className="panel" style={{ padding: 12, fontSize: 12 }} data-testid="removed-cards">
      <summary style={{ cursor: "pointer" }}>
        <b>Cards you removed</b> ({removed.reduce((n, c) => n + c.count, 0)})
      </summary>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
        {removed.map((c) => (
          <div
            key={`${c.catalogCardId}|${c.dexVariantRaw}`}
            style={{ display: "grid", gap: 4, justifyItems: "start" }}
          >
            <CardFace name={c.name} imageUrl={c.imageUrl} tcgdexId={c.catalogCardId} zoomable />
            <span>
              <b>{c.name}</b> · {describe(c)}
              {c.count > 1 ? ` · ${c.count} removed` : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => onAddBack(c)}
            >
              Add it back
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
