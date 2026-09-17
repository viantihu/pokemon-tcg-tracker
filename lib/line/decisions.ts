/**
 * Decision cards — the confirm-or-override moments (dev-spec §5 M7; system-design §6, §7B step 4).
 *
 * Two pure halves:
 *   1. DERIVE — read a persisted line's state (its slots, status, catalog facts, collection claims)
 *      and surface the outstanding decisions as evidence-carrying cards: ex-only caps, orphan-root
 *      blocks, interior blocks, terminations, and collection-vs-line conflicts. The system PROPOSES
 *      (one choice is marked recommended); it NEVER auto-blocks (system-design §3, §6).
 *   2. RESOLVE — translate the chosen option into the exact repo writes (line status, slot state,
 *      wishlist, and the `PlacementDecision` audit row with `resolved_by: 'user'`).
 *
 * The engine (`lib/engine`) already applied the auto proposal at haul-commit (M6, `resolved_by:
 * 'auto'`). This layer records her confirmation, or overrides it. Holo-swap cards are supported by
 * the shared component + this type set (so M9 reuses them) but are surfaced at haul time, not
 * derived from persisted line state.
 */

import type { LineStatus, SlotState } from "@/lib/engine";
import type {
  CardIdentity,
  DecisionCard,
  DecisionChoice,
  DecisionChoiceId,
  DecisionWrites,
  EvidenceRow,
  WishlistOption,
} from "./types";
import { fmtPrice } from "./view";

/** Precomputed catalog facts for a stage's species (I/O upstream; kept pure here). */
export interface StageFacts {
  totalPrintings: number;
  sameBandTotal: number;
  sameBandStandard: number;
  sameBandSpecialty: number;
  /** A wrong-band printing that exists, e.g. "FIGHTING · pgo-82"; null if none. */
  otherBandExample: string | null;
  cheapestSameBand: number | null;
  /** The cheapest chosen target's printed id, for the "$x.xx · <id>" fact. */
  chosenLocalId: string | null;
}

export interface DecisionSlotInput {
  slotId: string;
  stageIndex: number;
  stage: string;
  state: SlotState;
  dexId: number | null;
  speciesName: string | null;
  card: CardIdentity | null;
  priceMarket: number | null;
  willLiveInSpecialty: boolean;
  /** Ranked cheaper-first alternate printings for the wishlist strip. */
  alternates: WishlistOption[];
  facts: StageFacts;
  /** Wishlist template fields (from the target card), so a resolution can (re)create the hunt. */
  requiredType: string | null;
}

export interface DecisionLineInput {
  lineId: string;
  rootDexId: number;
  bandKey: string;
  bandDisplay: string;
  status: LineStatus;
  binderLabel: string;
  slots: DecisionSlotInput[];
  /** dexIds claimed by a running collection (collection-vs-line detection). */
  claimedDexIds: Set<number>;
}

/** Server-side payload that lets a chosen option be turned into writes (never sent to the client). */
export interface DecisionResolution {
  kind: DecisionCard["kind"];
  lineId: string;
  status: LineStatus;
  /** The slot the decision acts on (cap/block/root-block/collection); null for termination. */
  slotId: string | null;
  stageIndex: number | null;
  requiredDexId: number | null;
  requiredType: string | null;
  requiredStage: string | null;
  chosenCatalogCardId: string | null;
  alternateCatalogCardIds: string[];
  willLiveInSpecialty: boolean;
  /** The other open placeholder in the line (root-block "no wishlist" resolves this too). */
  otherOpenSlotId: string | null;
}

export interface DerivedDecision {
  card: DecisionCard;
  resolution: DecisionResolution;
}

const cap = (s: string) => s.toUpperCase();

/** Owned/absent facts straight off the line's slots (filled = owned, else absent). */
function ownedEvidence(slots: DecisionSlotInput[]): EvidenceRow[] {
  return slots.map((s) => {
    const name = cap(s.speciesName ?? s.card?.name ?? s.stage);
    if (s.state === "filled") return { mark: "y", text: `${name} · owned` };
    if (s.state === "block") return { mark: "n", text: `${name} · no same-color printing` };
    return { mark: "n", text: `${name} · open` };
  });
}

