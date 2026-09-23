"use client";

/**
 * The reusable placement-override panel (dev-spec §5 M7; design/prototype.html `ovrBlock`/move
 * overlay). Any owned/shelved card can be moved to a binder + half + band, into a collection in a
 * specialty binder, or to the Bulk Box ("don't shelf"). No rule applies here — it is her call
 * (system-design §12 coarse location).
 *
 * Self-contained: it owns the draft destination (seeded from the card's current home) and calls
 * `onConfirm` with the chosen `MoveDestination`. Reused by the line strip, the plan spotlight, and
 * (later) lookup — anywhere a card shows. Presentational + local state only; the write is a server
 * action the host passes down.
 *
 * `allowLineJoin` (UIL-056, opt-in, default off; UIL-064 reshaped the flow; UIL-068 un-nested it): the
 * back half IS the lines area, so a back-half destination resolves to a line — an existing one's open
 * slot, or a new one. Off by default so the plan spotlight and Collections' existing usage are
 * untouched; only the Line screen turns it on. When it is on, "JOIN A LINE" (flat across every band,
 * `joinCandidates` computed server-side, each candidate carrying its own binder + band so picking one
 * derives the whole destination) and the plain binder/half/band/collection/bulk controls are BOTH
 * always on screen — UIL-064 fixed "too many picks; it should ask for the line" by making the line
 * question first; UIL-068 is her follow-up that the manual controls it then hid behind a
 * click-to-reveal went too far the other way ("I should have the option to move the card anywhere").
 * Order, not visibility, is what varies: the line section leads when there's a candidate or an open
 * "start new" to offer, and drops behind the manual controls when there is nothing to join — leading
 * with an unanswerable line question is the same friction from the other direction.
 *
 * UIL-072 (her ruling): the back half is the one option of the four that the server refuses unless a
 * line is picked (UIL-056's invariant, which stays), so it must not LOOK like an enabled peer of front
 * half / collection / bulk. While no line is picked the BACK HALF chip is disabled with the reason and
 * the remedy inline. The disabled state is derived from `isMoveDestinationComplete` — the same
 * predicate `applyMove` throws on — so the chip and the refusal cannot drift apart.
 */

import { useState } from "react";
import type {
  BlockNeedCandidate,
  ExistingLineBlock,
  LineJoinCandidate,
  LineJoinChoice,
  MoveDestination,
  MoveOptions,
} from "@/lib/line/types";
import { defaultMoveHalf, isMoveDestinationComplete } from "@/lib/line/move";
import type { Locale } from "@/lib/sync/types";
import { lineKey } from "@/lib/line/join-options";
import { bandMeta } from "./plan-meta";

const BULK = "__bulk__";

