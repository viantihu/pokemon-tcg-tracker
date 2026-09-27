/**
 * Build the line-detail view-model (scr-line; dev-spec §5 M7; system-design §6, §8 screen 6).
 *
 * Pure: given a persisted line and its stage slots with their card identities already resolved,
 * produce the ordered strip (filled / placeholder / block), the line-level status object (cap plate
 * for a capped line), and the two info boxes. The strip is one horizontal line in evolution order —
 * no grid, no pocket, no page (coarse location, system-design §12). The design authority is the
 * three-object slot treatment in design/rationale.md §2.
 */

import type { LineStatus, SlotState } from "@/lib/engine";
import { LINE_ROW_POCKETS } from "./popup";
import type { AlternateView, CardIdentity, LineInfoBox, LineView, SlotView } from "./types";

/** One stage of the line with its card identity already resolved (I/O done upstream). */
export interface SlotInput {
  slotId: string;
  stageIndex: number;
  stage: string;
  state: SlotState;
  card: CardIdentity | null;
  copyId: string | null;
  variant: string | null;
  /** Filled copy is currently shelved (so it can be moved). */
  copyShelved: boolean;
  priceMarket: number | null;
  willLiveInSpecialty: boolean;
  alternates: AlternateView[];
  note: string | null;
  /** Block: the wedge card label, or null (a terminated line has no pocket to wedge into). */
  wedgeLabel: string | null;
  /** UIL-121: her choice for an open stage, or null (absent reads as null). */
  stageChoice?: "chase" | "empty" | "filler" | null;
  /** The species this stage stands for (its chain name), for the line's name when no card is shown on it. */
  speciesName?: string | null;
}

export interface LineViewInput {
  lineId: string;
  rootDexId: number;
  bandKey: string;
  binderId: string | null;
  binderLabel: string;
  status: LineStatus;
  /** Any block-species names keyed by dexId, so a block slot with no card still reads a name. */
  slots: SlotInput[];
  /** UIL-121: what she chose for the third pocket, or null. */
  extraPocket?: string | null;
}

const cap = (s: string) => s.toUpperCase();

/** Prefer the root's species name; fall back to the first named slot. */
function speciesLabel(slots: SlotInput[]): string {
  // The species a stage stands for (its chain name) before a card shown on it: since UIL-121 an open stage shows no
  // card until she chases one, and the line still has a name.
  const named =
    slots.find((s) => s.speciesName)?.speciesName ?? slots.find((s) => s.card?.name)?.card?.name;
  return named ? `${cap(named)} LINE` : "EVOLUTION LINE";
}

function toSlotView(s: SlotInput): SlotView {
  return {
    slotId: s.slotId,
    stageIndex: s.stageIndex,
    stage: s.stage,
    state: s.state,
    card: s.card,
    copyId: s.copyId,
    variant: s.variant,
    priceMarket: s.priceMarket,
    willLiveInSpecialty: s.willLiveInSpecialty,
    alternates: s.alternates,
    note: s.note,
    wedgeLabel: s.wedgeLabel,
    /**
     * Placement override applies to ANY owned card (memory-confirmed, dev-spec §5 M7).
     *
     * `copyShelved` used to be required here, which made the ONE control that can release a slot
     * unavailable for exactly the slots that are wrong (UIL-087): a slot reading `filled` whose copy was
     * never shelved offered no Move, the "not in a line yet" list excludes it (that list wants a shelved
     * copy with NO slot), and Lookup filters bulk copies out of the location it shows — so she had no
     * route to fix it from anywhere in the app. `applyMove` already releases the slot correctly for this
     * case (its positive-match guard holds), so widening this needs no new write path and makes the
     * always-movable rule true of the app's own mistakes too.
     */
    moveable: s.state === "filled" && Boolean(s.copyId),
    /** A filled slot whose card is not actually shelved — she needs to see WHICH rows are wrong. */
    copyNotShelved: s.state === "filled" && Boolean(s.copyId) && !s.copyShelved,
    stageChoice: s.stageChoice ?? null,
  };
}

/**
 * The two info boxes under the strip (design/rationale §7 — line detail earns the most copy), in her terms since
 * UIL-121: what she is chasing, what she has not decided yet, and whether anything is left. The old capped and
 * terminated boxes went with those statuses (nothing is capped or terminated for her any more).
 */
function infoBoxes(slots: SlotView[], thirdPocketOpen: boolean): LineInfoBox[] {
  const open = slots.filter((s) => s.state !== "filled");
  const chased = open.filter((s) => s.stageChoice === "chase");
  const undecided = open.filter((s) => s.stageChoice === null);
  const out: LineInfoBox[] = [];
  if (undecided.length > 0) {
    out.push({
      k: "NOT DECIDED",
      v: `${undecided.length === 1 ? "One stage waits" : `${undecided.length} stages wait`} for your choice. Tap Choose.`,
    });
  }
  if (chased.length > 0) {
    out.push({
      k: "CHASING",
      v: chased
        .map((s) => {
          const price = fmtPrice(s.priceMarket);
          return `${cap(s.card?.name ?? s.stage)}${price ? ` · ${price}` : ""}`;
        })
        .join(" · "),
    });
  }
  if (open.length === 0) {
    out.push(
      thirdPocketOpen
        ? { k: "COMPLETE", v: "Every stage is filled. Choose what fills the row's last pocket." }
        : { k: "COMPLETE", v: "Every stage is filled. This page is done." },
    );
  } else if (undecided.length === 0 && chased.length === 0) {
    out.push({ k: "CLOSED", v: "Nothing left to chase. Choose a stage again to chase it." });
  }
  return out.slice(0, 2);
}

export function fmtPrice(p: number | null | undefined): string | null {
  if (p === null || p === undefined || Number.isNaN(p)) return null;
  return `$${p.toFixed(2)}`;
}

/** Assemble the whole line view. */
export function buildLineView(input: LineViewInput): LineView {
  const ordered = [...input.slots].sort((a, b) => a.stageIndex - b.stageIndex);
  const slots = ordered.map(toSlotView);
  const counts = {
    filled: slots.filter((s) => s.state === "filled").length,
    placeholder: slots.filter((s) => s.state === "placeholder").length,
    block: slots.filter((s) => s.state === "block").length,
  };
  // UIL-121: a complete line shorter than three pockets whose third pocket she has not decided.
  const thirdPocketOpen =
    slots.length > 0 &&
    slots.length < LINE_ROW_POCKETS &&
    slots.every((sl) => sl.state === "filled") &&
    input.extraPocket == null;

  return {
    lineId: input.lineId,
    rootDexId: input.rootDexId,
    speciesLabel: speciesLabel(ordered),
    bandKey: input.bandKey,
    binderId: input.binderId,
    binderLabel: input.binderLabel,
    status: input.status,
    counts,
    slots,
    // UIL-121: the cap plate retired with the capped status (nothing is capped for her).
    cap: null,
    info: infoBoxes(slots, thirdPocketOpen),
    thirdPocketOpen,
  };
}
