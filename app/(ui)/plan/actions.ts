"use server";

/**
 * Server actions for the haul plan screen (dev-spec §5 M6; §7B).
 *
 * Everything the plan screen needs from the server: type-ahead against the LOCAL catalog mirror,
 * the cascade run over a draft, and the atomic commit. The client NEVER queries TCGdex — all
 * catalog access is server-side via `lib/repo`. Owner/session is resolved through the auth seam
 * (`await getOwnerContext()` — RLS-scoped client + session owner id; see lib/plan/session.ts).
 */

import { availableVariants, toCardVariants } from "@/lib/plan";
import {
  commitCardPlacement,
  deriveSpotlightPlacement,
  existingCopyIds,
  getOwnerContext,
  groupPlan,
  loadPendingPlacements,
  loadPlanContext,
  loadPlanFingerprint,
  PlacementChangedError,
  planFromDraft,
  type BandMismatchChoice,
  type DraftItem,
  type PlanItem,
  type ProposedPull,
} from "@/lib/plan";
import { loadMoveOptions, type MoveOptions } from "@/lib/line";
import type { MoveDestination } from "@/lib/line/types";
import { catalogCardRepo, type Row } from "@/lib/repo";
import { errorMessage } from "@/lib/errors";
import type { CommitCounts, DraftCard, LookupCard, RunPlanResult } from "./plan-types";
import type { CommitActionInput, DraftPayloadItem } from "./plan-types";

/** A `catalog_card` row trimmed to what the intake UI renders. */
function toLookupCard(r: Row<"catalog_card">): LookupCard {
  return {
    tcgdexId: r.tcgdex_id,
    name: r.name,
    setId: r.set_id,
    setName: r.set_name,
    localId: r.local_id,
    stage: r.stage,
    types: r.types ?? [],
    cardClass: r.card_class === "specialty" ? "specialty" : "standard",
    imageUrl: r.image_url,
    variants: availableVariants(toCardVariants(r.variants)),
  };
}

/** Type-ahead against the local mirror. Returns [] on error so typing never breaks. */
export async function lookupCatalog(query: string): Promise<LookupCard[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const { db } = await getOwnerContext();
    const rows = await catalogCardRepo.search(db, q, 12);
    return rows.map(toLookupCard);
  } catch {
    return [];
  }
}

/**
 * Copies that exist but have never been routed, as draft rows ready to work (UIL-003).
 *
 * This is the receiving end of Sync's "Place new cards" handoff (sync-ui-spec §B.6): sync creates its
 * additions unplaced on purpose, and until now the Haul Plan had no loader, so that button landed on
 * an empty form and the imported cards had nowhere to go. Each row carries its `existingCopyId`, so
 * committing ROUTES the copy sync already made rather than creating a second one.
 */
export async function loadPendingPlacementDraft(): Promise<DraftCard[]> {
  const { db } = await getOwnerContext();
  const pending = await loadPendingPlacements(db);
  return pending.map((p) => ({
    // The copy id doubles as the draft id: stable across reloads, and unique by construction.
    id: p.copyId,
    existingCopyId: p.copyId,
    dexVariantRaw: p.dexVariantRaw,
    card: toLookupCard(p.card),
    variant: p.variant,
  }));
}

/**
 * Stamp of everything a computed plan depends on (UIL-006). The screen caches its run against this
 * and discards the cache when it changes, so returning to the page restores her place instead of
 * making her re-run — without ever showing a plan computed against state that has since moved.
 */
export async function planStateStamp(pendingCopyIds: string[]): Promise<string> {
  const { db } = await getOwnerContext();
  return loadPlanFingerprint(db, pendingCopyIds);
}

/** Run the cascade over the whole draft and return the grouped plan for rendering. */
export async function runHaulPlan(draft: DraftItem[]): Promise<RunPlanResult> {
  const { db } = await getOwnerContext();
  // Same exclusion the commit uses, so the plan she works from is the plan that gets written.
  const pc = await loadPlanContext(db, { excludeOwnedCopyIds: existingCopyIds(draft) });
  const { items } = planFromDraft(pc, draft);
  const groups = groupPlan(items, pc.orderedBandKeys);

  const byAction: Record<string, number> = {};
  for (const it of items) byAction[it.action] = (byAction[it.action] ?? 0) + 1;

  return {
    groups,
    bands: groups.map((g) => ({ key: g.bandKey, count: g.count })),
    summary: {
      total: items.length,
      decisions: items.filter((it) => it.needsDecision).length,
      byAction,
    },
  };
}

