/**
 * Card lookup — the show-floor decision set (dev-spec §5 M8; system-design §7C).
 *
 * "Where is my Charmeleon." One search field, one answer, above the fold on a phone. This module is
 * the PURE assembler: it takes what the DB knows about a looked-up printing (owned copies, open
 * wishlist gaps, lines, collections) and produces the ordered answer the screen renders —
 *
 *   • WHERE it lives: binder + half + colour band (never page/pocket — coarse location, §12).
 *   • the four show-floor facts: owned? · in / completes a line? · wishlisted? · in a collection?
 *
 * No I/O: the server action does the joins and calls this. That keeps the decision logic testable.
 */

/** Whether an owned copy sits shelved, in bulk, or is a repurposed block (system-design §4 Copy.role). */
export type CopyRole = "shelved" | "bulk" | "block";

/** One physical copy of the looked-up printing, with its resolved location labels. */
export interface LookupCopy {
  role: CopyRole;
  binderId: string | null;
  binderName: string | null;
  /** null for a specialty binder (single section) or an unshelved copy. */
  binderHalf: "front" | "back" | null;
  bandDisplay: string | null;
  lineSlotId: string | null;
}

/** A line whose gap this species+colour would fill, or the line a copy already sits in. */
export interface LookupLineRef {
  lineId: string;
  lineLabel: string;
  stage: string | null;
  /** Line lifecycle, for the "capped" / "terminated" caveat. */
  status: "open" | "capped" | "complete" | "terminated";
}

/** Whether the printing is chased on the wishlist right now. */
export interface LookupWishlistRef {
  wished: boolean;
  willLiveInSpecialty: boolean;
  /** e.g. "$24.10 · top target for the capped line". */
  detail: string | null;
}

/** The catalog printing that was looked up, trimmed to display fields. */
export interface LookupCardRef {
  tcgdexId: string;
  name: string;
  setName: string | null;
  localId: string | null;
  rarity: string | null;
  types: string[];
  stage: string | null;
  cardClass: "standard" | "specialty";
  imageUrl: string | null;
}

export interface LookupInput {
  card: LookupCardRef;
  bandKey: string;
  bandDisplay: string;
  /** Rainbow order (DB `color_band` keys) — drives the band stack, active one highlighted. */
  orderedBandKeys: readonly string[];
  /** Physical copies she owns of THIS printing (same catalog card). */
  copies: readonly LookupCopy[];
  /** The line one of her copies already sits in (a filled slot), if any. */
  ownedInLine: LookupLineRef | null;
  /** An OPEN placeholder in a line that this species+colour would fill, if any. */
  completesLine: LookupLineRef | null;
  wishlist: LookupWishlistRef;
  /** Collections whose target list claims this printing (system-design §3 collection claim). */
  collections: readonly { id: string; name: string }[];
}

export type FactTone = "y" | "n" | "hot";

export interface LookupFact {
  tone: FactTone;
  label: string;
  detail: string;
  /** Set when the fact links to a line (a "LINE ▶" jump target). */
  lineId?: string;
}

export interface LookupLocation {
  binderName: string;
  /** "FRONT HALF" | "BACK HALF" | "SPECIALTY" */
  half: string;
  bandDisplay: string | null;
}

export interface LookupAnswer {
  card: LookupCardRef;
  subtitle: string;
  bandKey: string;
  bandDisplay: string;
  /** Rainbow chips in order; the active band is flagged for the highlight. */
  bandStack: { key: string; active: boolean }[];
  owned: boolean;
  ownedCount: number;
  /** Where the best-shelved copy lives, or null when unowned / only in bulk. */
  location: LookupLocation | null;
  facts: LookupFact[];
}

/** rarity · type · stage — the one-line identity under the card name. */
function subtitleOf(card: LookupCardRef): string {
  return [card.rarity, card.types[0], card.stage].filter((s): s is string => !!s).join(" · ");
}

