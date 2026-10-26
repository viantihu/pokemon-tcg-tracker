"use client";

import { useState } from "react";
import {
  isLanguage,
  knownDexLocale,
  languageName,
  languageOfId,
  TCGDEX_LANGUAGES,
  type Language,
} from "@/lib/catalog/locale";
import type { StandInFormInput } from "../sync/sync-types";
import type { QueueEntryView } from "../sync/sync-types";

/**
 * What the form needs from the card's Dex row to prefill itself. The Sync page hands it a queue entry; the Haul Plan's
 * "Wrong card?" hands it the card's own name and language, since the copy has no unmatched row of its own.
 */
export type StandInPrefill = Pick<
  QueueEntryView,
  "dexName" | "dexSetName" | "dexNumber" | "locale"
> & {
  /** The language the card is known to be printed in, when the caller knows it better than a Dex locale string does. */
  language?: Language | null;
};

/** What a stand-in action answers: made (and matched), a twin to match instead, or a plain failure. */
export type StandInFormOutcome =
  | { ok: true }
  | {
      ok: false;
      twin: { tcgdexId: string; name: string; setName: string | null; localId: string | null };
      error: string;
    }
  | { ok: false; error: string };

const STAGES = ["Basic", "Stage1", "Stage2"] as const;

/**
 * UIL-060 Half 1 — "the catalog and the match are not always correct, so a manual override is
 * necessary." When the real card is not in the catalog, she creates a STAND-IN of her own and the
 * entry is matched to it in the same transaction (lib/sync/exec.ts `manualMatchStandIn`).
 *
 * Prefilled from what the export already carries — name, set name, collector number — and the set id
 * is derived server-side, never typed. The ONE thing the export cannot supply is what kind of card it
 * is: a Pokémon needs its type and stage or the engine bands it White as a Trainer, so that choice is
 * required. A twin (a stand-in she already made for this card) is refused with the existing one offered
 * to match instead: the condition named, the remedy beside it.
 */
