"use client";

/**
 * Her choice for one unfilled stage of a line, and for a complete short line's third pocket (UIL-121). Karvi,
 * 2026-09-27: nothing is written for her. Each empty stage shows a SUGGESTION (the cheapest same-colour printing in
 * the line's language, else the special one), never selected, and waits for her to:
 *   - chase it, or pick another printing (the species in the line's language; another colour is tagged);
 *   - make a placeholder card when the catalog lacks it (a catalog-only stand-in, in the line's language);
 *   - leave the stage empty;
 *   - or record what fills its pocket: a basic energy, or a spare card from her bulk box.
 *
 * Render and report only: `onChange` hands her decision to the popup, and the server checks it again on confirm
 * (lib/line/stage-choice.ts). One piece, used by every screen that opens the line popup and by Backfill's sheet.
 */

import { useState } from "react";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { languageName } from "@/lib/catalog/locale";
import {
  stageLabel,
  type FillerCardOption,
  type FillerSource,
  type LinePopupStage,
  type StageDecision,
  type StageOption,
  type StandInDraft,
  type ThirdPocketChoice as ThirdPocketValue,
} from "@/lib/line/popup";
import type { CardIdentity } from "@/lib/line/types";
import type { Locale } from "@/lib/sync/types";
import { CardFace } from "./CardFace";

type Panel = "pick" | "standin" | "filler" | null;

const BULK_ONLY: readonly FillerSource[] = ["bulk"];
/** A pick's source, sent only when it is not the bulk box (the default), so the popup screens send what they did. */
const fromOf = (o: FillerCardOption) => (o.from && o.from !== "bulk" ? { from: o.from } : {});

/** Which words the filler list uses: her bulk box, her haul, or both (each card then tagged with where it is). */
type FillerWordsKey = "bulk" | "haul" | "both";
const wordsKey = (from: readonly FillerSource[]): FillerWordsKey =>
  from.includes("bulk") && from.includes("haul") ? "both" : from.includes("haul") ? "haul" : "bulk";

/** The words for a filler card's source, so every place the part names it agrees. */
const FILLER_WORDS: Record<
  FillerWordsKey,
  { option: string; leaves: string; loading: string; none: string; list: string; from: string }
> = {
  bulk: {
    option: "A card from your bulk box",
    leaves: "It leaves the bulk box and holds the pocket.",
    loading: "Loading your bulk box…",
    none: "Your bulk box is empty.",
    list: "Cards in your bulk box",
    from: "from your bulk box",
  },
  both: {
    option: "A spare card from your bulk box or this haul",
    leaves: "It comes out of the bulk box or the haul and holds the pocket.",
    loading: "Loading your spare cards…",
    none: "No spare card in your bulk box or this haul.",
    list: "Spare cards: your bulk box, then this haul",
    from: "",
  },
  haul: {
    option: "A spare card from your haul",
    leaves: "It comes out of the haul and holds the pocket.",
    loading: "Loading your haul…",
    none: "No card is waiting in your haul.",
    list: "Cards waiting in your haul",
    from: "from your haul",
  },
};

const numberOf = (c: CardIdentity) =>
  formatCollectorNumber(c.localId, c.setCardCountOfficial ?? null) ?? c.name;
const labelOf = (c: CardIdentity) => `${c.name} ${numberOf(c)}`.trim();

/** What she has chosen, in her words, for the stage's header. */
export function stageDecisionLabel(
  d: StageDecision | null,
  cardName: (id: string) => string | null,
  fillerName: (copyId: string) => string | null,
  fillerFrom: readonly FillerSource[] = ["bulk"],
  /** Where the chosen filler card is ("Bulk box", "This haul"), said when the list has both. */
  fillerWhere: (copyId: string) => string | null = () => null,
): string {
  if (!d) return "Choose";
  switch (d.kind) {
    case "chase":
      return "catalogCardId" in d
        ? `Chasing ${cardName(d.catalogCardId) ?? "that card"}`
        : `Chasing a placeholder card: ${d.newStandIn.name.trim()}`;
    case "empty":
      return "Left empty";
    case "later":
      return "Decide later";
    case "filler":
      return d.filler.material === "energy"
        ? "Filler: a basic energy"
        : wordsKey(fillerFrom) === "both"
          ? `Filler: ${fillerName(d.filler.copyId) ?? "a card"}${
              fillerWhere(d.filler.copyId) ? ` · ${fillerWhere(d.filler.copyId)}` : ""
            }`
          : `Filler: ${fillerName(d.filler.copyId) ?? "a card"} ${FILLER_WORDS[wordsKey(fillerFrom)].from}`;
  }
}