function catalogEvidence(band: string, species: string, f: StageFacts): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    { mark: "s", text: `${cap(species)} printings: ${f.totalPrintings}` },
  ];
  rows.push({
    mark: f.sameBandStandard > 0 ? "y" : "n",
    text: `Standard ${band}: ${f.sameBandStandard}`,
  });
  if (f.sameBandSpecialty > 0) {
    rows.push({ mark: "s", text: `Specialty ${band}: ${f.sameBandSpecialty}` });
  }
  if (f.otherBandExample) rows.push({ mark: "s", text: `Other band · ${f.otherBandExample}` });
  if (f.cheapestSameBand !== null && f.chosenLocalId) {
    rows.push({ mark: "y", text: `Cheapest ${fmtPrice(f.cheapestSameBand)} · ${f.chosenLocalId}` });
  }
  return rows;
}

const leaveIt: DecisionChoice = {
  id: "leave-it",
  label: "Leave it",
  description: "Resurfaces next time. Nothing written.",
};

function baseResolution(
  line: DecisionLineInput,
  slot: DecisionSlotInput | null,
  kind: DecisionCard["kind"],
): DecisionResolution {
  const otherOpen = line.slots.find(
    (s) => s.state === "placeholder" && (!slot || s.slotId !== slot.slotId),
  );
  return {
    kind,
    lineId: line.lineId,
    status: line.status,
    slotId: slot?.slotId ?? null,
    stageIndex: slot?.stageIndex ?? null,
    requiredDexId: slot?.dexId ?? null,
    requiredType: slot?.requiredType ?? null,
    requiredStage: slot?.stage ?? null,
    chosenCatalogCardId: slot?.card?.tcgdexId ?? null,
    alternateCatalogCardIds: slot?.alternates.map((a) => a.tcgdexId) ?? [],
    willLiveInSpecialty: slot?.willLiveInSpecialty ?? false,
    otherOpenSlotId: otherOpen?.slotId ?? null,
  };
}

