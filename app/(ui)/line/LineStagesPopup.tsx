"use client";

/**
 * Lines' "Choose" (UIL-121 A2c): her choice for an existing line's open stages, and for a complete short line's third
 * pocket, in one popup and one write. Karvi, 2026-09-27: nothing is written for her; a stage she left "Not decided"
 * (or one from before her choices existed) is decided here, and she can change her mind. The same parts as the line
 * popup (StageChoice, ThirdPocketChoice): the suggestion is shown and never selected, and "Decide later" is always
 * there. The server checks every choice again (lib/line/decide-stages.ts).
 */

import { useEffect, useMemo, useState } from "react";
import {
  chosenFillerCopyIds,
  stageLabel,
  type FillerCardOption,
  type StageDecision,
  type StageOption,
  type ThirdPocketChoice as ThirdPocketValue,
} from "@/lib/line/popup";
import type { LineStagesModel } from "@/lib/line/stages-load";
import type { DecideStagesChoice } from "@/lib/line/decide-stages";
import { BandChip } from "../_components/BandChip";
import { bulkFillerAction, stageOptionsAction } from "../_components/line-popup-actions";
import { StageChoice, ThirdPocketChoice } from "../_components/StageChoice";
import { useEscapeLayer } from "../_components/escape-layer";

async function unwrap<T>(p: Promise<{ ok: true; options: T[] } | { ok: false; error: string }>) {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.options;
}
const loadBulk = (): Promise<FillerCardOption[]> => unwrap(bulkFillerAction());
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** A stage's choice in a word or two, for the strip across the top. */
const STRIP_WORD: Record<StageDecision["kind"], string> = {
  chase: "Chasing",
  empty: "Left empty",
  filler: "Filler",
  later: "Decide later",
};

export function LineStagesPopup({
  lineId,
  loadModel,
  onConfirm,
  onClose,
  busy = false,
  error = null,
}: {
  lineId: string;
  /** The popup's model for this line; a refusal throws its message. */
  loadModel(lineId: string): Promise<LineStagesModel>;
  /** Her choices: the screen writes them and refreshes. */
  onConfirm(choice: DecideStagesChoice): void;
  onClose(): void;
  busy?: boolean;
  error?: string | null;
}) {
  const [model, setModel] = useState<LineStagesModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stages, setStages] = useState<Record<number, StageDecision>>({});
  const [pocket, setPocket] = useState<ThirdPocketValue | null>(null);
  useEscapeLayer(true, onClose);

  useEffect(() => {
    let live = true;
    loadModel(lineId).then(
      (m) => {
        if (!live) return;
        setModel(m);
        setStages(m.current);
        setPocket(m.thirdPocket?.current ?? null);
      },
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [lineId, loadModel]);

  const open = useMemo(
    () => (model?.stages ?? []).filter((s) => s.state !== "here" && s.dexId !== undefined),
    [model],
  );
  /** Only what she changed is sent. */
  const changed = useMemo(() => {
    if (!model) return null;
    const out: Record<number, StageDecision> = {};
    for (const s of open) {
      const d = stages[s.stageIndex];
      if (d && !same(d, model.current[s.stageIndex])) out[s.stageIndex] = d;
    }
    const pocketChanged =
      !!model.thirdPocket && pocket !== null && !same(pocket, model.thirdPocket.current);
    return { stages: out, pocket: pocketChanged ? pocket : null };
  }, [model, open, stages, pocket]);
  const chosen = chosenFillerCopyIds(stages, pocket);
  const anyChange =
    !!changed && (Object.keys(changed.stages).length > 0 || changed.pocket !== null);

  return (
    <div className="lp-overlay">
      <div className="lp-pop panel" role="dialog" aria-label="Choose for this line">
        <div className="lp-cap">
          <span className="lp-t u">Choose for this line</span>
          {model ? (
            <span className="lp-n u">
              {model.line.name} · {model.line.binderName} · Back ·{" "}
              <BandChip bandKey={model.line.bandKey} /> {model.line.bandDisplay}
            </span>
          ) : null}
          <button type="button" className="lp-x u" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="lp-body">
          {model ? (
            // UX (A2c): the whole line at a glance, above the choices, following them as she makes them.
            <ol className="lp-stagestrip" aria-label="This line's stages">
              {model.stages.map((s) => {
                const d = stages[s.stageIndex];
                return (
                  <li
                    key={s.stageIndex}
                    className={s.state === "here" ? "here" : d ? "decided" : "open"}
                  >
                    <b className="u">{stageLabel(s.stage)}</b>{" "}
                    {s.state === "here"
                      ? (s.card?.name ?? "Has its card")
                      : d
                        ? STRIP_WORD[d.kind]
                        : "Not decided"}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {loadError ? (
            <div className="lp-error" role="alert">
              {loadError}
            </div>
          ) : !model ? (
            <div className="lp-note">Loading the line…</div>
          ) : (
            <>
              {open.length === 0 && !model.thirdPocket ? (
                <div className="lp-note">Every stage of this line holds a card.</div>
              ) : null}
              {open.map((s) => (
                <StageChoice
                  key={s.stageIndex}
                  stage={s}
                  lineLocale={model.line.locale}
                  value={stages[s.stageIndex] ?? null}
                  onChange={(d) => setStages((prev) => ({ ...prev, [s.stageIndex]: d }))}
                  loadOptions={(): Promise<StageOption[]> =>
                    unwrap(stageOptionsAction(s.dexId!, model.line.locale, model.line.bandKey))
                  }
                  loadBulk={loadBulk}
                  busy={busy}
                  allowLater
                  chosenFillerCopyIds={chosen}
                />
              ))}
              {model.thirdPocket ? (
                <ThirdPocketChoice
                  value={pocket}
                  onChange={setPocket}
                  loadBulk={loadBulk}
                  busy={busy}
                  allowLater
                  chosenFillerCopyIds={chosen}
                />
              ) : null}
            </>
          )}
          {error ? (
            <div className="lp-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="lp-foot">
            <span className="lp-sum u">
              {/* UX (A2c): say why Save is off, not just grey it. */}
              {model && !anyChange
                ? "Change a choice to save"
                : "nothing is written until you save"}
            </span>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !anyChange}
              onClick={() =>
                changed &&
                onConfirm({
                  lineId,
                  stages: changed.stages,
                  ...(changed.pocket ? { thirdPocket: changed.pocket } : {}),
                })
              }
            >
              Save ▶
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
