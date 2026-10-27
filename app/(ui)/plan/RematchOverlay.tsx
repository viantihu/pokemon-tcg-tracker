"use client";

/**
 * "Wrong card?" — rematch a waiting card, or give it a stand-in (Karvi, 2026-10-26).
 *
 * The sync matched a Dex row to the wrong catalog card; she finds out here, with the physical card in her hand. She
 * picks the card it really is from the catalog, or makes a stand-in for a printing the catalog does not carry. Only this
 * one copy moves (lib/copy/rematch.ts); the screen then shows the new card and routes it again.
 *
 * The same two ways the Sync page offers for a row that would not match (MatchOverlay), with the same form
 * (StandInForm), so the fix reads the same wherever she makes it.
 */

import { useEffect, useState } from "react";
import { languageOfId } from "@/lib/catalog/locale";
import type { PlanItem } from "@/lib/plan";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { StandInForm, type StandInFormOutcome } from "../_components/StandInForm";
import { isUnreached, LOST, reach } from "../_components/reach";
import type { StandInFormInput } from "../sync/sync-types";
import {
  loadStandInCardTypes,
  lookupCatalog,
  rematchCopyAction,
  rematchToStandInAction,
} from "./actions";
import type { LookupCard } from "./plan-types";

export function RematchOverlay({
  item,
  copyId,
  onClose,
  onDone,
}: {
  /** The card as the plan shows it now: the wrong match. */
  item: PlanItem;
  copyId: string;
  onClose: () => void;
  /** The copy now is `card`; the screen shows it and routes it again. */
  onDone: (card: LookupCard) => void;
}) {
  const [cardTypes, setCardTypes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void reach(() => loadStandInCardTypes(), LOST.read).then((r) => {
      if (!live) return;
      // The stand-in form needs the list for a Pokémon's type; the catalog pick works without it.
      setCardTypes(isUnreached(r) ? [] : r);
    });
    return () => {
      live = false;
    };
  }, []);

  async function pick(tcgdexId: string) {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    const r = await reach(() => rematchCopyAction(copyId, tcgdexId), LOST.action);
    setBusy(false);
    if (r.ok) onDone(r.card);
    else setFailed(r.error);
  }

  async function standIn(input: StandInFormInput): Promise<StandInFormOutcome> {
    const r = await reach(() => rematchToStandInAction(copyId, input), LOST.action);
    if (r.ok) {
      onDone(r.card);
      return { ok: true };
    }
    return r;
  }

  const was = [item.name, item.localId ? `#${item.localId}` : null, item.variant]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="veil on" onClick={onClose}>
      <div className="dsheet panel" onClick={(e) => e.stopPropagation()}>
        <div className="cap">
          <span className="t">WRONG CARD?</span>
          <span className="n">{item.name}</span>
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
          <div style={{ fontSize: 11, color: "var(--ink-2)" }}>Matched to: {was}</div>
          <p style={{ fontSize: 11, color: "var(--ink-2)", margin: 0 }}>
            Pick the card this really is. Only this copy changes; your other copies stay as they
            are.
          </p>
          {failed ? (
            <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
              <span>!</span>
              <b>{failed}</b>
            </div>
          ) : null}
          <CardResultsGrid
            search={lookupCatalog}
            onPick={(card) => void pick(card.tcgdexId)}
            placeholder="Find the real card…"
          />
          {cardTypes ? (
            <StandInForm
              entry={{
                dexName: item.name,
                dexSetName: "",
                dexNumber: "",
                locale: "",
                language: languageOfId(item.tcgdexId),
              }}
              cardTypes={cardTypes}
              onStandIn={standIn}
              onPicked={(id) => void pick(id)}
              matchLabel="rematch"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
