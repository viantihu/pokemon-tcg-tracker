/**
 * Where a removed card left from, and whether a bulk duplicate refills its spot (Karvi, 2026-11-11).
 *
 * PURE — no Supabase, no fetch, no Date. The executor and the pipeline do the I/O; this module decides.
 *
 * WHY. A card that leaves Dex was traded or given away, and the same card can sit in several places (a binder,
 * a line slot, a bulk box). The count Dex exports cannot say WHICH physical copy left (sync-architecture L2), and
 * until now the preview silently guessed the least-committed copy (§1.5). Two rules replace the guess:
 *
 *   1. ASK, DON'T GUESS. When the copies that could have left sit in more than one place, she says where each one
 *      left from, and Apply waits for her answer (`unansweredRemovals`). When every candidate is in the same place
 *      (or every copy is leaving) there is nothing to ask: the app already knows.
 *   2. OFFER A REFILL FROM BULK. When the copy that left was SHELVED (a binder pocket or a line slot) and a
 *      duplicate of it — the same duplicate rule the cascade uses, `isDuplicateCard` — is sitting in a bulk box,
 *      she may pull that bulk copy back into the Haul Plan. The plan then routes it like any waiting card, which is
 *      what suggests the binder spot; nothing here places anything (sync-architecture §1.1: the sync never places).
 *
 * The pull itself is recorded as a `placement_decision` with `decision = BULK_PULL_DECISION`, which is what
 * brings an already-placed copy back into the Haul Plan's queue (lib/plan/pending.ts).
 */
import type { CatalogCard } from "@/lib/engine";
import { isDuplicateCard } from "@/lib/engine/duplicate";
import type { CopySnapshot, CurrentGroup, ReconcilePlan, RemovalConsequence } from "./reconcile";
import { presenceKey } from "./diff";

/**
 * The `placement_decision.decision` that puts a bulk copy back in her haul. The pending queue reads it
 * (lib/plan/pending.ts), so it is the ONE spelling: never write the literal anywhere else.
 */
export const BULK_PULL_DECISION = "pulled-from-bulk";
/** The decision Undo records when it puts a pulled copy back in its box. */
export const BULK_RETURN_DECISION = "returned-to-bulk";

/** The removal consequences whose copy held a spot worth refilling: a binder pocket or a line slot. */
const REFILLABLE: ReadonlySet<RemovalConsequence> = new Set<RemovalConsequence>([
  "shelved-cleared",
  "line-slot-freed",
]);

export function isRefillable(consequence: RemovalConsequence): boolean {
  return REFILLABLE.has(consequence);
}

/**
 * Where a copy physically is, as a comparable key. Two copies with the same key are interchangeable for "which
 * one left": she cannot tell them apart by where they sit, so there is nothing to ask. A line slot is its own
 * place (each slot is one pocket); a bulk box is one place however many copies it holds.
 */
export function locationKey(c: CopySnapshot): string {
  if (c.lineSlotId) return `slot:${c.lineSlotId}`;
  return [c.role, c.binderId ?? "", c.binderHalf ?? "", c.colorBand ?? "", c.bulkUnitId ?? ""].join(
    "|",
  );
}

/** One presence key that loses copies this sync, and what she may be asked about it. */
export interface RemovalQuestion {
  presenceKey: string;
  /** How many copies of this key leave. */
  leaving: number;
  /** The copies that COULD be the ones leaving: the group's copies minus any carried by a variant migration. */
  candidates: CopySnapshot[];
  /** True when she must say where they left from: the candidates sit in more than one place. */
  ambiguous: boolean;
}

/**
 * Per losing key, the copies that could have left and whether the answer is hers to give. A copy a variant
 * migration carries across is not a candidate: it did not leave, it changed variant.
 */
export function removalQuestions(
  plan: Pick<ReconcilePlan, "retires" | "variantUpdates">,
  current: readonly CurrentGroup[],
): RemovalQuestion[] {
  const migrating = new Set(plan.variantUpdates.map((v) => v.copyId));
  const leavingByKey = new Map<string, number>();
  for (const r of plan.retires) {
    const k = presenceKey(r.catalogCardId, r.dexVariantRaw);
    leavingByKey.set(k, (leavingByKey.get(k) ?? 0) + 1);
  }
  const out: RemovalQuestion[] = [];
  for (const g of current) {
    const k = presenceKey(g.catalogCardId, g.dexVariantRaw);
    const leaving = leavingByKey.get(k);
    if (!leaving) continue;
    const candidates = g.copies.filter((c) => !migrating.has(c.copyId));
    const places = new Set(candidates.map(locationKey));
    out.push({
      presenceKey: k,
      leaving,
      candidates,
      ambiguous: leaving < candidates.length && places.size > 1,
    });
  }
  return out;
}

/**
 * Whether a which-copy-left answer for a key is usable: exactly as many DISTINCT copies as leave, every one a
 * candidate. `applyOverrides` ignores an unusable answer; `unansweredRemovals` reports it.
 */