/** Derive every outstanding decision for one persisted line. */
export function deriveDecisions(line: DecisionLineInput): DerivedDecision[] {
  const out: DerivedDecision[] = [];
  const ordered = [...line.slots].sort((a, b) => a.stageIndex - b.stageIndex);
  const band = line.bandDisplay;

  // TERMINATION — the whole line was killed (one member left, no page).
  if (line.status === "terminated") {
    const blockSlot = ordered.find((s) => s.state === "block");
    const survivor = ordered.find((s) => s.state === "filled");
    const species = blockSlot?.speciesName ?? blockSlot?.card?.name ?? "the root";
    out.push({
      card: {
        id: `${line.lineId}:termination`,
        kind: "termination",
        lineId: line.lineId,
        slotStageIndex: null,
        title: "NO LINE · TOO FEW SAME-COLOR MEMBERS",
        question: `NO ${band.toUpperCase()} ${cap(species)} EXISTS. SO NO LINE?`,
        card: survivor?.card ?? blockSlot?.card ?? null,
        catalog: blockSlot ? catalogEvidence(band, species, blockSlot.facts) : [],
        owned: ownedEvidence(ordered),
        why: [
          "A line needs two same-color members. This chain can only reach one.",
          "One chain, one color — a wrong-band copy cannot sit in this line.",
        ],
        proposal: survivor?.card
          ? `NO LINE · ${cap(survivor.card.name)} TO THE FRONT HALF`
          : "NO LINE · SURVIVING CARD TO THE FRONT HALF",
        wishlist: [],
        choices: [
          {
            id: "confirm-termination",
            label: "No line, front half",
            description: "The surviving card shelves with the basics.",
            recommended: true,
          },
          {
            id: "make-line-anyway",
            label: "Make the line anyway",
            description: "A page with one card and one block.",
          },
          leaveIt,
        ],
      },
      resolution: baseResolution(line, blockSlot ?? null, "termination"),
    });
    return out; // a terminated line has no other outstanding decisions.
  }

  for (const slot of ordered) {
    const species = slot.speciesName ?? slot.card?.name ?? slot.stage;
    const claimed = slot.dexId !== null && line.claimedDexIds.has(slot.dexId);

    // EX-ONLY CAP — an open stage whose only same-color printings are specialty class.
    if (slot.state === "placeholder" && slot.willLiveInSpecialty) {
      out.push({
        card: {
          id: `${line.lineId}:ex-only-cap:${slot.stageIndex}`,
          kind: "ex-only-cap",
          lineId: line.lineId,
          slotStageIndex: slot.stageIndex,
          title: "LINE CAP · EX-ONLY COMPLETION",
          question: `NO STANDARD ${band.toUpperCase()} ${cap(species)} EXISTS. CAP THE LINE?`,
          card: slot.card,
          catalog: catalogEvidence(band, species, slot.facts),
          owned: ownedEvidence(ordered),
          why: [
            "A specialty-class next stage means CAP, not COMPLETE.",
            "The page never closes. That is correct, not an error.",
          ],
          proposal: `PLACEHOLDER + WISHLIST ${cap(species)}${
            slot.priceMarket ? ` ${fmtPrice(slot.priceMarket)}` : ""
          } · TAG SPECIALTY · LINE CAPPED`,
          wishlist: slot.card ? slot.alternates : [],
          choices: [
            {
              id: "confirm-cap",
              label: "Confirm the cap",
              description: "Placeholder + wishlist to the specialty binder; line capped.",
              recommended: true,
            },
            {
              id: "cap-no-wishlist",
              label: "Cap, no wishlist",
              description: "Placeholder with no target.",
            },
            {
              id: "block-instead",
              label: "Block it instead",
              description: "Wedge a duplicate. Never chase the ex.",
            },
            leaveIt,
          ],
        },
        resolution: baseResolution(line, slot, "ex-only-cap"),
      });
      continue;
    }

    // COLLECTION vs LINE — an open stage whose species a collection has claimed.
    if (slot.state === "placeholder" && claimed) {
      out.push({
        card: {
          id: `${line.lineId}:collection-vs-line:${slot.stageIndex}`,
          kind: "collection-vs-line",
          lineId: line.lineId,
          slotStageIndex: slot.stageIndex,
          title: "COLLECTION CLAIM vs LINE SLOT",
          question: `THIS IS THE CARD THE LINE NEEDS. COLLECTION STILL WINS?`,
          card: slot.card,
          catalog: catalogEvidence(band, species, slot.facts),
          owned: [
            { mark: "s", text: "Claimed copy lives in a running collection" },
            ...ownedEvidence(ordered),
          ],
          why: [
            "Collection claim is the first rule in the cascade. It beats a line on purpose.",
            "The collection needs one copy; a second printing fills the line for cheap.",
          ],
          proposal: `TO THE SPECIALTY BINDER · SLOT STAYS A PLACEHOLDER · WISHLIST ${cap(species)}`,
          wishlist: slot.card ? slot.alternates : [],
          choices: [
            {
              id: "collection-wins",
              label: "Collection wins",
              description: "Slot stays a hunt; cheapest alternate wishlisted.",
              recommended: true,
            },
            {
              id: "collection-wins-no-target",
              label: "Collection wins, no target",
              description: "Nothing wishlisted.",
            },
            leaveIt,
          ],
        },
        resolution: baseResolution(line, slot, "collection-vs-line"),
      });
      continue;
    }

    // BLOCK — no same-color printing exists at all. Root block keeps the line; both need a decision.
    if (slot.state === "block") {
      const isRoot = slot.stageIndex === 0;
      const openStage = ordered.find((s) => s.state === "placeholder");
      out.push({
        card: {
          id: `${line.lineId}:${isRoot ? "root-block" : "block"}:${slot.stageIndex}`,
          kind: isRoot ? "root-block" : "block",
          lineId: line.lineId,
          slotStageIndex: slot.stageIndex,
          title: isRoot
            ? "ROOT BLOCK · NO SAME-COLOR BASIC"
            : "STAGE BLOCK · NO SAME-COLOR PRINTING",
          question: `NO ${band.toUpperCase()} ${cap(species)} EXISTS. BLOCK ${
            isRoot ? "THE ROOT" : "THIS STAGE"
          }?`,
          card: slot.card,
          catalog: catalogEvidence(band, species, slot.facts),
          owned: ownedEvidence(ordered),
          why: [
            "The surviving members still make a line, so it lives with a blocked slot.",
            "Nothing can ever fill this slot. Block, not a hunt — blocks are never wishlisted.",
          ],
          proposal: openStage?.card
            ? `BLOCK ${isRoot ? "THE ROOT" : "IT"} · WISHLIST ${cap(openStage.card.name)}${
                openStage.priceMarket ? ` ${fmtPrice(openStage.priceMarket)}` : ""
              } · LINE OPEN`
            : `BLOCK ${isRoot ? "THE ROOT" : "IT"} · LINE OPEN`,
          wishlist: [],
          choices: [
            {
              id: "confirm-root-block",
              label: isRoot ? "Confirm root block" : "Confirm block",
              description: "Dead slot, the open stage stays a hunt.",
              recommended: true,
            },
            {
              id: "root-block-no-wishlist",
              label: "Block, no wishlist",
              description: "Nothing to shop for.",
            },
            {
              id: "no-line",
              label: "No line at all",
              description: "Terminate; the surviving card goes to the front half.",
            },
          ],
        },
        resolution: baseResolution(line, slot, isRoot ? "root-block" : "block"),
      });
    }
  }

  return out;
}

