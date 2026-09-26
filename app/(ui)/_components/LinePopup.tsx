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

import type { LineChoice, LinePopupProps, LinePopupStage } from "@/lib/line/popup";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "./CardFace";

const LANGUAGE: Record<string, { name: string; flag: string }> = {
  en: { name: "English", flag: "🇬🇧" },
  ja: { name: "Japanese", flag: "🇯🇵" },
};
const language = (l: string) => LANGUAGE[l] ?? { name: l, flag: "" };

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
}: LinePopupProps) {
  const { line, card } = model;
  const foreign = model.mode === "add" && card.locale !== line.locale;
  const pulls = value.mode === "start" ? value.pulls : [];
  const foreignConfirmed = value.mode === "join" && value.foreignLocale === true;
  const canConfirm = !busy && (!foreign || foreignConfirmed);
  const lineName = model.stages.at(-1)?.card?.name ?? card.name;
  const title =
    model.mode === "start"
      ? "Start a line"
      : model.mode === "add"
        ? "Add to a line"
        : "A copy for a filled slot";
  const label =
    confirmLabel ??
    (model.mode === "start" ? "Start line" : model.mode === "add" ? "Add to line" : "Confirm");
  const where = `${line.binderName} · Back · ${line.bandDisplay}`;
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
          {lineName} · {where} · {language(line.locale).flag} {language(line.locale).name}
        </span>
        <button type="button" className="lp-x u" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
      <div className="lp-body">
        <div className="lp-strip">
          {model.stages.map((s, i) => (
            <Stage
              key={s.stageIndex}
              stage={s}
              first={i === 0}
              incomingLabel={incomingLabel}
              ticked={!!s.pull && pulls.includes(s.pull.copyId)}
              onTogglePull={() => s.pull && togglePull(s.pull.copyId)}
              busy={busy}
            />
          ))}
        </div>

        <div className="lp-lbl u">What moves</div>
        <div className="lp-moves">
          <div className="lp-mrow">
            <span className="lp-verb u">Shelve</span>
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
                  <span>
                    {s.card!.name}{" "}
                    <span className="lp-where">from {s.pull!.fromLabel} → into this line</span>
                  </span>
                </div>
              ) : (
                <div className="lp-mrow lp-muted" key={s.pull!.copyId}>
                  <span className="lp-verb u">Stays put</span>
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

        {foreign ? (
          <div className="lp-also" role="alert">
            <b className="u">
              This is a {language(line.locale).name} line, and this card is{" "}
              {language(card.locale).name}
            </b>
            It won&apos;t join a line in another language by default. You can still choose to.
            <label className="lp-pull u">
              <input
                type="checkbox"
                checked={foreignConfirmed}
                disabled={busy}
                onChange={(e) =>
                  value.mode === "join" &&
                  onChange(
                    e.target.checked
                      ? { ...value, foreignLocale: true }
                      : { mode: "join", lineId: value.lineId, slotId: value.slotId },
                  )
                }
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
            {goingIn} card{goingIn === 1 ? "" : "s"} go{goingIn === 1 ? "es" : ""} in ·{" "}
            {line.filledAfter + pulls.length}/{line.total} filled · nothing is written until you
            confirm
          </span>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canConfirm}
            onClick={() => canConfirm && onConfirm(value)}
          >
            {label}
            {position ? " · next ▶" : " ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stage({
  stage,
  first,
  incomingLabel,
  ticked,
  onTogglePull,
  busy,
}: {
  stage: LinePopupStage;
  first: boolean;
  incomingLabel: string;
  ticked: boolean;
  onTogglePull: () => void;
  busy: boolean;
}) {
  const c = stage.card;
  const number = c ? formatCollectorNumber(c.localId, c.setCardCountOfficial ?? null) : null;
  return (
    <>
      {first ? null : (
        <div className="lp-arrow" aria-hidden>
          ▶
        </div>
      )}
      <div
        className={"lp-slot" + (stage.state === "incoming" ? " lp-in" : "")}
        data-stage-state={stage.state}
      >
        <div className="lp-stage u">
          {stage.stage === "Stage1"
            ? "Stage 1"
            : stage.stage === "Stage2"
              ? "Stage 2"
              : stage.stage}
        </div>
        {c ? (
          <CardFace name={c.name} tcgdexId={c.tcgdexId} imageUrl={c.imageUrl} size="m" zoomable />
        ) : (
          <div className="lp-empty" />
        )}
        <div className="lp-nm u">{c?.name ?? "No card yet"}</div>
        {number ? <div className="lp-no">{number}</div> : null}
        {stage.state === "incoming" ? (
          <span className="lp-src lp-haul">{incomingLabel}</span>
        ) : null}
        {stage.state === "here" ? <span className="lp-src lp-binder">Already here</span> : null}
        {stage.state === "wanted" ? <span className="lp-src lp-want">Wanted</span> : null}
        {stage.state === "blocked" ? <span className="lp-src lp-want">Blocked</span> : null}
        {stage.state === "pullable" && stage.pull ? (
          <>
            <span className="lp-src lp-binder">In {stage.pull.fromLabel}</span>
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
