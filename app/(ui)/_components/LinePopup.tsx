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
  IN_THE_HAUL,
  type LineChoice,
  type LinePopupProps,
  type LinePopupReplace,
  type LinePopupStage,
} from "@/lib/line/popup";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { BandChip } from "./BandChip";
import { CardFace } from "./CardFace";
import { ColourChoiceSection, destinationLabel, lineNote, ReplaceChoice } from "./LinePopupParts";

const LANGUAGE: Record<string, { name: string; flag: string }> = {
  en: { name: "English", flag: "🇬🇧" },
  ja: { name: "Japanese", flag: "🇯🇵" },
};
const language = (l: string) => LANGUAGE[l] ?? { name: l, flag: "" };

/** "KB-001 · Front · Red" with each part kept whole, so a narrow tag never breaks "· Red" off on its own. */
function Segments({ label }: { label: string }) {
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
  const canConfirm = !busy && (!foreign || foreignConfirmed) && (!cc || cc.picked !== null);
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
          {model.stages.map((s, i) => (
            <Stage
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
            keepLabel={keepLabel}
            keepDestination={keepDestination}
            outgoingLineModel={outgoingLineModel}
            busy={busy}
          />
        ) : null}
        {cc ? <ColourChoiceSection {...cc} busy={busy} /> : null}

        <div className="lp-lbl u">What moves</div>
        {rep && value.mode === "replace" ? (
          <ReplaceMoves
            replace={rep}
            value={value}
            where={where}
            keepLabel={keepLabel}
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
                      <span className="lp-where">from {s.pull!.fromLabel} → into this line</span>
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
                    onChange(
                      e.target.checked
                        ? { ...value, foreignLocale: true }
                        : { mode: "join", lineId: value.lineId, slotId: value.slotId },
                    );
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

        {model.mode === "start" && model.existingLines.length > 0 ? (
          <div className="lp-also">
            <b className="u">
              You already have {model.existingLines.length} {lineName} line
              {model.existingLines.length === 1 ? "" : "s"}
            </b>
            Adding to one instead of starting another is one tap. Starting a second one is fine too.
            <div className="lp-minigrid">
              {model.existingLines.map((l) => (
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
                    {language(l.locale).flag} {language(l.locale).name} · {l.filledCount}/
                    {l.totalCount} filled
                  </span>
                  {l.joinSlotId && onSwitch ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        onSwitch({ kind: "add", lineId: l.lineId, slotId: l.joinSlotId! })
                      }
                    >
                      Add to that line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {model.existingLines.some((l) => l.locale !== card.locale) ? (
              <div className="lp-note">
                A line in another language won&apos;t take this {language(card.locale).name} card by
                default. You can still choose to.
              </div>
            ) : null}
          </div>
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
              else onConfirm(value);
            }}
          >
            {label}
            {/* "· next" only when another line card follows: the last one of N just confirms. */}
            {position && position.index < position.total ? " · next ▶" : " ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Stage 1" for the engine's "Stage1". */
function stageName(stage: string | undefined): string {
  return stage === "Stage1" ? "Stage 1" : stage === "Stage2" ? "Stage 2" : (stage ?? "");
}

function Stage({
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
        {state === "wanted" ? <span className="lp-src lp-want">Wanted</span> : null}
        {state === "blocked" ? <span className="lp-src lp-want">Blocked</span> : null}
        {state === "pullable" && stage.pull ? (
          <>
            <span className="lp-src lp-binder">
              In <Segments label={stage.pull.fromLabel} />
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
  moveOptions,
}: {
  replace: LinePopupReplace;
  value: Extract<LineChoice, { mode: "replace" }>;
  where: string;
  keepLabel?: string;
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
        {value.incoming ? (
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