/** Derive decisions across every line, newest-status first isn't needed — stable line order. */
export function deriveAllDecisions(lines: DecisionLineInput[]): DerivedDecision[] {
  return lines.flatMap(deriveDecisions);
}

/* --------------------------------- resolve --------------------------------- */

/**
 * `pickedCatalogCardId` is UIL-057: she can choose any alternate the decision card showed, not just
 * the server-computed cheapest. Only accepted when it is genuinely one of the options THIS decision
 * offered — never trust an arbitrary catalog id from the browser, the same rule a stale slot/line id
 * already follows elsewhere in this module. `res.chosenCatalogCardId` and `res.alternateCatalogCardIds`
 * can overlap (the persisted target is usually also alternates[0]), so the option set is deduped
 * before picking — and the stored alternates are always "every option minus whichever is chosen",
 * never a self-reference, regardless of which one that ends up being.
 */
function wishlistUpsertFor(
  res: DecisionResolution,
  willSpecialty: boolean,
  pickedCatalogCardId?: string,
) {
  if (!res.slotId) return [];
  const options = [...new Set([res.chosenCatalogCardId, ...res.alternateCatalogCardIds])].filter(
    (id): id is string => Boolean(id),
  );
  const chosen =
    pickedCatalogCardId && options.includes(pickedCatalogCardId)
      ? pickedCatalogCardId
      : res.chosenCatalogCardId;
  return [
    {
      lineSlotId: res.slotId,
      requiredDexId: res.requiredDexId,
      requiredType: res.requiredType,
      requiredStage: res.requiredStage,
      chosenCatalogCardId: chosen,
      alternateCatalogCardIds: options.filter((id) => id !== chosen),
      willLiveInSpecialty: willSpecialty,
    },
  ];
}

/**
 * Turn a chosen option into the writes it implies (dev-spec §5 M7 acceptance). A confirmed cap sets
 * the line `capped` and wishlists the ex with `willLiveInSpecialty`. Every branch records a
 * `PlacementDecision` (`resolved_by: 'user'`) — the audit trail is not optional (dev-spec §4).
 *
 * `pickedCatalogCardId` (UIL-057) is the wishlist alternate she selected on the decision card, when
 * the choice is one that writes a wishlist target at all (`confirm-cap`/`collection-wins`) — ignored
 * by every other branch.
 */