/** A grid of cards to pick from, image first (it's a visual hobby). */
function CardGrid<T>({
  items,
  keyOf,
  cardOf,
  tagOf,
  selected,
  onPick,
  busy,
  label,
}: {
  items: readonly T[];
  keyOf(t: T): string;
  cardOf(t: T): CardIdentity;
  tagOf?(t: T): string | null;
  selected: string | null;
  onPick(t: T): void;
  busy: boolean;
  label: string;
}) {
  return (
    <div className="lp-minigrid" role="group" aria-label={label}>
      {items.map((t) => {
        const c = cardOf(t);
        const tag = tagOf?.(t) ?? null;
        const k = keyOf(t);
        return (
          <button
            type="button"
            key={k}
            className={"lp-mini lp-pick" + (selected === k ? " on" : "")}
            aria-pressed={selected === k}
            disabled={busy}
            onClick={() => onPick(t)}
          >
            <CardFace name={c.name} tcgdexId={c.tcgdexId} imageUrl={c.imageUrl} size="s" />
            <span className="u">
              {labelOf(c)}
              {tag ? (
                <>
                  <br />
                  <span className="lp-tag">{tag}</span>
                </>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Loads a list once, on first open; says so while it loads and when it fails. */
function useLoaded<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const open = async () => {
    if (items || loading) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That list could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  };
  return { items, error, loading, open };
}

/** The bulk-box picker and the energy option, shared by a stage's filler and the third pocket. */
function FillerPicker({
  value,
  onEnergy,
  onCard,
  bulk,
  busy,
  fillerFrom,
}: {
  value: { material: "energy" } | { material: "card"; copyId: string } | null;
  onEnergy(): void;
  onCard(o: FillerCardOption): void;
  bulk: ReturnType<typeof useLoaded<FillerCardOption>>;
  busy: boolean;
  fillerFrom: readonly FillerSource[];
}) {
  const key = wordsKey(fillerFrom);
  const words = FILLER_WORDS[key];
  const [showBulk, setShowBulk] = useState(value?.material === "card");
  return (
    <>
      <div className="lp-choice">
        <button
          type="button"
          className={"lp-opt" + (value?.material === "energy" ? " on picked" : "")}
          aria-pressed={value?.material === "energy"}
          disabled={busy}
          onClick={onEnergy}
        >
          <b className="u">A basic energy</b>
          <span>Not tracked: it just holds the pocket.</span>
        </button>
        <button
          type="button"
          className={"lp-opt" + (value?.material === "card" ? " on picked" : "")}
          aria-pressed={value?.material === "card"}
          disabled={busy}
          onClick={() => {
            setShowBulk(true);
            void bulk.open();
          }}
        >
          <b className="u">{words.option}</b>
          <span>{words.leaves}</span>
        </button>
      </div>
      {showBulk ? (
        bulk.loading ? (
          <div className="lp-note">{words.loading}</div>
        ) : bulk.error ? (
          <div className="lp-error" role="alert">
            {bulk.error}
          </div>
        ) : bulk.items && bulk.items.length === 0 ? (
          <div className="lp-note">{words.none}</div>
        ) : bulk.items ? (
          <CardGrid
            label={words.list}
            tagOf={key === "both" ? (o) => o.where : undefined}
            items={bulk.items}
            keyOf={(o) => o.copyId}
            cardOf={(o) => o.card}
            selected={value?.material === "card" ? value.copyId : null}
            onPick={onCard}
            busy={busy}
          />
        ) : null
      ) : null}
    </>
  );
}

/** The small form for a placeholder card: what she typed; the rest comes from the stage on the server. */
function StandInFields({
  stage,
  lineLocale,
  initial,
  onSave,
  busy,
}: {
  stage: LinePopupStage;
  lineLocale: Locale;
  initial: StandInDraft | null;
  onSave(d: StandInDraft): void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? stage.suggestion?.card.name ?? "");
  const [setLabel, setSetLabel] = useState(initial?.setName ?? "");
  const [localId, setLocalId] = useState(initial?.localId ?? "");
  const canSave = name.trim().length > 0 && !busy;
  return (
    <div className="lp-standin" role="group" aria-label="Make a placeholder card">
      <p className="lp-note">
        A placeholder card is your own record for a card the catalog doesn&apos;t have yet. It is in
        this line&apos;s language ({languageName(lineLocale)}) and is a {stageLabel(stage.stage)}.
        Nothing is added to your collection.
      </p>
      <label className="orow">
        <div className="ol u">Name</div>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
        <label className="orow">
          <div className="ol u">Set</div>
          <input className="field" value={setLabel} onChange={(e) => setSetLabel(e.target.value)} />
        </label>
        <label className="orow">
          <div className="ol u">Number</div>
          <input
            className="field"
            style={{ width: 90 }}
            value={localId}
            onChange={(e) => setLocalId(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn"
        disabled={!canSave}
        onClick={() =>
          onSave({
            name: name.trim(),
            setName: setLabel.trim() || null,
            localId: localId.trim() || null,
            language: lineLocale,
          })
        }
      >
        Chase this placeholder card
      </button>
    </div>
  );
}

export function StageChoice({
  stage,
  lineLocale,
  value,
  onChange,
  loadOptions,
  loadBulk,
  busy = false,
  fillerFrom = BULK_ONLY,
  allowLater = false,
}: {
  stage: LinePopupStage;
  lineLocale: Locale;
  value: StageDecision | null;
  onChange(d: StageDecision): void;
  loadOptions(): Promise<StageOption[]>;
  loadBulk(): Promise<FillerCardOption[]>;
  busy?: boolean;
  /** Where a filler card may come from: the bulk box (default); Backfill offers ["bulk", "haul"]. */
  fillerFrom?: readonly FillerSource[];
  /** Offer "Decide later" (the line popup): the stage stays not decided, and this card still goes in. */
  allowLater?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const options = useLoaded(loadOptions);
  const bulk = useLoaded(loadBulk);
  const suggestion = stage.suggestion ?? null;

  const cardName = (id: string) => {
    if (suggestion?.card.tcgdexId === id) return labelOf(suggestion.card);
    const o = options.items?.find((x) => x.card.tcgdexId === id);
    return o ? labelOf(o.card) : null;
  };
  const fillerName = (copyId: string) => {
    const o = bulk.items?.find((x) => x.copyId === copyId);
    return o ? labelOf(o.card) : null;
  };
  const fillerWhere = (copyId: string) =>
    bulk.items?.find((x) => x.copyId === copyId)?.where ?? null;
  const chasing = value?.kind === "chase" && "catalogCardId" in value ? value.catalogCardId : null;
  const pick = (d: StageDecision) => {
    onChange(d);
    setPanel(null);
  };
  const toggle = (p: Exclude<Panel, null>) => {
    setPanel(panel === p ? null : p);
    if (p === "pick") void options.open();
  };

  return (
    <section
      className="lp-stagechoice"
      data-stage-index={stage.stageIndex}
      aria-label={`${stageLabel(stage.stage)}: ${stageDecisionLabel(value, cardName, fillerName, fillerFrom, fillerWhere)}`}
    >
      <div className="lp-lbl u">
        {stageLabel(stage.stage)} ·{" "}
        {stageDecisionLabel(value, cardName, fillerName, fillerFrom, fillerWhere)}
      </div>

      {suggestion ? (
        <div className="lp-mini lp-suggested">
          <CardFace
            name={suggestion.card.name}
            tcgdexId={suggestion.card.tcgdexId}
            imageUrl={suggestion.card.imageUrl}
            size="s"
            zoomable
          />
          <span className="u">
            Suggested: {labelOf(suggestion.card)}
            {suggestion.special ? (
              <>
                <br />
                <span className="lp-tag">Special: lives in the specialty binder</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            className={"btn sm" + (chasing === suggestion.card.tcgdexId ? " picked" : "")}
            aria-pressed={chasing === suggestion.card.tcgdexId}
            disabled={busy}
            onClick={() => pick({ kind: "chase", catalogCardId: suggestion.card.tcgdexId })}
          >
            Chase this
          </button>
        </div>
      ) : (
        <div className="lp-note">
          No printing in this line&apos;s colour. You can still pick one.
        </div>
      )}

      <div
        className="lp-choice"
        role="group"
        aria-label={`What goes in the ${stageLabel(stage.stage)} slot`}
      >
        <button
          type="button"
          className={
            "btn sm" + (chasing !== null && chasing !== suggestion?.card.tcgdexId ? " picked" : "")
          }
          aria-expanded={panel === "pick"}
          disabled={busy}
          onClick={() => toggle("pick")}
        >
          Pick another
        </button>
        <button
          type="button"
          className={"btn sm" + (value?.kind === "chase" && "newStandIn" in value ? " picked" : "")}
          aria-expanded={panel === "standin"}
          disabled={busy}
          onClick={() => toggle("standin")}
        >
          Can&apos;t find it? Make a placeholder card
        </button>
        <button
          type="button"
          className={"btn sm" + (value?.kind === "empty" ? " picked" : "")}
          aria-pressed={value?.kind === "empty"}
          disabled={busy}
          onClick={() => pick({ kind: "empty" })}
        >
          Leave empty
        </button>
        <button
          type="button"
          className={"btn sm" + (value?.kind === "filler" ? " picked" : "")}
          aria-expanded={panel === "filler"}
          disabled={busy}
          onClick={() => toggle("filler")}
        >
          Fill the pocket
        </button>
        {allowLater ? (
          <button
            type="button"
            className={"btn sm" + (value?.kind === "later" ? " picked" : "")}
            aria-pressed={value?.kind === "later"}
            disabled={busy}
            onClick={() => pick({ kind: "later" })}
          >
            Decide later
          </button>
        ) : null}
      </div>

      {panel === "pick" ? (
        options.loading ? (
          <div className="lp-note">Loading printings…</div>
        ) : options.error ? (
          <div className="lp-error" role="alert">
            {options.error}
          </div>
        ) : options.items && options.items.length === 0 ? (
          <div className="lp-note">No printing of this card in this line&apos;s language.</div>
        ) : options.items ? (
          <CardGrid
            label={`Printings for the ${stageLabel(stage.stage)} slot`}
            items={options.items}
            keyOf={(o) => o.card.tcgdexId}
            cardOf={(o) => o.card}
            tagOf={(o) =>
              [o.sameColour ? null : "Different colour", o.special ? "Special" : null]
                .filter(Boolean)
                .join(" · ") || null
            }
            selected={chasing}
            onPick={(o) => pick({ kind: "chase", catalogCardId: o.card.tcgdexId })}
            busy={busy}
          />
        ) : null
      ) : null}

      {panel === "standin" ? (
        <StandInFields
          stage={stage}
          lineLocale={lineLocale}
          initial={value?.kind === "chase" && "newStandIn" in value ? value.newStandIn : null}
          onSave={(d) => pick({ kind: "chase", newStandIn: d })}
          busy={busy}
        />
      ) : null}

      {panel === "filler" ? (
        <FillerPicker
          value={value?.kind === "filler" ? value.filler : null}
          onEnergy={() => pick({ kind: "filler", filler: { material: "energy" } })}
          onCard={(o) =>
            pick({ kind: "filler", filler: { material: "card", copyId: o.copyId, ...fromOf(o) } })
          }
          bulk={bulk}
          busy={busy}
          fillerFrom={fillerFrom}
        />
      ) : null}
    </section>
  );
}

/** A complete line shorter than 3 cards: what fills its third pocket (UIL-121 Q4). Nothing is chosen for her. */
export function ThirdPocketChoice({
  value,
  onChange,
  loadBulk,
  busy = false,
  fillerFrom = BULK_ONLY,
  allowLater = false,
}: {
  value: ThirdPocketValue | null;
  onChange(v: ThirdPocketValue): void;
  loadBulk(): Promise<FillerCardOption[]>;
  busy?: boolean;
  fillerFrom?: readonly FillerSource[];
  allowLater?: boolean;
}) {
  const bulk = useLoaded(loadBulk);
  return (
    <section className="lp-stagechoice" aria-label="The third pocket">
      <div className="lp-lbl u">
        Third pocket ·{" "}
        {!value
          ? "Choose"
          : value.material === "empty"
            ? "Left empty"
            : value.material === "later"
              ? "Decide later"
              : value.material === "energy"
                ? "A basic energy"
                : FILLER_WORDS[wordsKey(fillerFrom)].option}
      </div>
      <div className="lp-note">
        This line is complete with fewer than 3 cards, so its row has one pocket left.
      </div>
      <FillerPicker
        value={value && value.material !== "empty" && value.material !== "later" ? value : null}
        onEnergy={() => onChange({ material: "energy" })}
        onCard={(o) => onChange({ material: "card", copyId: o.copyId, ...fromOf(o) })}
        bulk={bulk}
        busy={busy}
        fillerFrom={fillerFrom}
      />
      <div className="lp-choice">
        <button
          type="button"
          className={"lp-opt" + (value?.material === "empty" ? " on picked" : "")}
          aria-pressed={value?.material === "empty"}
          disabled={busy}
          onClick={() => onChange({ material: "empty" })}
        >
          <b className="u">Leave it empty</b>
          <span>Nothing holds the pocket.</span>
        </button>
        {allowLater ? (
          <button
            type="button"
            className={"lp-opt" + (value?.material === "later" ? " on picked" : "")}
            aria-pressed={value?.material === "later"}
            disabled={busy}
            onClick={() => onChange({ material: "later" })}
          >
            <b className="u">Decide later</b>
            <span>It stays not decided; choose it on Lines.</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}