/**
 * Shelve ONE card, the moment she clicks Done (UIL-027).
 *
 * Replaces the model where "Done" was a client-side tick and nothing persisted until a single
 * "Commit the haul" click wrote the entire draft, decided or not. Each call is one
 * `apply_write_ops` transaction for one card.
 *
 * `haulId` threads the sitting: pass null for the first card and hand back whatever this returns for
 * the rest, so the sitting stays one haul in the audit trail. A routed copy (UIL-003) never opens or
 * joins a haul — it was not acquired here — and returns null.
 *
 * `stamp` is the state stamp AFTER the write. Without it the resume cache (UIL-006) would be discarded
 * on every single Done click: shelving changes the copy count, which is part of the stamp by design.
 * Returning the new one lets the client roll its cache forward instead of throwing away a plan it is
 * halfway through working. The plan's remaining rows are a FORECAST either way — `commitCardPlacement`
 * re-derives each card's placement server-side at write time, so what gets written is never stale even
 * when what is displayed has drifted.
 */
export async function shelveCardAction(input: {
  source: CommitActionInput["source"];
  notes?: string | null;
  card: DraftPayloadItem;
  override?: MoveDestination | null;
  haulId?: string | null;
  /** Copy ids still queued, so the returned stamp matches what the screen will hold next. */
  pendingCopyIds?: string[];
  /**
   * Digest of the placement the screen was displaying (UIL-045). The write refuses rather than landing
   * somewhere she did not read off the screen and physically use.
   */
  expectedDigest?: string | null;
  /** Copy ids she ticked to move into the line this card starts (UIL-061). Absent ⇒ move nothing. */
  confirmedPulls?: string[];
  /** Her resolution of a colour mismatch, when the spotlight showed one (UIL-069). Absent ⇒ unresolved. */
  bandChoice?: "line" | "own-color" | null;
}): Promise<
  | { ok: true; haulId: string | null; counts: CommitCounts; stamp: string }
  /**
   * Not a failure: the placement moved under her, nothing was written, and the screen should show
   * `fresh` and let her look again. Distinguished from `ok: false` so the UI does not offer "retry"
   * for something that would just conflict again.
   */
  | { ok: false; changed: true; fresh: PlanItem | null; freshDigest: string; error: string }
  | { ok: false; changed?: false; error: string }
> {
  try {
    const { db } = await getOwnerContext();
    const res = await commitCardPlacement(db, {
      source: input.source,
      notes: input.notes ?? null,
      card: {
        id: input.card.id,
        tcgdexId: input.card.tcgdexId,
        variant: input.card.variant,
        existingCopyId: input.card.existingCopyId ?? null,
      },
      override: input.override ?? null,
      haulId: input.haulId ?? null,
      expectedDigest: input.expectedDigest ?? null,
      confirmedPulls: input.confirmedPulls ?? [],
      bandChoice: input.bandChoice ?? null,
    });
    const stamp = await loadPlanFingerprint(db, input.pendingCopyIds ?? []);
    return { ok: true, haulId: res.haulId, counts: res.counts, stamp };
  } catch (err) {
    if (err instanceof PlacementChangedError) {
      // `actualDigest` is what the server just derived, so the next Done is still guarded rather than
      // falling back to an unchecked write.
      return {
        ok: false,
        changed: true,
        fresh: err.fresh,
        freshDigest: err.actualDigest,
        error: err.message,
      };
    }
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Re-derive ONE card against current state — the card in the spotlight (UIL-045).
 *
 * Called when the cursor lands on a card, so the destination she reads is the one the write will use.
 * Only the spotlight card: the rest of the worklist stays the original forecast and is labelled an
 * estimate, because re-planning the whole tail would cost eight uncached reads per Done across a
 * 685-card sitting.
 */
export async function refreshSpotlightAction(input: { card: DraftPayloadItem }): Promise<
  | {
      ok: true;
      item: PlanItem | null;
      digest: string | null;
      proposedPulls: ProposedPull[];
      bandMismatch: BandMismatchChoice | null;
    }
  | { ok: false; error: string }
> {
  try {
    const { db } = await getOwnerContext();
    const card: DraftItem = {
      id: input.card.id,
      tcgdexId: input.card.tcgdexId,
      variant: input.card.variant,
      existingCopyId: input.card.existingCopyId ?? null,
    };
    // EXACTLY the set `commitCardPlacement` withholds — this one card's own existing copy, and
    // nothing else. It deliberately does NOT withhold the rest of the sitting's pending copies: an
    // unshelved pending copy is not yet placed, so the cascade already treats it as absent, and
    // withholding a DIFFERENT set here than the write uses would make the digest disagree with the
    // write on every card and turn the guard into permanent false conflicts.
    const res = await deriveSpotlightPlacement(db, card, {
      excludeOwnedCopyIds: existingCopyIds([card]),
    });
    return {
      ok: true,
      item: res?.item ?? null,
      digest: res?.digest ?? null,
      proposedPulls: res?.proposedPulls ?? [],
      bandMismatch: res?.bandMismatch ?? null,
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Move-panel options (binders, collections, bands) for the spotlight placement override (M7). */
export async function getMoveOptions(): Promise<MoveOptions> {
  const { db } = await getOwnerContext();
  return loadMoveOptions(db);
}
