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
}

const cap = (s: string) => s.toUpperCase();

/** Prefer the root's species name; fall back to the first named slot. */
function speciesLabel(slots: SlotInput[]): string {
  const named = slots.find((s) => s.card?.name)?.card?.name;
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
  };
}

/** The two info boxes under the strip (design/rationale §7 — line detail earns the most copy). */
function infoBoxes(input: LineViewInput, slots: SlotView[]): LineInfoBox[] {
  const specialtySlot = slots.find((s) => s.state === "placeholder" && s.willLiveInSpecialty);
  const blockSlot = slots.find((s) => s.state === "block");
  const openPlaceholder = slots.find((s) => s.state === "placeholder" && !s.willLiveInSpecialty);

  if (input.status === "capped" && specialtySlot) {
    const name = specialtySlot.card?.name ?? "the top stage";
    const price = fmtPrice(specialtySlot.priceMarket);
    return [
      { k: "CAPPED BECAUSE", v: `Every same-color ${cap(name)} in print is a specialty card.` },
      {
        k: "WISHLIST",
        v: `${cap(name)}${price ? ` · ${price}` : ""} · lives in the specialty binder.`,
      },
    ];
  }
  if (input.status === "terminated") {
    const survivor = slots.find((s) => s.state === "filled")?.card?.name;
    return [
      {
        k: "NO LINE BECAUSE",
        v: "A line needs two same-color members; a blocked stage leaves too few.",
      },
      {
        k: "WHERE IT GOES",
        v: survivor
          ? `${cap(survivor)} falls through to the front half.`
          : "Surviving card to the front half.",
      },
    ];
  }
  if (blockSlot) {
    const price = openPlaceholder ? fmtPrice(openPlaceholder.priceMarket) : null;
    return [
      { k: "ONE BLOCK, ONE HUNT", v: "Dead root, live top. Two different jobs on one page." },
      openPlaceholder
        ? {
            k: "WISHLIST",
            v: `${cap(openPlaceholder.card?.name ?? "the open stage")}${price ? ` · ${price}` : ""} closes this page.`,
          }
        : { k: "ROOT BLOCKED", v: "Nothing can ever fill it. Never wishlisted." },
    ];
  }
  if (openPlaceholder) {
    const price = fmtPrice(openPlaceholder.priceMarket);
    return [
      {
        k: "STILL OPEN",
        v: `${cap(openPlaceholder.card?.name ?? "a stage")} is a hunt, not owned yet.`,
      },
      {
        k: "WISHLIST",
        v: `${cap(openPlaceholder.card?.name ?? "target")}${price ? ` · ${price}` : ""}`,
      },
    ];
  }
  return [{ k: "COMPLETE", v: "Every stage is filled. This page is done." }];
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
  const capSlot = slots.find((s) => s.state === "placeholder" && s.willLiveInSpecialty);
  const capPlate =
    input.status === "capped" && capSlot
      ? {
          targetLabel: `${cap(capSlot.card?.name ?? "SPECIALTY CARD")} · SPECIALTY BINDER`,
          note: "This page never closes. That is correct, not an error.",
        }
      : null;

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
    cap: capPlate,
    info: infoBoxes(input, slots),
  };
}
