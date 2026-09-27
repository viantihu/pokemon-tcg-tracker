"use client";

/**
 * The line popup's two-option sections (UIL-117 PR 3, mockup v3 section 5): the REPLACE choice ("Which Charmeleon
 * stays in the line?", opening on Keep) with its "where does it go" picker, and the UIL-069 colour choice for an Add
 * (neither option picked until she picks). Split out of LinePopup.tsx only to keep that file readable.
 *
 * The picker offers the same places as the Move sheet anywhere else, because it IS the Move sheet: the bulk box in
 * one tap (suggested), and a front half, another line or a collection through `MoveOverlay`, whose back half opens
 * the line popup for the card coming out. Nothing here writes: it reports her pick to the popup.
 */

import { useState } from "react";
import type { LineChoice, LinePopupModel, LineProposal, LinePopupReplace } from "@/lib/line/popup";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { BandChip } from "./BandChip";
import { MoveOverlay } from "./MoveOverlay";
import { useEscapeLayer } from "./escape-layer";

type OutgoingLine = Extract<LineChoice, { mode: "start" } | { mode: "join" }>;

/** ", new line" / ", into its slot": the card coming out's own line, as its popup said it. */
export function lineNote(line: { mode: "start" | "join" } | undefined): string {
  return line ? (line.mode === "start" ? ", new line" : ", into its slot") : "";
}

/** Her words for a destination: "the bulk box", "KB-002 · Front · Red", "Specialty A · Starters". */
export function destinationLabel(dest: MoveDestination, options?: MoveOptions): string {
  const binder = (id: string) => options?.binders.find((b) => b.id === id)?.name ?? "a binder";
  const band = (key: string) => options?.bands.find((b) => b.key === key)?.display ?? key;
  switch (dest.kind) {
    case "bulk":
      return "the bulk box";
    case "shelf":
      return `${binder(dest.binderId)} · ${dest.half === "back" ? "Back" : "Front"} · ${band(dest.band)}`;
    case "collection": {
      const name = options?.collectionsByBinder[dest.binderId]?.find(
        (c) => c.id === dest.collectionId,
      )?.name;
      return `${binder(dest.binderId)} · ${name ?? "a collection"}`;
    }
    case "block":
      return `${binder(dest.binderId)} · a binder block`;
  }
}

const numberOf = (c: LinePopupReplace["current"]["card"]) =>
  formatCollectorNumber(c.localId, c.setCardCountOfficial ?? null) ?? c.name;