export function StandInForm({
  entry,
  cardTypes,
  onStandIn,
  onPicked,
  matchLabel = "match",
}: {
  entry: StandInPrefill;
  cardTypes: string[];
  onStandIn: (input: StandInFormInput) => Promise<StandInFormOutcome>;
  onPicked: (tcgdexId: string) => void;
  /** The verb the form's buttons use for the last step: the Sync page matches an entry, the Haul Plan rematches a card. */
  matchLabel?: "match" | "rematch";
}) {
  const [name, setName] = useState(entry.dexName || "");
  const [setLabel, setSetLabel] = useState(entry.dexSetName || "");
  const [localId, setLocalId] = useState(entry.dexNumber || "");
  // UIL-108: pre-filled from the Dex row's Locale ("International" is English, "Japanese" is Japanese);
  // anything Dex writes that we do not recognise pre-fills nothing, so she picks rather than we guess.
  const [language, setLanguage] = useState<Language | "">(
    entry.language ?? knownDexLocale(entry.locale) ?? "",
  );
  const [kind, setKind] = useState<"pokemon" | "trainer" | "energy">("pokemon");
  const [type, setType] = useState<string>("");
  const [stage, setStage] = useState<(typeof STAGES)[number]>("Basic");
  const [dexId, setDexId] = useState("");
  const [busy, setBusy] = useState(false);
  const [twin, setTwin] = useState<Extract<StandInFormOutcome, { twin: unknown }>["twin"] | null>(
    null,
  );
  const [failed, setFailed] = useState<string | null>(null);

  const twinLanguage = twin ? languageOfId(twin.tcgdexId) : null;
  const canSubmit =
    name.trim().length > 0 &&
    isLanguage(language) &&
    (kind !== "pokemon" || type.length > 0) &&
    !busy;

  async function submit() {
    if (!canSubmit || !isLanguage(language)) return;
    setBusy(true);
    setFailed(null);
    setTwin(null);
    const dex = Number.parseInt(dexId, 10);
    const input: StandInFormInput = {
      name: name.trim(),
      setName: setLabel.trim() || null,
      localId: localId.trim() || null,
      language,
      kind:
        kind === "pokemon"
          ? { kind: "pokemon", type, stage, dexId: Number.isFinite(dex) && dex > 0 ? dex : null }
          : { kind },
    };
    const r = await onStandIn(input);
    setBusy(false);
    if (r.ok) return;
    if ("twin" in r) setTwin(r.twin);
    else setFailed(r.error);
  }

  return (
    <details className="standin">
      <summary className="u" style={{ cursor: "pointer", fontSize: 11 }}>
        Not in the catalog? Create a stand-in and {matchLabel} to it
      </summary>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        <p style={{ fontSize: 11, color: "var(--ink-2)", margin: 0 }}>
          A stand-in is your own record for a card the catalog does not have yet. It can be placed
          today, and it is marked so it can be swapped for the real record later.
        </p>
        <label className="orow">
          <div className="ol u">Name</div>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
          <label className="orow">
            <div className="ol u">Set</div>
            <input
              className="field"
              value={setLabel}
              onChange={(e) => setSetLabel(e.target.value)}
            />
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
        <label className="orow">
          <div className="ol u">Language</div>
          <select
            className="field"
            value={language}
            onChange={(e) => setLanguage(isLanguage(e.target.value) ? e.target.value : "")}
            aria-label="Language"
          >
            <option value="">Pick the language it is printed in…</option>
            {TCGDEX_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="orow">
          <div className="ol u">What kind of card</div>
          <div className="modetoggle" role="group" aria-label="Card kind">
            {(["pokemon", "trainer", "energy"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={"modebtn u" + (kind === k ? " on" : "")}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "pokemon" ? "Pokémon" : k === "trainer" ? "Trainer" : "Energy"}
              </button>
            ))}
          </div>
        </div>
        {kind === "pokemon" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10 }}>
            <label className="orow">
              <div className="ol u">Type</div>
              <select
                className="field"
                value={type}
                onChange={(e) => setType(e.target.value)}
                aria-label="Type"
              >
                <option value="">Pick a type…</option>
                {cardTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="orow">
              <div className="ol u">Stage</div>
              <select
                className="field"
                value={stage}
                onChange={(e) => setStage(e.target.value as (typeof STAGES)[number])}
                aria-label="Stage"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="orow">
              <div className="ol u">Pokédex # (optional)</div>
              <input
                className="field"
                style={{ width: 90 }}
                inputMode="numeric"
                value={dexId}
                onChange={(e) => setDexId(e.target.value)}
                aria-label="Pokédex number"
              />
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 11, color: "var(--ink-2)", margin: 0 }}>
            {kind === "trainer" ? "Trainers" : "Energy cards"} have no type or stage; the stand-in
            files with the white band.
          </p>
        )}
        {twin ? (
          <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
            <span>!</span>
            <b>
              A stand-in for &quot;{twin.name}&quot;
              {twin.setName ? ` in ${twin.setName}` : ""}
              {twin.localId ? ` · ${twin.localId}` : ""}
              {twinLanguage ? ` (${languageName(twinLanguage)})` : ""} already exists.
            </b>
            <button
              type="button"
              className="btn sm"
              style={{ marginLeft: "auto" }}
              onClick={() => onPicked(twin.tcgdexId)}
            >
              {matchLabel === "rematch" ? "Rematch" : "Match"} to the existing stand-in instead ▶
            </button>
          </div>
        ) : null}
        {failed ? (
          <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
            <span>!</span>
            <b>{failed}</b>
          </div>
        ) : null}
        <button type="button" className="oconfirm" disabled={!canSubmit} onClick={submit}>
          Create the stand-in and {matchLabel} ▶
        </button>
      </div>
    </details>
  );
}