/** Pick the copy whose location we surface: a shelved copy wins over a block, block over bulk. */
function primaryCopy(copies: readonly LookupCopy[]): LookupCopy | null {
  const rank: Record<CopyRole, number> = { shelved: 0, block: 1, bulk: 2 };
  return [...copies].sort((a, b) => rank[a.role] - rank[b.role])[0] ?? null;
}

function halfLabel(copy: LookupCopy): string {
  if (copy.binderHalf === "front") return "FRONT HALF";
  if (copy.binderHalf === "back") return "BACK HALF";
  return "SPECIALTY";
}

/**
 * Assemble the lookup answer. Pure and total: every printing yields an answer, owned or not, and the
 * four facts are always present in a fixed order (line · wishlist · collection · duplicate).
 */
export function buildLookupAnswer(input: LookupInput): LookupAnswer {
  const { card, copies, collections } = input;
  const shelvedOrBlock = copies.filter((c) => c.role !== "bulk");
  const owned = copies.length > 0;
  const primary = primaryCopy(shelvedOrBlock);
  const location: LookupLocation | null =
    primary && primary.binderName
      ? {
          binderName: primary.binderName,
          half: halfLabel(primary),
          bandDisplay: primary.bandDisplay,
        }
      : null;

  const facts: LookupFact[] = [];

  // 1. Line — already in one, or would complete one.
  if (input.ownedInLine) {
    const l = input.ownedInLine;
    const statusTag =
      l.status === "capped" ? " · CAPPED" : l.status === "complete" ? " · COMPLETE" : "";
    facts.push({
      tone: "y",
      label: "IN A LINE",
      detail: `${l.lineLabel}${l.stage ? ` · ${l.stage}` : ""}${statusTag}`,
      lineId: l.lineId,
    });
  } else if (input.completesLine) {
    const l = input.completesLine;
    facts.push({
      tone: "hot",
      label: "WOULD COMPLETE A LINE",
      detail: `${l.lineLabel} needs this ${input.card.stage ?? "stage"}.`,
      lineId: l.lineId,
    });
  } else {
    facts.push({
      tone: "n",
      label: "NO LINE",
      detail: owned ? "Not shelved in a line." : "No line waits on this printing.",
    });
  }

  // 2. Wishlist.
  if (input.wishlist.wished) {
    facts.push({
      tone: "hot",
      label: "WISHLISTED",
      detail:
        input.wishlist.detail ??
        (input.wishlist.willLiveInSpecialty ? "Would go to the specialty binder." : "On the hunt."),
    });
  } else {
    facts.push({
      tone: "n",
      label: "NOT WISHLISTED",
      detail: owned ? "You own it." : "Nothing open needs it.",
    });
  }

  // 3. Collection.
  if (collections.length > 0) {
    facts.push({
      tone: "y",
      label: collections.length > 1 ? "IN COLLECTIONS" : "IN A COLLECTION",
      detail: collections.map((c) => c.name).join(" · "),
    });
  } else {
    facts.push({ tone: "n", label: "NO COLLECTION", detail: "Not claimed." });
  }

  // 4. Duplicate nuance.
  if (owned) {
    const bulkCount = copies.filter((c) => c.role === "bulk").length;
    if (bulkCount > 0) {
      facts.push({
        tone: "y",
        label: "DUPLICATES",
        detail: `${bulkCount} copy${bulkCount === 1 ? "" : "ies"} in the bulk box. Different art still counts as its own card.`,
      });
    } else {
      facts.push({
        tone: "n",
        label: "DUPLICATES",
        detail: "No duplicate in bulk. A different printing would still be kept.",
      });
    }
  }

  return {
    card,
    subtitle: subtitleOf(card),
    bandKey: input.bandKey,
    bandDisplay: input.bandDisplay,
    bandStack: input.orderedBandKeys.map((key) => ({ key, active: key === input.bandKey })),
    owned,
    ownedCount: copies.length,
    location,
    facts,
  };
}