export function isValidRetireChoice(
  q: RemovalQuestion,
  choice: readonly string[] | undefined,
): boolean {
  if (!choice || choice.length !== q.leaving) return false;
  if (new Set(choice).size !== choice.length) return false;
  const ids = new Set(q.candidates.map((c) => c.copyId));
  return choice.every((id) => ids.has(id));
}

/**
 * The keys whose removal she has not answered yet. Apply refuses while this is non-empty (the executor checks
 * it, so a stale or scripted client cannot skip the question). Empty for every plan with no ambiguous removal,
 * which is every plan the app could already answer on its own — so nothing that applied before is refused now.
 */
export function unansweredRemovals(
  plan: Pick<ReconcilePlan, "retires" | "variantUpdates">,
  current: readonly CurrentGroup[],
  retireChoice: Readonly<Record<string, string[]>> | undefined,
): string[] {
  return removalQuestions(plan, current)
    .filter((q) => q.ambiguous && !isValidRetireChoice(q, retireChoice?.[q.presenceKey]))
    .map((q) => q.presenceKey);
}

/** What she sees when Apply is pressed with a removal unanswered. Her words, no plumbing (UIL tests). */
export const REMOVAL_UNANSWERED =
  "Nothing was saved. Some cards you removed in Dex are in more than one place here. Pick where each one " +
  "left from, then press Apply again.";

/** A bulk copy that could refill a spot, with what the preview needs to name it. */
export interface RefillCandidate {
  copyId: string;
  catalogCardId: string;
  dexVariantRaw: string;
  bulkUnitId: string | null;
}

/**
 * Bulk copies that duplicate `card` (same artwork, or the same set and number: `isDuplicateCard`, the cascade's
 * own rule) and are not leaving this sync. A different variant counts — variant is not part of the duplicate key
 * (system-design §3). Ordered for a stable list: the same printing first, then by copy id.
 */
export function refillCandidates(
  card: CatalogCard,
  current: readonly CurrentGroup[],
  catalogById: ReadonlyMap<string, CatalogCard>,
  leavingIds: ReadonlySet<string>,
): RefillCandidate[] {
  const out: RefillCandidate[] = [];
  for (const g of current) {
    const other = catalogById.get(g.catalogCardId);
    if (!other) continue;
    if (g.catalogCardId !== card.tcgdexId && !isDuplicateCard(card, other)) continue;
    for (const c of g.copies) {
      if (c.role !== "bulk" || leavingIds.has(c.copyId)) continue;
      out.push({
        copyId: c.copyId,
        catalogCardId: g.catalogCardId,
        dexVariantRaw: g.dexVariantRaw,
        bulkUnitId: c.bulkUnitId ?? null,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.catalogCardId === card.tcgdexId) - Number(a.catalogCardId === card.tcgdexId) ||
      a.copyId.localeCompare(b.copyId),
  );
}

/** One accepted refill: the shelved copy that left, and the bulk copy pulled into the haul in its place. */
export interface BulkPull {
  retiredCopyId: string;
  bulkCopyId: string;
  bulkUnitId: string | null;
  catalogCardId: string;
}

/**
 * Turn her refill answers (`retiredCopyId → bulkCopyId`) into pulls the executor may write, against the FINAL
 * plan (overrides already folded in). Every answer must name a retire that freed a binder pocket or line slot,
 * and a bulk candidate for that card that is not leaving and not pulled twice. Anything else THROWS rather than
 * being dropped: a refill she asked for and silently did not get is a success-shaped failure (RCA RC-6).
 */
export function resolveBulkPulls(
  plan: Pick<ReconcilePlan, "retires">,
  current: readonly CurrentGroup[],
  catalogById: ReadonlyMap<string, CatalogCard>,
  answers: Readonly<Record<string, string>> | undefined,
): BulkPull[] {
  const entries = Object.entries(answers ?? {});
  if (entries.length === 0) return [];
  const leavingIds = new Set(plan.retires.map((r) => r.copyId));
  const retireById = new Map(plan.retires.map((r) => [r.copyId, r]));
  const used = new Set<string>();
  const pulls: BulkPull[] = [];
  for (const [retiredCopyId, bulkCopyId] of entries) {
    const r = retireById.get(retiredCopyId);
    const card = r ? catalogById.get(r.catalogCardId) : undefined;
    if (!r || !card || !isRefillable(r.consequence)) throw new Error(REFILL_STALE);
    const pick = refillCandidates(card, current, catalogById, leavingIds).find(
      (c) => c.copyId === bulkCopyId,
    );
    if (!pick || used.has(bulkCopyId)) throw new Error(REFILL_STALE);
    used.add(bulkCopyId);
    pulls.push({
      retiredCopyId,
      bulkCopyId,
      bulkUnitId: pick.bulkUnitId,
      catalogCardId: pick.catalogCardId,
    });
  }
  return pulls;
}

export const REFILL_STALE =
  "Nothing was saved. A card you asked to pull from a bulk box is no longer there, or no longer matches the " +
  "card that left. Import your Dex file again to see the choices as they are now.";

/** The plan row's reason for a pulled card: where it came from, ahead of where the plan sends it. */
export function pulledFromBulkNote(boxName: string | null): string {
  return `Pulled from ${boxName ?? "your bulk box"} to replace a card you traded.`;
}