/** "Which Charmeleon stays in the line?" Keep (the default) or Swap, and where the card that moves goes. */
export function ReplaceChoice({
  replace,
  value,
  onChange,
  stageLabel,
  moveOptions,
  keepLabel,
  keepDestination,
  outgoingLineModel,
  busy,
}: {
  replace: LinePopupReplace;
  value: Extract<LineChoice, { mode: "replace" }>;
  onChange(choice: LineChoice): void;
  stageLabel: string;
  moveOptions?: MoveOptions;
  keepLabel?: string;
  keepDestination?: MoveDestination;
  outgoingLineModel?(proposal: LineProposal): Promise<LinePopupModel>;
  busy: boolean;
}) {
  const { current, incoming } = replace;
  const swapping = !value.keep;
  const base = { mode: "replace" as const, lineId: value.lineId, slotId: value.slotId };
  const keep = (): LineChoice =>
    keepDestination
      ? {
          ...base,
          keep: true,
          incoming: (value.keep ? value.incoming : undefined) ?? keepDestination,
        }
      : { ...base, keep: true };
  const swap = (): LineChoice => ({
    ...base,
    keep: false,
    outgoing: value.keep ? replace.suggestedOutgoing : value.outgoing,
    ...(!value.keep && value.outgoingLine ? { outgoingLine: value.outgoingLine } : {}),
    ...(!value.keep && value.foreignLocale ? { foreignLocale: true as const } : {}),
  });
  const keepPlace =
    value.keep && value.incoming ? destinationLabel(value.incoming, moveOptions) : null;

  return (
    <>
      <div className="lp-lbl u">Which {current.card.name} stays in the line?</div>
      <div className="lp-choice" role="radiogroup" aria-label="Which card stays in the line">
        <button
          type="button"
          role="radio"
          aria-checked={!swapping}
          className={"lp-opt" + (!swapping ? " on" : "")}
          disabled={busy}
          onClick={() => onChange(keep())}
        >
          <b className="u">Keep {numberOf(current.card)} (the one there now)</b>
          <span>
            {keepPlace
              ? `The new ${incoming.card.name} goes to ${keepPlace}. Nothing in the line moves.`
              : (keepLabel ?? "Nothing in the line moves.")}
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={swapping}
          className={"lp-opt" + (swapping ? " on" : "")}
          disabled={busy}
          onClick={() => onChange(swap())}
        >
          <b className="u">Swap in {numberOf(incoming.card)}</b>
          <span>
            It takes the {stageLabel} slot. {numberOf(current.card)} comes out and goes where you
            pick below.
          </span>
        </button>
      </div>

      {swapping && !value.keep ? (
        <>
          <div className="lp-lbl u">
            Where does {numberOf(current.card)} go?{" "}
            <span className="lp-hint">(anywhere, your choice. Bulk box is suggested)</span>
          </div>
          <DestinationPicker
            label={`Where ${numberOf(current.card)} goes`}
            card={current}
            value={value.outgoing}
            suggested={replace.suggestedOutgoing}
            options={moveOptions}
            lineModel={outgoingLineModel}
            note={lineNote(!value.keep ? value.outgoingLine : undefined)}
            busy={busy}
            onPick={(dest, line) =>
              onChange({
                ...base,
                keep: false,
                outgoing: dest,
                ...(line ? { outgoingLine: line } : {}),
                ...(value.foreignLocale ? { foreignLocale: true as const } : {}),
              })
            }
          />
        </>
      ) : null}

      {value.keep && keepDestination ? (
        <>
          <div className="lp-lbl u">
            Where does {numberOf(incoming.card)} go?{" "}
            <span className="lp-hint">
              (anywhere, your choice.{" "}
              {keepDestination.kind === "bulk"
                ? "Bulk box"
                : destinationLabel(keepDestination, moveOptions)}{" "}
              is suggested)
            </span>
          </div>
          <DestinationPicker
            label={`Where ${numberOf(incoming.card)} goes`}
            card={incoming}
            value={value.incoming ?? keepDestination}
            suggested={keepDestination}
            options={moveOptions}
            busy={busy}
            onPick={(dest) => onChange({ ...base, keep: true, incoming: dest })}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * Where a card goes: the suggested place in one tap, or anywhere else through the Move sheet (a front half,
 * another line when `lineModel` is given, a collection).
 */
function DestinationPicker({
  label,
  card,
  value,
  suggested,
  options,
  lineModel,
  note = "",
  busy,
  onPick,
}: {
  label: string;
  /** ", new line" / ", into its slot" when the card goes into a line (UX review of #391). */
  note?: string;
  card: LinePopupReplace["current"];
  value: MoveDestination;
  suggested: MoveDestination;
  options?: MoveOptions;
  lineModel?(proposal: LineProposal): Promise<LinePopupModel>;
  busy: boolean;
  onPick(dest: MoveDestination, line?: OutgoingLine): void;
}) {
  const [sheet, setSheet] = useState<MoveDestination | null>(null);
  // Escape closes this sheet only, not the popup under it (escape-layer.ts).
  useEscapeLayer(sheet !== null, () => setSheet(null));
  const general = options?.binders.find((b) => b.type === "general");
  const specialty = options?.binders.find(
    (b) => b.type === "specialty" && (options.collectionsByBinder[b.id]?.length ?? 0) > 0,
  );
  const isSuggested = JSON.stringify(value) === JSON.stringify(suggested);
  const isBulk = value.kind === "bulk";
  const chips: {
    key: string;
    text: string;
    open?: MoveDestination;
    pick?: MoveDestination;
    on: boolean;
  }[] = [
    {
      key: "suggested",
      text: suggested.kind === "bulk" ? "Bulk box" : destinationLabel(suggested, options),
      pick: suggested,
      on: isSuggested,
    },
  ];
  // A one-tap bulk box even when the suggestion is elsewhere (UX review of #391).
  if (suggested.kind !== "bulk") {
    chips.push({
      key: "bulk",
      text: "Bulk box",
      pick: { kind: "bulk" },
      on: !isSuggested && isBulk,
    });
  }
  if (options && general) {
    chips.push({
      key: "front",
      text: "A front half…",
      open: { kind: "shelf", binderId: general.id, half: "front", band: card.card.bandKey },
      on: !isSuggested && value.kind === "shelf" && value.half === "front",
    });
    if (lineModel) {
      chips.push({
        key: "line",
        text: "Another line…",
        open: { kind: "shelf", binderId: general.id, half: "back", band: card.card.bandKey },
        on: !isSuggested && value.kind === "shelf" && value.half === "back",
      });
    }
  }
  if (options && specialty) {
    const first = options.collectionsByBinder[specialty.id][0];
    chips.push({
      key: "collection",
      text: "A collection…",
      open: { kind: "collection", binderId: specialty.id, collectionId: first.id },
      on: !isSuggested && value.kind === "collection",
    });
  }

  return (
    <div className="lp-dest">
      <div className="lp-bands" role="group" aria-label={label}>
        {chips.map((c) => (
          <button
            type="button"
            key={c.key}
            className={"lp-band u" + (c.on ? " on" : "")}
            aria-pressed={c.on}
            disabled={busy}
            onClick={() => (c.open ? setSheet(c.open) : onPick(c.pick ?? suggested))}
          >
            {c.text}
            {c.key === "suggested" ? <span className="lp-sugg">Suggested</span> : null}
          </button>
        ))}
      </div>
      {!isSuggested ? (
        <div className="lp-note">
          → {destinationLabel(value, options)}
          {note}
        </div>
      ) : null}
      {sheet && options ? (
        <MoveOverlay
          card={{
            copyId: card.copyId,
            tcgdexId: card.card.tcgdexId,
            name: card.card.name,
            localId: card.card.localId,
            setCardCountOfficial: card.card.setCardCountOfficial ?? null,
            imageUrl: card.card.imageUrl,
            bandKey: card.card.bandKey,
            currentLabel: card.where,
            initial: sheet,
            naturalBandKey: card.card.bandKey,
          }}
          options={options}
          lineModel={lineModel}
          openLineOnMount={sheet.kind === "shelf" && sheet.half === "back"}
          onClose={() => setSheet(null)}
          onConfirm={(dest, line) => {
            setSheet(null);
            onPick(dest, line as OutgoingLine | undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** UIL-069 on an Add: the line's colour or the card's own. Neither is picked until she picks. */
export function ColourChoiceSection({
  cardBand,
  lineBand,
  addSub,
  ownSub,
  picked,
  onPick,
  busy,
}: {
  cardBand: { key: string; display: string };
  lineBand: { key: string; display: string };
  addSub: string;
  ownSub: string;
  picked: "line" | "own" | null;
  onPick(pick: "line" | "own"): void;
  busy: boolean;
}) {
  return (
    <>
      <div className="lp-colour u">
        This card is <BandChip bandKey={cardBand.key} /> {cardBand.display}; this line is{" "}
        <BandChip bandKey={lineBand.key} /> {lineBand.display}.
      </div>
      <div className="lp-choice" role="radiogroup" aria-label="Which colour">
        <button
          type="button"
          role="radio"
          aria-checked={picked === "line"}
          className={"lp-opt" + (picked === "line" ? " on" : "")}
          disabled={busy}
          onClick={() => onPick("line")}
        >
          <b className="u">Add to the {lineBand.display} line</b>
          <span>{addSub}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={picked === "own"}
          className={"lp-opt" + (picked === "own" ? " on" : "")}
          disabled={busy}
          onClick={() => onPick("own")}
        >
          <b className="u">File by its own colour</b>
          <span>{ownSub}</span>
        </button>
      </div>
    </>
  );
}
