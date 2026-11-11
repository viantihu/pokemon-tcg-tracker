"use client";

/**
 * UIL-060 Half 2 on the Sync screen: the stand-ins swapped for their real cards, and the ones the swap was not sure
 * of (Karvi 2026-10-22: swap on its own only when certain; else ask her).
 *
 * Karvi (2026-11-11): a suggestion can be wrong, so swapping is never the only way out. Each stand-in shows what the
 * decision touches (how many copies, and where), then four ways to settle it: this suggestion is the card; find the
 * right card in the catalog; fix the stand-in she typed; or leave it as a stand-in. A swap is confirmed first, naming
 * the copies it moves.
 */

import { useState } from "react";
import type { StandInCardView, StandInHeld, SwappedStandIn, UnsureStandIn } from "@/lib/sync";
import { CardFace } from "../_components/CardFace";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import type { LookupCard } from "../plan/plan-types";

const describe = (c: Pick<StandInCardView, "setName" | "localId">) =>
  [c.setName, c.localId ? `#${c.localId}` : null].filter(Boolean).join(" · ");

const copies = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;

/** "1 copy · KB-001 · Front · Red", or that the stand-in is not in her collection at all. */
function HeldLine({ held }: { held: StandInHeld }) {
  if (held.count === 0) {
    return <span style={{ color: "var(--ink-2)" }}>Not in your collection (0 copies).</span>;
  }
  return (
    <span>
      You have <b>{copies(held.count)}</b>:{" "}
      {held.where.map((w, i) => (
        <span key={w.label}>
          {i > 0 ? "; " : ""}
          {w.label}
          {held.where.length > 1 ? ` (${w.count})` : ""}
        </span>
      ))}
    </span>
  );
}

export interface StandInActions {
  onSwap: (standInId: string, realId: string) => void;
  onFix: (standInId: string, fix: { name: string; setName: string; localId: string }) => void;
  onKeep: (standInId: string, candidateIds: string[]) => void;
  onReviewAgain: (standInId: string) => void;
  search: (query: string) => Promise<LookupCard[]>;
}

