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

import { Fragment, useEffect, useState } from "react";
import { stageLabel } from "@/lib/line/popup";
import type {
  LineChoice,
  LinePopupExistingLine,
  LinePopupModel,
  LineProposal,
  LinePopupReplace,
  LinePopupStage,
} from "@/lib/line/popup";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { BandChip } from "./BandChip";
import { CardFace } from "./CardFace";
import { MoveOverlay } from "./MoveOverlay";
import { initialBox } from "@/lib/plan/bulk-units";
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
    case "bulk": {
      // UIL-130: the box she picked, by its name ("Shoebox"); none named: her bulk box.
      const box = dest.unitId ? options?.bulkUnits?.find((u) => u.id === dest.unitId) : undefined;
      return box ? box.name : "the bulk box";
    }
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
function DestinationPicker(props: {
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
  const { label, card, options, lineModel, note = "", busy, onPick } = props;
  let { value, suggested } = props;
  const [sheet, setSheet] = useState<MoveDestination | null>(null);
  // Escape closes this sheet only, not the popup under it (escape-layer.ts).
  useEscapeLayer(sheet !== null, () => setSheet(null));
  // UIL-130: "the bulk box" is one of her boxes. A suggestion or a pick that names none means her default box with
  // room (else her first with room), named, so what she confirms is the box the card goes to, never a full one.
  const boxes = options?.bulkUnits ?? [];
  const routeBox = boxes.length > 0 ? initialBox(boxes) : undefined;
  const named = (d: MoveDestination): MoveDestination =>
    d.kind === "bulk" && !d.unitId && routeBox ? { kind: "bulk", unitId: routeBox } : d;
  suggested = named(suggested);
  value = named(value);
  const everyBoxFull =
    boxes.length > 0 && boxes.every((u) => u.capacity !== null && u.held >= u.capacity);
  useEffect(() => {
    // The choice she confirms carries the box the screen shows (once, when it named none).
    if (value.kind === "bulk" && JSON.stringify(value) !== JSON.stringify(props.value))
      onPick(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBox]);
  const general = options?.binders.find((b) => b.type === "general");
  const specialty = options?.binders.find(
    (b) => b.type === "specialty" && (options.collectionsByBinder[b.id]?.length ?? 0) > 0,
  );
  const isSuggested = JSON.stringify(value) === JSON.stringify(suggested);
  const isBulk = value.kind === "bulk";
  /** A bulk chip says which box: "Bulk box" when she has one, its name when she has several. */
  const bulkText = (d: MoveDestination) => {
    const name = destinationLabel(d, options);
    // Her box named "Bulk box" reads as itself, never "Bulk · Bulk box" (as on the plan rows).
    return boxes.length > 1 && d.kind === "bulk" && name !== "Bulk box"
      ? `Bulk · ${name}`
      : "Bulk box";
  };
  const chips: {
    key: string;
    text: string;
    open?: MoveDestination;
    pick?: MoveDestination;
    on: boolean;
  }[] = [
    {
      key: "suggested",
      text: suggested.kind === "bulk" ? bulkText(suggested) : destinationLabel(suggested, options),
      pick: suggested,
      on: isSuggested,
    },
  ];
  // A one-tap bulk box even when the suggestion is elsewhere (UX review of #391).
  if (suggested.kind !== "bulk") {
    chips.push({
      key: "bulk",
      text: bulkText(named({ kind: "bulk" })),
      pick: named({ kind: "bulk" }),
      on: !isSuggested && isBulk,
    });
  }
  // UIL-130: with more than one box, any other box through the Move sheet (a full one shown, and refused there).
  if (options && boxes.length > 1) {
    chips.push({
      key: "box",
      text: "Another box…",
      open: named({ kind: "bulk" }),
      on: !isSuggested && isBulk && value.kind === "bulk" && value.unitId !== routeBox,
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
      {everyBoxFull && isBulk ? (
        <div className="lp-error" role="alert">
          Every bulk box is full. Pick another place, or raise a box&apos;s limit in Settings.
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

const LANGUAGE: Record<string, { name: string; flag: string }> = {
  en: { name: "English", flag: "🇬🇧" },
  ja: { name: "Japanese", flag: "🇯🇵" },
};
/** A locale's name and flag, as the popup names it ("🇯🇵 Japanese"). */
export const language = (l: string) => LANGUAGE[l] ?? { name: l, flag: "" };

/** "KB-001 · Front · Red" with each part kept whole, so a narrow tag never breaks "· Red" off on its own. */
export function Segments({ label }: { label: string }) {
  const parts = label.split(" · ");
  return (
    <>
      {parts.map((p, i) => (
        // The space before each "·" is the only place the tag may wrap.
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className="lp-seg">
            {i > 0 ? "· " : ""}
            {p}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/* ------------------------------ render-only parts, shared with Backfill's confirm sheet ------------------------------ */

/** "Stage 1" for the engine's "Stage1". */
export function stageName(stage: string | undefined): string {
  return stage ? stageLabel(stage) : "";
}

export function LineStageTile({
  stage,
  first,
  incomingLabel,
  asWanted,
  replace,
  swapping,
  ticked,
  onTogglePull,
  busy,
}: {
  stage: LinePopupStage;
  first: boolean;
  incomingLabel: string;
  /** UIL-069, filing by its own colour: the slot is wanted again, with no ring. */
  asWanted: boolean;
  /** A replace: this stage shows the card there now beside the one that could take its place. */
  replace?: LinePopupReplace;
  swapping: boolean;
  ticked: boolean;
  onTogglePull: () => void;
  busy: boolean;
}) {
  const c = asWanted ? null : stage.card;
  const number = c ? formatCollectorNumber(c.localId, c.setCardCountOfficial ?? null) : null;
  const arrow = first ? null : (
    <div className="lp-arrow" aria-hidden>
      ▶
    </div>
  );
  if (replace) {
    const side = (who: "now" | "new") => {
      const it = who === "now" ? replace.current : replace.incoming;
      const no = formatCollectorNumber(it.card.localId, it.card.setCardCountOfficial ?? null);
      const staying = who === "now" ? !swapping : swapping;
      return (
        <div
          className={
            "lp-side" + (who === "new" && swapping ? " lp-in" : "") + (staying ? "" : " lp-out")
          }
          data-side={who}
        >
          <CardFace
            name={it.card.name}
            tcgdexId={it.card.tcgdexId}
            imageUrl={it.card.imageUrl}
            size="l"
            zoomable
          />
          <div className="lp-no">
            {no ?? it.card.name} · {who === "now" ? "now" : "new"}
          </div>
        </div>
      );
    };
    return (
      <>
        {arrow}
        <div className="lp-slot lp-two" data-stage-state="replace">
          <div className="lp-stage u">{stageName(stage.stage)} · pick one</div>
          <div className="lp-pair">
            {side("now")}
            {side("new")}
          </div>
          <div className="lp-nm u">{replace.current.card.name}</div>
        </div>
      </>
    );
  }
  const state = asWanted ? "wanted" : stage.state;
  return (
    <>
      {arrow}
      <div className={"lp-slot" + (state === "incoming" ? " lp-in" : "")} data-stage-state={state}>
        <div className="lp-stage u">{stageName(stage.stage)}</div>
        {c ? (
          <CardFace name={c.name} tcgdexId={c.tcgdexId} imageUrl={c.imageUrl} size="l" zoomable />
        ) : (
          <div className="lp-empty" />
        )}
        <div className="lp-nm u">{c?.name ?? "No card yet"}</div>
        {number ? <div className="lp-no">{number}</div> : null}
        {state === "incoming" ? <span className="lp-src lp-haul">{incomingLabel}</span> : null}
        {state === "here" ? <span className="lp-src lp-binder">Already here</span> : null}
        {state === "wanted" ? (
          <span className="lp-src lp-want">
            {/* UIL-121: an existing line's open stage says what she chose for it; a new line's is "Wanted". */}
            {stage.choice === "chase"
              ? "Chasing"
              : stage.choice === "empty"
                ? "Left empty"
                : stage.choice === "filler"
                  ? "Filler"
                  : stage.choice === null
                    ? "Not decided"
                    : "Wanted"}
          </span>
        ) : null}
        {state === "blocked" ? (
          <span className="lp-src lp-want">{stage.choice === "filler" ? "Filler" : "Blocked"}</span>
        ) : null}
        {state === "coming" ? <span className="lp-src lp-haul">In this haul</span> : null}
        {state === "pullable" && stage.pull ? (
          <>
            <span className="lp-src lp-binder">
              In <Segments label={stage.pull.fromLabel} />
              {stage.pull.leaves ? (
                <span className="lp-seg"> · leaves the {stage.pull.leaves.lineName} one short</span>
              ) : null}
            </span>
            <label className="lp-pull u">
              <input type="checkbox" checked={ticked} onChange={onTogglePull} disabled={busy} />{" "}
              Pull it into this line
            </label>
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * UIL-096's warning, render-only: every line this family already has, anywhere. A line with an open slot for this
 * card is marked "Has room for this card" and listed first, with "Add it there instead" (the Senior BA's ruling: a
 * warning, never a block; nothing is picked for her, and starting a new line anyway stays hers). Renders nothing when
 * there are none. Shared by the line popup's START and Backfill's confirm sheet (UIL-117 PR 5).
 */
export function ExistingLinesBlock({
  existingLines,
  lineName,
  cardLocale,
  onSwitch,
  busy = false,
}: {
  existingLines: readonly LinePopupExistingLine[];
  /** The family's name as the header says it ("Charmeleon"). */
  lineName: string;
  cardLocale: string;
  /** "Add to that line": the screen opens that line. Absent, the tiles carry no button. */
  onSwitch?(proposal: LineProposal): void;
  busy?: boolean;
}) {
  if (existingLines.length === 0) return null;
  // The lines with room first; otherwise as they came (oldest first).
  const ordered = [...existingLines].sort(
    (a, b) => Number(!!b.joinSlotId) - Number(!!a.joinSlotId),
  );
  return (
    <div className="lp-also">
      <b className="u">
        You already have {existingLines.length} {lineName} line
        {existingLines.length === 1 ? "" : "s"}
      </b>
      Adding to one instead of starting another is one tap. Starting a second one is fine too.
      <div className="lp-minigrid">
        {ordered.map((l) => (
          <div className="lp-mini" key={l.lineId}>
            {l.face ? (
              <CardFace
                name={l.face.name}
                tcgdexId={l.face.tcgdexId}
                imageUrl={l.face.imageUrl}
                size="s"
              />
            ) : null}
            <span className="u">
              {l.binderName} · Back · {l.bandDisplay}
              <br />
              {language(l.locale).flag} {language(l.locale).name} · {l.filledCount}/{l.totalCount}{" "}
              filled
              {l.joinSlotId ? (
                <>
                  <br />
                  <b>Has room for this card</b>
                </>
              ) : null}
            </span>
            {l.joinSlotId && onSwitch ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onSwitch({ kind: "add", lineId: l.lineId, slotId: l.joinSlotId! })}
              >
                Add it there instead
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {existingLines.some((l) => l.locale !== cardLocale) ? (
        <div className="lp-note">
          A line in another language won&apos;t take this {language(cardLocale).name} card by
          default. You can still choose to.
        </div>
      ) : null}
    </div>
  );
}
