"use client";

/**
 * The line popup (UIL-117, mockup v3): ONE popup for every move into a back half, on every screen. It lays the line
 * out stage by stage with every card that would be in it, lists "What moves" as the physical to-do list, names the
 * lines the family already has before she starts a second one, and writes nothing until she confirms.
 *
 * Her rules, held here as well as on the server: a card she already owns is never pulled unless she ticks it
 * (UIL-061); joining a line in another language takes a second, explicit tick (the Senior BA's Q1 ruling). The screen
 * owns the stepping ("Confirm & next") and the write; this component only reports her choice.
 */

import { Fragment, useEffect, useRef } from "react";
import {
  chosenFillerCopyIds,
  IN_THE_HAUL,
  LINE_ROW_POCKETS,
  leavesLineText,
  type FillerCardOption,
  type LineChoice,
  type LinePopupProps,
  type LinePopupReplace,
  type LinePopupStage,
  type StageOption,
} from "@/lib/line/popup";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { BandChip } from "./BandChip";
import { CardFace } from "./CardFace";
import {
  ColourChoiceSection,
  destinationLabel,
  ExistingLinesBlock,
  language,
  lineNote,
  LineStageTile,
  ReplaceChoice,
  stageName,
} from "./LinePopupParts";
import { bulkFillerAction, stageOptionsAction } from "./line-popup-actions";
import { StageChoice, ThirdPocketChoice } from "./StageChoice";

/** A loader's answer, or its refusal thrown in her words (the part shows it in place). */
async function unwrap<T>(p: Promise<{ ok: true; options: T[] } | { ok: false; error: string }>) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.options;
}
const loadBulk = (): Promise<FillerCardOption[]> => unwrap(bulkFillerAction());