export function StandInSwapPanel({
  swapped,
  unsure,
  kept,
  busy,
  onDismissSwapped,
  ...actions
}: {
  swapped: SwappedStandIn[];
  unsure: UnsureStandIn[];
  kept: (StandInCardView & { held: StandInHeld })[];
  busy: boolean;
  onDismissSwapped: () => void;
} & StandInActions) {
  if (swapped.length === 0 && unsure.length === 0 && kept.length === 0) return null;
  return (
    <div className="panel" style={{ padding: 16, fontSize: 12, display: "grid", gap: 16 }}>
      {swapped.length > 0 ? (
        <section role="status" style={{ display: "grid", gap: 8 }}>
          <b>
            {swapped.length === 1
              ? "A stand-in is now in the catalog and was swapped for the real card."
              : `${swapped.length} stand-ins are now in the catalog and were swapped for the real cards.`}
          </b>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
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
        <section style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <b>
              {unsure.length === 1
                ? "This stand-in may now be in the catalog."
                : `${unsure.length} stand-ins may now be in the catalog.`}
            </b>
            <span style={{ color: "var(--ink-2)" }}>
              Pick the real card only if it is right. Otherwise find it yourself, fix the stand-in,
              or leave it as it is.
            </span>
          </div>
          {unsure.map((u) => (
            <StandInReview key={u.standIn.id} item={u} busy={busy} {...actions} />
          ))}
        </section>
      ) : null}

      {kept.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer" }}>
            <b>Kept as stand-ins</b> ({kept.length}) — not asked about again until a new match
            appears.
          </summary>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 8 }}>
            {kept.map((k) => (
              <li key={k.id}>
                <b>{k.name}</b> · {describe(k)} — <HeldLine held={k.held} />{" "}
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => actions.onReviewAgain(k.id)}
                >
                  Ask me again
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

type Mode =
  | { kind: "idle" }
  | { kind: "confirm"; card: StandInCardView }
  | { kind: "find" }
  | { kind: "fix" };

function StandInReview({
  item,
  busy,
  onSwap,
  onFix,
  onKeep,
  search,
}: { item: UnsureStandIn; busy: boolean } & StandInActions) {
  const { standIn, held, candidates, blocked } = item;
  const [mode, setMode] = useState<Mode>({ kind: "idle" });

  return (
    <article
      data-testid="stand-in-review"
      style={{
        border: "3px solid var(--ink)",
        background: "var(--hi)",
        padding: 16,
        display: "grid",
        gap: 14,
      }}
    >
      <header style={{ display: "grid", gap: 6 }}>
        <span>
          Your stand-in: <b>{standIn.name}</b> · {describe(standIn)}
        </span>
        <HeldLine held={held} />
        {blocked ? <span style={{ color: "var(--ink-2)" }}>{blocked}</span> : null}
      </header>

      {candidates.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ color: "var(--ink-2)" }}>
            {candidates.length === 1 ? "Suggested match:" : "Suggested matches:"}
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
              gap: 20,
            }}
          >
            {candidates.map((c) => (
              <div key={c.id} style={{ display: "grid", gap: 6, alignContent: "start" }}>
                <CardFace name={c.name} imageUrl={c.imageUrl} tcgdexId={c.id} zoomable />
                <span style={{ lineHeight: 1.4 }}>
                  <b>{c.name}</b>
                  <br />
                  {describe(c)}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || Boolean(blocked)}
                  onClick={() => setMode({ kind: "confirm", card: c })}
                >
                  This is the card
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {mode.kind === "confirm" ? (
        <div
          role="alertdialog"
          style={{ background: "var(--note)", padding: 12, display: "grid", gap: 10 }}
        >
          <span>
            Swap <b>{standIn.name}</b> for <b>{mode.card.name}</b> · {describe(mode.card)}?{" "}
            {held.count > 0
              ? `Your ${copies(held.count)} will be filed as that card.`
              : "Nothing in your collection uses this stand-in; it is just removed."}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                onSwap(standIn.id, mode.card.id);
                setMode({ kind: "idle" });
              }}
            >
              Swap
            </button>
            <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode.kind === "find" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <CardResultsGrid
            search={search}
            onPick={(card) =>
              setMode({
                kind: "confirm",
                card: {
                  id: card.tcgdexId,
                  name: card.name,
                  setName: card.setName ?? null,
                  localId: card.localId ?? null,
                  imageUrl: card.imageUrl ?? null,
                },
              })
            }
            placeholder="Find the real card…"
          />
          <div>
            <button type="button" className="btn sm" onClick={() => setMode({ kind: "idle" })}>
              Close search
            </button>
          </div>
        </div>
      ) : null}

      {mode.kind === "fix" ? (
        <FixStandInForm
          standIn={standIn}
          busy={busy}
          onCancel={() => setMode({ kind: "idle" })}
          onSave={(fix) => {
            onFix(standIn.id, fix);
            setMode({ kind: "idle" });
          }}
        />
      ) : null}

      {mode.kind === "idle" ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            borderTop: "2px dashed var(--lo)",
            paddingTop: 14,
          }}
        >
          {candidates.length > 0 ? (
            <span style={{ color: "var(--ink-2)", marginRight: 4 }}>None of these?</span>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setMode({ kind: "find" })}
          >
            Find the right card
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setMode({ kind: "fix" })}
          >
            Fix the stand-in
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              onKeep(
                standIn.id,
                candidates.map((c) => c.id),
              )
            }
          >
            Leave it as a stand-in
          </button>
        </div>
      ) : null}
    </article>
  );
}

function FixStandInForm({
  standIn,
  busy,
  onSave,
  onCancel,
}: {
  standIn: StandInCardView;
  busy: boolean;
  onSave: (fix: { name: string; setName: string; localId: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(standIn.name);
  const [setNameValue, setSetName] = useState(standIn.setName ?? "");
  const [localId, setLocalId] = useState(standIn.localId ?? "");
  const label = { display: "grid", gap: 4 } as const;
  return (
    <form
      style={{ display: "grid", gap: 12, maxWidth: 480 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, setName: setNameValue, localId });
      }}
    >
      <label style={label}>
        Name
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={label}>
        Set
        <input
          className="field"
          value={setNameValue}
          onChange={(e) => setSetName(e.target.value)}
        />
      </label>
      <label style={label}>
        Number, as printed (e.g. 123/128)
        <input className="field" value={localId} onChange={(e) => setLocalId(e.target.value)} />
      </label>
      <span style={{ color: "var(--ink-2)" }}>
        Saving checks the catalog again. If the fix makes the match certain, it swaps on its own.
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