export function resolveDecisionWrites(
  res: DecisionResolution,
  choiceId: DecisionChoiceId,
  pickedCatalogCardId?: string,
): DecisionWrites {
  const base: Omit<DecisionWrites, "decision"> = {
    slotPatches: [],
    wishlistUpserts: [],
    wishlistResolveSlotIds: [],
  };

  switch (choiceId) {
    case "confirm-cap":
      return {
        ...base,
        linePatch: { status: "capped" },
        wishlistUpserts: wishlistUpsertFor(res, true, pickedCatalogCardId),
        decision: {
          decision: "line-cap-confirmed",
          reason:
            "Confirmed the ex-only cap: the stage stays a placeholder wishlisted to the specialty binder and the line is capped, not complete.",
        },
      };

    case "cap-no-wishlist":
      return {
        ...base,
        linePatch: { status: "capped" },
        slotPatches: res.slotId
          ? [{ slotId: res.slotId, state: "placeholder", targetCatalogCardId: null }]
          : [],
        wishlistResolveSlotIds: res.slotId ? [res.slotId] : [],
        decision: {
          decision: "line-cap-no-wishlist",
          reason: "Capped the line but cleared the wishlist target — no ex to chase.",
        },
      };

    case "block-instead":
      return {
        ...base,
        linePatch: { status: "open" },
        slotPatches: res.slotId
          ? [
              {
                slotId: res.slotId,
                state: "block",
                copyId: null,
                targetCatalogCardId: null,
                note: "blocked by override",
              },
            ]
          : [],
        wishlistResolveSlotIds: res.slotId ? [res.slotId] : [],
        decision: {
          decision: "line-slot-blocked",
          reason:
            "Overrode the cap: blocked the stage and wedged a duplicate rather than chasing the ex.",
        },
      };

    case "confirm-root-block":
      return {
        ...base,
        linePatch: { status: "open" },
        slotPatches: res.slotId
          ? [{ slotId: res.slotId, state: "block", copyId: null, targetCatalogCardId: null }]
          : [],
        decision: {
          decision: "root-block-confirmed",
          reason:
            "Confirmed the block: nothing same-color can fill it; the line lives with the dead slot and the open stage stays a hunt.",
        },
      };

    case "root-block-no-wishlist": {
      const resolveIds = [res.slotId, res.otherOpenSlotId].filter((x): x is string => Boolean(x));
      return {
        ...base,
        linePatch: { status: "open" },
        slotPatches: res.slotId ? [{ slotId: res.slotId, state: "block", copyId: null }] : [],
        wishlistResolveSlotIds: resolveIds,
        decision: {
          decision: "root-block-no-wishlist",
          reason: "Confirmed the block and cleared the hunt — nothing to shop for.",
        },
      };
    }

    case "no-line":
    case "confirm-termination":
      return {
        ...base,
        linePatch: { status: "terminated" },
        decision: {
          decision: "line-terminated",
          reason:
            "Confirmed there is no viable line; the surviving card falls through to the front half.",
        },
      };

    case "make-line-anyway":
      return {
        ...base,
        linePatch: { status: "open" },
        decision: {
          decision: "line-kept-open",
          reason:
            "Overrode the termination: kept the page open with its block, against the two-member rule.",
        },
      };

    case "collection-wins":
      return {
        ...base,
        wishlistUpserts: wishlistUpsertFor(res, res.willLiveInSpecialty, pickedCatalogCardId),
        decision: {
          decision: "collection-wins",
          reason:
            "Confirmed the collection claim beats the line; the slot stays a placeholder with a priced alternate wishlisted.",
        },
      };

    case "collection-wins-no-target":
      return {
        ...base,
        slotPatches: res.slotId
          ? [{ slotId: res.slotId, state: "placeholder", targetCatalogCardId: null }]
          : [],
        wishlistResolveSlotIds: res.slotId ? [res.slotId] : [],
        decision: {
          decision: "collection-wins-no-target",
          reason: "Collection wins; the slot stays open but nothing is wishlisted.",
        },
      };

    case "leave-it":
      return {
        ...base,
        decision: {
          decision: "decision-deferred",
          reason: "Left the proposal unresolved; it resurfaces next time.",
        },
      };
  }
}