export function MovePanel({
  options,
  initial,
  confirmLabel = "Place it here ▶",
  allowLineJoin = false,
  joinCandidates,
  existingLineByBinderBand,
  naturalBandKey,
  cardLocale,
  blockNeeds,
  onConfirm,
}: {
  options: MoveOptions;
  initial?: MoveDestination;
  confirmLabel?: string;
  allowLineJoin?: boolean;
  /** Flat across every band (UIL-064) — present (even empty) turns the line-first flow on. */
  joinCandidates?: LineJoinCandidate[];
  /**
   * Every line this family already has, keyed by BINDER AND BAND (UIL-084) — the same key the server
   * refuses a duplicate on. Band-keyed before, which could not answer the question that actually
   * decides the write: does the binder SHE has picked already have one.
   */
  existingLineByBinderBand?: Record<string, ExistingLineBlock>;
  /** This card's own type-derived band — the default for "start a new line"'s one remaining pick
   *  (UIL-064): the app's own answer, not ten empty chips. */
  naturalBandKey?: string;
  /**
   * This card's regional variant (UIL-090). The blocking lookup is keyed by it, so a Japanese line in
   * the destination binder and band does not block an English card — they are different lines.
   */
  cardLocale?: Locale;
  /**
   * UIL-030: open binder-block needs this card could fill. Present (non-empty) ONLY when the engine
   * offered the card as a repurposed block — the Plan spotlight passes them, Lines and Lookup never do,
   * so those surfaces are unchanged. When present the section leads: it is the reason she opened the
   * sheet.
   */
  blockNeeds?: BlockNeedCandidate[];
  onConfirm: (dest: MoveDestination) => void;
}) {
  const firstGeneral = options.binders.find((b) => b.type === "general");
  const [binderId, setBinderId] = useState<string>(() => {
    if (initial?.kind === "bulk") return BULK;
    if (initial && "binderId" in initial) return initial.binderId;
    return firstGeneral?.id ?? options.binders[0]?.id ?? BULK;
  });
  const [half, setHalf] = useState<"front" | "back">(() => defaultMoveHalf(initial, allowLineJoin));
  const [band, setBand] = useState<string | null>(() => {
    if (initial?.kind === "shelf") return initial.band;
    return naturalBandKey ?? null;
  });
  const [collectionId, setCollectionId] = useState<string | null>(
    initial?.kind === "collection" ? initial.collectionId : null,
  );
  const [lineJoin, setLineJoin] = useState<LineJoinChoice | undefined>(
    initial?.kind === "shelf" ? initial.lineJoin : undefined,
  );

  /** UIL-030: the block need she picked (by slot id). A manual binder/bulk pick clears it. */
  const [blockPick, setBlockPick] = useState<string | null>(null);
  const blockNeed = (blockNeeds ?? []).find((n) => n.slotId === blockPick) ?? null;

  const isBulk = binderId === BULK;
  const binder = options.binders.find((b) => b.id === binderId);
  const isSpecialty = binder?.type === "specialty";
  const collections = binder ? (options.collectionsByBinder[binder.id] ?? []) : [];
  /**
   * The line already occupying the destination she has picked (UIL-084). Looked up by BINDER AND BAND
   * through the shared `lineKey`, so this is the same question `applyMove` answers — a line in another
   * binder is no longer treated as blocking, which is the whole of her report.
   */
  const blockingLine =
    allowLineJoin && band && !isBulk && binder?.type === "general"
      ? existingLineByBinderBand?.[lineKey(binder.id, band, cardLocale ?? "en")]
      : undefined;
  /**
   * She has asked to START a line where one already lives. The server refuses this, so Confirm does
   * too — a client that offered it would be recommending the one action that cannot succeed, which is
   * exactly the dead end UIL-084 reported. The remedies are on screen: join its open slot if it has
   * one, pick another binder, or use the front half.
   */
  const newLineBlocked = half === "back" && lineJoin?.mode === "new" && blockingLine != null;

  const destination: MoveDestination = blockNeed
    ? {
        kind: "block",
        lineId: blockNeed.lineId,
        slotId: blockNeed.slotId,
        binderId: blockNeed.binderId,
      }
    : isBulk
      ? { kind: "bulk" }
      : isSpecialty
        ? { kind: "collection", binderId: binder!.id, collectionId: collectionId ?? "" }
        : {
            kind: "shelf",
            binderId: binder?.id ?? "",
            half,
            band: band ?? "",
            ...(half === "back" && allowLineJoin ? { lineJoin } : {}),
          };

  const canConfirm = isMoveDestinationComplete(destination) && !newLineBlocked;

  const hasCandidates = (joinCandidates ?? []).length > 0;

  /**
   * Would a back-half shelf be accepted with the line choice as it stands? Probed through the SAME
   * predicate `applyMove` refuses on, with stand-in binder/band ids so the answer isolates the line
   * condition rather than a band she simply has not picked yet (front half would be equally
   * incomplete without a band, and it is not greyed). If UIL-056's invariant is ever relaxed in
   * lib/line/move.ts, this chip enables itself the same day — nothing here restates the rule.
   */
  const backHalfNeedsLine = !isMoveDestinationComplete({
    kind: "shelf",
    binderId: "probe",
    half: "back",
    band: "probe",
    ...(allowLineJoin ? { lineJoin } : {}),
  });
  // Her words for the condition; the remedy names where the line picker is on THIS panel (the
  // section order flips when there is nothing to join — see the render below) or, where the panel has
  // no picker at all (plan spotlight, Collections), the screen that does.
  const backHalfReason = allowLineJoin
    ? `The back half holds lines. Pick a line ${hasCandidates ? "above" : "below"} to enable. Or choose the front half, a collection, or bulk.`
    : "The back half holds lines. Move it from the Lines page to pick one. Or choose the front half, a collection, or bulk.";

  function summary(): string {
    if (blockNeed) {
      return `BINDER BLOCK · ${blockNeed.speciesLabel} · ${blockNeed.binderName.toUpperCase()} BACK`;
    }
    if (isBulk) return "BULK BOX · NOT SHELVED";
    if (isSpecialty) {
      const c = collections.find((x) => x.id === collectionId);
      return `${binder?.name ?? "BINDER"} · ${c ? c.name.toUpperCase() : "PICK A COLLECTION"}`;
    }
    const bandLabel = band ? bandMeta(band).display.toUpperCase() : "PICK A BAND";
    const joinLabel =
      half === "back" && allowLineJoin
        ? lineJoin?.mode === "new"
          ? " · NEW LINE"
          : lineJoin?.mode === "existing"
            ? ` · ${(joinCandidates ?? []).find((c) => c.slotId === lineJoin.slotId)?.speciesLabel ?? "LINE"}`
            : " · PICK A LINE"
        : "";
    return `${binder?.name ?? "BINDER"} · ${half.toUpperCase()} HALF · ${bandLabel}${joinLabel}`;
  }

  /**
   * UIL-030 — the offer the engine made ("Offered as a repurposed binder block") finally has an action.
   * Each chip is an OPEN need: a line whose block slot has no physical block yet. Picking one makes the
   * card that block, in that line's binder back half, and the need closes on confirm.
   */
  const blockSection =
    (blockNeeds ?? []).length > 0 ? (
      <div className="orow">
        <div className="ol">USE AS A BINDER BLOCK · FILLS A RESERVED POCKET</div>
        <div className="ochips">
          {(blockNeeds ?? []).map((n) => (
            <button
              key={n.slotId}
              type="button"
              className={"ochip" + (blockPick === n.slotId ? " on" : "")}
              aria-pressed={blockPick === n.slotId}
              onClick={() => setBlockPick(n.slotId)}
              title={`${n.speciesLabel} · ${n.stage} slot · ${n.binderName} back half`}
            >
              {n.speciesLabel} · {n.stage} · {n.binderName}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  const manualBody = (
    <>
      <div className="orow">
        <div className="ol">BINDER</div>
        <div className="ochips">
          {options.binders.map((b) => (
            <button
              key={b.id}
              type="button"
              className={
                "ochip" + (b.type === "specialty" ? " spec" : "") + (binderId === b.id ? " on" : "")
              }
              aria-pressed={binderId === b.id}
              onClick={() => {
                setBlockPick(null);
                setBinderId(b.id);
                setLineJoin(undefined); // a manually forced binder may no longer match the line's own
                if (b.type !== "specialty") setCollectionId(null);
              }}
            >
              {b.name}
            </button>
          ))}
          <button
            type="button"
            className={"ochip bulk" + (isBulk ? " on" : "")}
            aria-pressed={isBulk}
            onClick={() => {
              setBlockPick(null);
              setBinderId(BULK);
              setLineJoin(undefined);
            }}
          >
            ▤ Bulk box · don&apos;t shelf
          </button>
        </div>
      </div>

      {isBulk ? (
        <div className="orow">
          <div className="ol" />
          <div className="ochips">
            <span className="oskip">
              Bulk box has no internal structure: no binder, no half, no band. It stays in the pile
              until you place it.
            </span>
          </div>
        </div>
      ) : isSpecialty ? (
        <div className="orow">
          <div className="ol">COLLECTION IN {binder?.name?.toUpperCase()}</div>
          <div className="ochips">
            {collections.length === 0 ? (
              <span className="oskip">
                No collection lives in this binder yet. Create one on the Collections screen.
              </span>
            ) : (
              collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"ochip" + (collectionId === c.id ? " on" : "")}
                  aria-pressed={collectionId === c.id}
                  onClick={() => setCollectionId(c.id)}
                >
                  {c.name}
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="orow">
            <div className="ol">HALF</div>
            <div className="ochips">
              {(["front", "back"] as const).map((h) => {
                const dead = h === "back" && backHalfNeedsLine;
                return (
                  <button
                    key={h}
                    type="button"
                    className={"ochip" + (half === h ? " on" : "")}
                    aria-pressed={half === h}
                    disabled={dead}
                    title={dead ? backHalfReason : undefined}
                    onClick={() => {
                      setHalf(h);
                      setLineJoin(undefined);
                    }}
                  >
                    {h.toUpperCase()} HALF
                  </button>
                );
              })}
              {backHalfNeedsLine ? <span className="oskip">{backHalfReason}</span> : null}
            </div>
          </div>
          <div className="orow">
            <div className="ol">COLOR BAND · RAINBOW ORDER</div>
            <div className="ochips">
              {options.bands.map((b) => {
                const m = bandMeta(b.key);
                return (
                  <button
                    key={b.key}
                    type="button"
                    className={"ochip" + (band === b.key ? " on" : "")}
                    aria-pressed={band === b.key}
                    onClick={() => {
                      setBand(b.key);
                      setLineJoin(undefined);
                    }}
                  >
                    <span
                      className={"sw" + (m.dither ? " dither" : "")}
                      style={{ background: m.color }}
                    />
                    {b.display}
                    {b.key === "pink" ? <span className="rt">RSV</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          {/* UIL-068: back-half-needs-a-line stays a real requirement (UIL-056's server-side
              invariant, unchanged here) — but it is no longer the reason the rest of this section is
              hard to reach. The "needs a line" half of the old hint now lives on the greyed BACK HALF
              chip itself (UIL-072); what remains here is the confirmation once a line IS picked. */}
          {half === "back" && allowLineJoin && lineJoin ? (
            <div className="orow">
              <div className="ol" />
              <div className="ochips">
                <span className="oskip">
                  Line picked {hasCandidates ? "above" : "below"} — change it there, or pick Bulk /
                  a Collection / the front half here.
                </span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );

  /** "JOIN A LINE" — the candidate list + "start a new line", unchanged content (UIL-068 only
   *  changes WHERE this renders relative to `manualBody`, never gates it behind a click). */
  const joinLineSection = (
    <>
      <div className="orow">
        <div className="ol">JOIN A LINE</div>
        <div className="ochips">
          {(joinCandidates ?? []).map((c) => {
            const on =
              lineJoin?.mode === "existing" &&
              lineJoin.lineId === c.lineId &&
              lineJoin.slotId === c.slotId;
            const m = bandMeta(c.bandKey);
            return (
              <button
                key={c.slotId}
                type="button"
                className={"ochip" + (on ? " on" : "")}
                aria-pressed={on}
                onClick={() => {
                  setLineJoin({ mode: "existing", lineId: c.lineId, slotId: c.slotId });
                  setBinderId(c.binderId ?? firstGeneral?.id ?? options.binders[0]?.id ?? BULK);
                  setHalf("back");
                  setBand(c.bandKey);
                }}
              >
                <span
                  className={"sw" + (m.dither ? " dither" : "")}
                  style={{ background: m.color }}
                />
                {c.speciesLabel} · {m.display} · {c.filledCount}/{c.totalCount} FILLED ·{" "}
                {c.stage.toUpperCase()} SLOT
              </button>
            );
          })}
          <button
            type="button"
            className={"ochip" + (lineJoin?.mode === "new" ? " on" : "")}
            aria-pressed={lineJoin?.mode === "new"}
            onClick={() => {
              setLineJoin({ mode: "new" });
              setHalf("back");
              setBand(naturalBandKey ?? options.bands[0]?.key ?? null);
            }}
          >
            + Start a new line{binder && !isBulk ? ` in ${binder.name}` : ""}
          </button>
        </div>
      </div>

      {lineJoin?.mode === "new" ? (
        <div className="orow">
          <div className="ol">COLOR BAND · RAINBOW ORDER</div>
          <div className="ochips">
            {options.bands.map((b) => {
              const m = bandMeta(b.key);
              return (
                <button
                  key={b.key}
                  type="button"
                  className={"ochip" + (band === b.key ? " on" : "")}
                  aria-pressed={band === b.key}
                  onClick={() => setBand(b.key)}
                >
                  <span
                    className={"sw" + (m.dither ? " dither" : "")}
                    style={{ background: m.color }}
                  />
                  {b.display}
                  {b.key === "pink" ? <span className="rt">RSV</span> : null}
                </button>
              );
            })}
          </div>
          {blockingLine ? (
            /* UIL-084: this used to say the opposite of what happens — "this one starts its own line
               instead" — for a placement the server always refused. It now names the condition and the
               remedies that exist. A line in ANOTHER binder is not blocking and says nothing here. */
            <div className="oskip" style={{ marginTop: 6 }}>
              {binder?.name ?? "This binder"} already has {blockingLine.speciesLabel} in this band (
              {blockingLine.filledCount}/{blockingLine.totalCount} filled), and one binder tracks a
              species once per band — so a second line here cannot be saved. Join its open slot
              above if it has one, pick a different binder, or use the front half.
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="ovr">
      <div className="ohead">
        <span>MANUAL PLACEMENT · YOUR CALL</span>
        <span className="yc">NO RULE</span>
      </div>
      <div className="obody">
        {blockSection ? (
          <>
            {blockSection}
            <div className="orow" style={{ marginTop: 4 }}>
              <div className="ol">OR PLACE IT MANUALLY</div>
            </div>
          </>
        ) : null}
        {/*
          UIL-068, her report on the shipped UIL-064 rework: collapsing binder/half/band/collection/
          bulk behind "place it manually" made the plain "put this card where I say" case harder to
          reach than joining a line, not just secondary to it — with no candidates (her Pikachu case)
          "+ Start a new line" was the ONLY visible action. Both are now always on screen; nothing here
          is a click-to-reveal. Order is the one thing that still varies: when there IS a line to join
          or start toward, that's the likely intent and leads; when there is nothing to join, leading
          with a line question she cannot usefully answer is exactly the friction she reported, so the
          manual controls come first instead and the line section becomes the quieter, second option.
        */}
        {allowLineJoin ? (
          hasCandidates ? (
            <>
              {joinLineSection}
              <div className="orow" style={{ marginTop: 4 }}>
                <div className="ol">OR PLACE IT MANUALLY</div>
              </div>
              {manualBody}
            </>
          ) : (
            <>
              {manualBody}
              <div className="orow" style={{ marginTop: 4 }}>
                <div className="ol">OR JOIN A LINE</div>
              </div>
              {joinLineSection}
            </>
          )
        ) : (
          manualBody
        )}

        <div className="osum">
          PLACING · <b>{summary()}</b>
        </div>
        <button
          type="button"
          className="oconfirm"
          disabled={!canConfirm}
          onClick={() => canConfirm && onConfirm(destination)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