export function LinePopup({
  model,
  value,
  onChange,
  onConfirm,
  onCancel,
  position,
  confirmLabel,
  busy = false,
  error = null,
  incomingLabel = "Moving in",
  onSwitch,
  bands,
  onBand,
  moveOptions,
  keepLabel,
  keepTo,
  keepDestination,
  outgoingLineModel,
  colourChoice,
}: LinePopupProps) {
  const { line, card } = model;
  const rep = model.mode === "replace" && value.mode === "replace" ? model.replace : undefined;
  const swapping = value.mode === "replace" && !value.keep;
  // UIL-069 on an Add: neither colour is picked until she picks, and "own" is the screen's write, not a line.
  const cc = model.mode === "add" ? colourChoice : undefined;
  const filingOwn = cc?.picked === "own";
  const foreign =
    (model.mode === "add" && !filingOwn) || (model.mode === "replace" && swapping)
      ? card.locale !== line.locale
      : false;
  const pulls = value.mode === "start" ? value.pulls : [];
  const foreignConfirmed =
    (value.mode === "join" || (value.mode === "replace" && !value.keep)) &&
    value.foreignLocale === true;
  // UIL-121: on a START, every stage the line leaves unfilled (an open slot, or an owned card she did not tick) waits
  // for HER choice; nothing is decided for her. A confirm that completes a line shorter than LINE_ROW_POCKETS asks
  // what fills its third pocket (once: an existing line whose pocket she already chose does not ask again).
  // UIL-121, Karvi's ruling: she is asked about the stages still missing once she places the LAST card she has for the
  // line. While another card for this line waits in the haul ("In this haul"), nothing is asked yet: that card's
  // confirm asks. On a START every stage left unfilled is asked (an open slot, or an owned card she did not tick); on
  // a join or a swap, the line's other open stages she has not decided. Each answer is hers, "Decide later" included.
  const swappingIn = value.mode === "replace" && !value.keep;
  const cardWaits = model.stages.some((s) => s.state === "coming");
  const undecided: LinePopupStage[] = cardWaits
    ? []
    : value.mode === "start"
      ? model.stages.filter(
          (s) =>
            s.state === "wanted" ||
            s.state === "blocked" ||
            (s.state === "pullable" && !!s.pull && !pulls.includes(s.pull.copyId)),
        )
      : (value.mode === "join" || swappingIn) && !filingOwn
        ? model.stages.filter(
            (s) => s.state === "wanted" && s.choice === null && s.dexId !== undefined,
          )
        : [];
  const decisions =
    value.mode === "start" || value.mode === "join" || value.mode === "replace"
      ? "stages" in value
        ? value.stages
        : undefined
      : undefined;
  const chosen = chosenFillerCopyIds(
    decisions,
    value.mode === "start" || value.mode === "join" ? value.thirdPocket : null,
  );
  const stagesDecided = undecided.every((s) => decisions?.[s.stageIndex] !== undefined);
  const pocketAsked =
    !filingOwn &&
    !cardWaits &&
    line.total < LINE_ROW_POCKETS &&
    ((value.mode === "start" && undecided.length === 0) ||
      (value.mode === "join" && line.thirdPocketOpen === true && line.filledAfter === line.total));
  const pocketValue =
    value.mode === "start" || value.mode === "join" ? value.thirdPocket : undefined;
  const canConfirm =
    !busy &&
    (!foreign || foreignConfirmed) &&
    (!cc || cc.picked !== null) &&
    stagesDecided &&
    (!pocketAsked || pocketValue !== undefined);
  /** What she physically does besides moving cards, for "What moves": fillers she puts in, and what she now chases. */
  const fillerMoves: { key: string; verb: string; what: string; where: string; into?: false }[] =
    [];
  const fillerMove = (key: string, f: { material: string }, where: string) => {
    if (f.material === "energy")
      fillerMoves.push({ key, verb: "Put in", what: "A basic energy", where });
    if (f.material === "card")
      fillerMoves.push({ key, verb: "Take out", what: "A card from your bulk box", where });
  };
  for (const st of undecided) {
    const d = decisions?.[st.stageIndex];
    if (d?.kind === "filler")
      fillerMove(`s${st.stageIndex}`, d.filler, `the ${stageName(st.stage)} pocket`);
    if (d?.kind === "chase") {
      const sugg = st.suggestion?.card;
      const named =
        "catalogCardId" in d
          ? sugg && d.catalogCardId === sugg.tcgdexId
            ? `${sugg.name} ${formatCollectorNumber(sugg.localId, sugg.setCardCountOfficial ?? null) ?? ""}`.trim()
            : "The card you picked"
          : `Your placeholder card (${d.newStandIn.name.trim()})`;
      fillerMoves.push({
        key: `w${st.stageIndex}`,
        verb: "Wishlist",
        what: named,
        where: `for the ${stageName(st.stage)}`,
        into: false,
      });
    }
  }
  if (pocketAsked && pocketValue) fillerMove("third", pocketValue, "the third pocket");

  /** The choice as sent: stage answers only for the stages asked, and a third-pocket answer only when it is asked. */
  function finalChoice(): LineChoice {
    const open = new Set(undecided.map((s) => s.stageIndex));
    const asked = Object.fromEntries(
      Object.entries(decisions ?? {}).filter(([k]) => open.has(Number(k))),
    );
    if (value.mode === "start") {
      const { thirdPocket, ...rest } = value;
      return pocketAsked && thirdPocket
        ? { ...rest, stages: asked, thirdPocket }
        : { ...rest, stages: asked };
    }
    if (value.mode === "join") {
      const { thirdPocket, stages: _s, ...rest } = value;
      void _s;
      return {
        ...rest,
        ...(open.size > 0 ? { stages: asked } : {}),
        ...(pocketAsked && thirdPocket ? { thirdPocket } : {}),
      };
    }
    if (value.mode === "replace" && !value.keep) {
      const { stages: _s, ...rest } = value;
      void _s;
      return { ...rest, ...(open.size > 0 ? { stages: asked } : {}) };
    }
    return value;
  }
  /** A START's tiles say what she chose for each stage as she chooses (UX on #429). */
  const shownStages: LinePopupStage[] =
    value.mode === "start"
      ? model.stages.map((s) => {
          if (s.state !== "wanted" && s.state !== "blocked") return s;
          const d = value.stages?.[s.stageIndex];
          const choice =
            d?.kind === "chase" || d?.kind === "empty" || d?.kind === "filler" ? d.kind : null;
          return { ...s, choice };
        })
      : model.stages;
  const lineName = model.stages.at(-1)?.card?.name ?? card.name;
  const title =
    model.mode === "start"
      ? "Start a line"
      : model.mode === "add"
        ? "Add to a line"
        : "A copy for a filled slot";
  const label =
    confirmLabel ??
    (model.mode === "start"
      ? "Start line"
      : model.mode === "add"
        ? cc && cc.picked === null
          ? "Confirm"
          : filingOwn
            ? "File in front half"
            : "Add to line"
        : swapping
          ? "Swap them"
          : "Keep");
  const where = `${line.binderName} · Back · ${line.bandDisplay}`;
  // A replace's one-row strip scrolls sideways on a phone: start it on the slot being decided (UX review of #391).
  const stripRef = useRef<HTMLDivElement>(null);
  const isReplace = model.mode === "replace";
  useEffect(() => {
    const strip = stripRef.current;
    const two = strip?.querySelector<HTMLElement>(".lp-two");
    if (!isReplace || !strip || !two || strip.scrollWidth <= strip.clientWidth) return;
    const offset = two.getBoundingClientRect().left - strip.getBoundingClientRect().left;
    strip.scrollLeft += offset - (strip.clientWidth - two.offsetWidth) / 2;
  }, [isReplace]);
  const goingIn = 1 + pulls.length;

  function togglePull(copyId: string) {
    if (value.mode !== "start") return;
    const next = value.pulls.includes(copyId)
      ? value.pulls.filter((id) => id !== copyId)
      : [...value.pulls, copyId];
    onChange({ ...value, pulls: next } as LineChoice);
  }

  return (
    <div className="lp-pop panel" role="dialog" aria-label={title}>
      <div className="lp-cap">
        <span className="lp-t u">{title}</span>
        <span className="lp-n u">
          {lineName} · {line.binderName} · Back · <BandChip bandKey={line.bandKey} />{" "}
          {line.bandDisplay} · {language(line.locale).flag} {language(line.locale).name}
        </span>
        <button type="button" className="lp-x u" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
      <div className="lp-body">
        {bands && onBand && bands.length > 1 && model.mode !== "replace" ? (
          <>
            <div className="lp-lbl u" style={{ marginTop: 0 }}>
              Colour band
            </div>
            <div className="lp-bands" role="group" aria-label="Colour band">
              {bands.map((b) => {
                const on = b.key === line.bandKey;
                return (
                  <button
                    type="button"
                    key={b.key}
                    className={"lp-band u" + (on ? " on" : "")}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => (on ? undefined : onBand(b.key))}
                  >
                    <BandChip bandKey={b.key} /> {b.display}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        <div ref={stripRef} className={"lp-strip" + (isReplace ? " lp-scroll" : "")}>
          {shownStages.map((s, i) => (
            <LineStageTile
              key={s.stageIndex}
              stage={s}
              first={i === 0}
              incomingLabel={cc && cc.picked !== "line" ? "If you add it" : incomingLabel}
              asWanted={filingOwn && s.state === "incoming"}
              replace={rep && rep.stageIndex === s.stageIndex ? rep : undefined}
              swapping={swapping}
              ticked={!!s.pull && pulls.includes(s.pull.copyId)}
              onTogglePull={() => s.pull && togglePull(s.pull.copyId)}
              busy={busy}
            />
          ))}
        </div>

        {rep && value.mode === "replace" ? (
          <ReplaceChoice
            replace={rep}
            value={value}
            onChange={onChange}
            stageLabel={stageName(model.stages.find((s) => s.stageIndex === rep.stageIndex)?.stage)}
            moveOptions={moveOptions}
            keepLabel={
              keepTo
                ? `The new ${rep.incoming.card.name} goes to ${keepTo}. Nothing in the line moves.`
                : keepLabel
            }
            keepDestination={keepDestination}
            outgoingLineModel={outgoingLineModel}
            busy={busy}
          />
        ) : null}
        {cc ? <ColourChoiceSection {...cc} busy={busy} /> : null}

        {undecided.length > 0 ? (
          <>
            <div className="lp-lbl u">
              {value.mode === "start"
                ? "Your choice for each empty stage"
                : "This line's other empty stages: your choice"}
            </div>
            {undecided.map((s) => (
              <StageChoice
                key={s.stageIndex}
                stage={s}
                lineLocale={line.locale}
                value={decisions?.[s.stageIndex] ?? null}
                onChange={(d) =>
                  onChange({
                    ...value,
                    stages: { ...(decisions ?? {}), [s.stageIndex]: d },
                  } as LineChoice)
                }
                loadOptions={(): Promise<StageOption[]> =>
                  s.dexId === undefined
                    ? Promise.resolve([])
                    : unwrap(stageOptionsAction(s.dexId, line.locale, line.bandKey))
                }
                loadBulk={loadBulk}
                busy={busy}
                allowLater
                chosenFillerCopyIds={chosen}
              />
            ))}
          </>
        ) : null}
        {pocketAsked && (value.mode === "start" || value.mode === "join") ? (
          <ThirdPocketChoice
            value={value.thirdPocket ?? null}
            onChange={(t) => onChange({ ...value, thirdPocket: t })}
            loadBulk={loadBulk}
            busy={busy}
            allowLater
            chosenFillerCopyIds={chosen}
          />
        ) : null}

        <div className="lp-lbl u">What moves</div>
        {rep && value.mode === "replace" ? (
          <ReplaceMoves
            replace={rep}
            value={value}
            where={where}
            keepLabel={keepLabel}
            keepTo={keepTo}
            moveOptions={moveOptions}
          />
        ) : cc && cc.picked === null ? (
          <div className="lp-moves">
            <div className="lp-mrow lp-muted">Pick one above.</div>
          </div>
        ) : filingOwn && cc ? (
          <div className="lp-moves">
            <div className="lp-mrow">
              <span className="lp-verb u">Shelve</span>
              <CardFace
                name={card.name}
                tcgdexId={card.tcgdexId}
                imageUrl={card.imageUrl}
                size="s"
              />
              <span>
                {card.name} <span className="lp-where">→ {cc.ownSub}</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="lp-moves">
            <div className="lp-mrow">
              <span className="lp-verb u">Shelve</span>
              <CardFace
                name={card.name}
                tcgdexId={card.tcgdexId}
                imageUrl={card.imageUrl}
                size="s"
              />
              <span>
                {card.name}{" "}
                <span className="lp-where">
                  → {where}
                  {model.mode === "start" ? ", new line" : ", into its slot"}
                </span>
              </span>
            </div>
            {model.stages
              .filter((s) => s.state === "pullable" && s.pull && s.card)
              .map((s) =>
                pulls.includes(s.pull!.copyId) ? (
                  <div className="lp-mrow" key={s.pull!.copyId}>
                    <span className="lp-verb u">Take out</span>
                    <CardFace
                      name={s.card!.name}
                      tcgdexId={s.card!.tcgdexId}
                      imageUrl={s.card!.imageUrl}
                      size="s"
                    />
                    <span>
                      {s.card!.name}{" "}
                      <span className="lp-where">
                        from {s.pull!.fromLabel} → into this line
                        {s.pull!.leaves ? <> · {leavesLineText(s.pull!.leaves)}</> : null}
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="lp-mrow lp-muted" key={s.pull!.copyId}>
                    <span className="lp-verb u">Stays put</span>
                    <CardFace
                      name={s.card!.name}
                      tcgdexId={s.card!.tcgdexId}
                      imageUrl={s.card!.imageUrl}
                      size="s"
                    />
                    <span>
                      {s.card!.name}{" "}
                      <span className="lp-where">
                        stays in {s.pull!.fromLabel} unless you tick &quot;Pull it into this
                        line&quot; above
                      </span>
                    </span>
                  </div>
                ),
              )}
            {/* UIL-121: a filler is something she physically puts in a pocket, so it is on the to-do list too. */}
            {fillerMoves.map((m) => (
              <div className="lp-mrow" key={m.key}>
                <span className="lp-verb u">{m.verb}</span>
                <span>
                  {m.what}{" "}
                  <span className="lp-where">
                    {m.into === false ? "· " : "→ "}
                    {m.where}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        {foreign ? (
          <div className="lp-also" role="alert">
            <b className="u">
              This line is {language(line.locale).name} and this card is{" "}
              {language(card.locale).name}
            </b>
            It won&apos;t join a line in another language by default. You can still choose to.
            <label className="lp-pull u">
              <input
                type="checkbox"
                checked={foreignConfirmed}
                disabled={busy}
                onChange={(e) => {
                  if (value.mode === "join") {
                    const { foreignLocale: _was, ...rest } = value;
                    void _was;
                    onChange(e.target.checked ? { ...rest, foreignLocale: true } : rest);
                  } else if (value.mode === "replace" && !value.keep) {
                    const { foreignLocale: _drop, ...rest } = value;
                    void _drop;
                    onChange(e.target.checked ? { ...rest, foreignLocale: true } : rest);
                  }
                }}
              />{" "}
              Join the {language(line.locale).name} line anyway
            </label>
          </div>
        ) : null}

        {model.mode === "start" ? (
          <ExistingLinesBlock
            existingLines={model.existingLines}
            lineName={lineName}
            cardLocale={card.locale}
            onSwitch={onSwitch}
            busy={busy}
          />
        ) : null}

        {error ? (
          <div className="lp-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="lp-foot">
          <span className="lp-sum u">
            {position ? `Line card ${position.index} of ${position.total} · ` : ""}
            {model.mode === "replace"
              ? swapping
                ? `Line stays ${line.filledAfter}/${line.total} the whole time · one step, no gap · `
                : "Nothing in the line moves · "
              : cc && cc.picked === null
                ? "Pick one above · "
                : filingOwn
                  ? "Filed by its own colour, not in a line · "
                  : `${goingIn} card${goingIn === 1 ? "" : "s"} go${goingIn === 1 ? "es" : ""} in · ${line.filledAfter + pulls.length}/${line.total} filled · `}
            nothing is written until you confirm
          </span>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm) return;
              if (filingOwn && cc) cc.onConfirmOwn();
              else onConfirm(finalChoice());
            }}
          >
            {label}
            {/* "· next" only when another line card follows: the last one of N just confirms. */}
            {position && (position.next ?? position.index < position.total) ? " · next ▶" : " ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "from this haul" rather than "from Still in the haul" (a Haul Plan card, UX review of #391). */
function fromWhere(where: string): string {
  return where === IN_THE_HAUL ? "this haul" : where;
}

/** "What moves" for a replace: the swap as three physical steps, or the Keep as nothing in the line moving. */
function ReplaceMoves({
  replace,
  value,
  where,
  keepLabel,
  keepTo,
  moveOptions,
}: {
  replace: LinePopupReplace;
  value: Extract<LineChoice, { mode: "replace" }>;
  where: string;
  keepLabel?: string;
  keepTo?: string;
  moveOptions?: LinePopupProps["moveOptions"];
}) {
  const { current, incoming } = replace;
  const face = (it: LinePopupReplace["current"]) => (
    <CardFace
      name={it.card.name}
      tcgdexId={it.card.tcgdexId}
      imageUrl={it.card.imageUrl}
      size="s"
    />
  );
  const no = (it: LinePopupReplace["current"]) =>
    formatCollectorNumber(it.card.localId, it.card.setCardCountOfficial ?? null) ?? "";
  if (value.keep) {
    return (
      <div className="lp-moves">
        <div className="lp-mrow lp-muted">
          <span className="lp-verb u">Stays put</span>
          {face(current)}
          <span>
            {current.card.name} {no(current)} <span className="lp-where">stays in the line</span>
          </span>
        </div>
        {keepTo && !value.incoming ? (
          // A place the screen already decided (the Haul Plan's extra copy): it moves there, no picker.
          <div className="lp-mrow">
            <span className="lp-verb u">Shelve</span>
            {face(incoming)}
            <span>
              {incoming.card.name} {no(incoming)}{" "}
              <span className="lp-where">
                from {fromWhere(incoming.where)} → {keepTo}
              </span>
            </span>
          </div>
        ) : value.incoming ? (
          <div className="lp-mrow">
            <span className="lp-verb u">
              {value.incoming.kind === "bulk" ? "To bulk" : "Shelve"}
            </span>
            {face(incoming)}
            <span>
              {incoming.card.name} {no(incoming)}{" "}
              <span className="lp-where">
                from {fromWhere(incoming.where)} → {destinationLabel(value.incoming, moveOptions)}
              </span>
            </span>
          </div>
        ) : (
          // Nothing moves for it either (the Lines page): it stays where it is.
          <div className="lp-mrow lp-muted">
            <span className="lp-verb u">Stays put</span>
            {face(incoming)}
            <span>
              {incoming.card.name} {no(incoming)}{" "}
              <span className="lp-where">{keepLabel ?? `stays in ${incoming.where}`}</span>
            </span>
          </div>
        )}
      </div>
    );
  }
  const bulk = value.outgoing.kind === "bulk";
  return (
    <div className="lp-moves">
      <div className="lp-mrow">
        <span className="lp-verb u">Take out</span>
        {face(current)}
        <span>
          {current.card.name} {no(current)} <span className="lp-where">from {current.where}</span>
        </span>
      </div>
      <div className="lp-mrow">
        <span className="lp-verb u">Shelve</span>
        {face(incoming)}
        <span>
          {incoming.card.name} {no(incoming)}{" "}
          <span className="lp-where">
            from {fromWhere(incoming.where)} → {where}, into its spot
          </span>
        </span>
      </div>
      <div className="lp-mrow">
        <span className="lp-verb u">{bulk ? "To bulk" : "Move"}</span>
        {face(current)}
        <span>
          {current.card.name} {no(current)}{" "}
          <span className="lp-where">
            → {destinationLabel(value.outgoing, moveOptions)}
            {lineNote(value.outgoingLine)}
          </span>
        </span>
      </div>
    </div>
  );
}
