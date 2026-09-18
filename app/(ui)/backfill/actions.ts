"use server";

/**
 * Server actions for the backfill screen (dev-spec §5 M5; system-design §7A).
 *
 * Everything the backfill screen needs from the server: type-ahead against the LOCAL catalog mirror
 * (the client NEVER queries TCGdex), the binders/collections/bands/type-map context, back-half chain
 * resolution, and the three atomic commit paths. Owner/session is resolved through the auth seam
 * (`await getOwnerContext()` — RLS-scoped client + session owner id; see lib/plan/session.ts).
 */

import { availableVariants, getOwnerContext, toCardVariants } from "@/lib/plan";
import {
  commitBackLine,
  commitFrontHalf,
  commitSpecialty,
  loadBackfillContext,
  resolveBackLineFromContext,
  type BackLineCommit,
  type FrontHalfCommit,
  type ResolvedBackLine,
  type SpecialtyCommit,
} from "@/lib/backfill";
import { catalogCardRepo } from "@/lib/repo";
import { errorMessage } from "@/lib/errors";
import type { LookupCard } from "../plan/plan-types";
import type { BackfillContextPayload, CommitResult } from "./backfill-types";

/** Type-ahead against the local mirror. Returns [] on error so typing never breaks. */
export async function lookupCatalog(query: string): Promise<LookupCard[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const { db } = await getOwnerContext();
    const rows = await catalogCardRepo.search(db, q, 12);
    return rows.map((r) => ({
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
    }));
  } catch (err) {
    // Throws rather than returning [] (UIL-035): an empty result must mean "the mirror had nothing",
    // not "the request failed". See lookupCatalog in ../plan/actions.ts for why a throw and not a
    // result union.
    throw new Error(`Could not search the catalog: ${errorMessage(err)}`);
  }
}

/** Load the binders, collections, ordered bands, and type→band map the screen needs. */
export async function loadContext(): Promise<BackfillContextPayload> {
  const { db } = await getOwnerContext();
  const ctx = await loadBackfillContext(db);
  return {
    binders: ctx.binders,
    collections: ctx.collections,
    bands: ctx.bands,
    typeColorMap: ctx.typeColorMap,
  };
}

/** Resolve the back-half chain for a picked printing + chosen colour band. */
export async function resolveLine(
  tcgdexId: string,
  bandKey: string,
): Promise<ResolvedBackLine | null> {
  const { db } = await getOwnerContext();
  const ctx = await loadBackfillContext(db);
  return resolveBackLineFromContext(ctx, tcgdexId, bandKey);
}

export async function commitFrontAction(input: FrontHalfCommit): Promise<CommitResult> {
  if (input.cards.length === 0) return { ok: false, error: "No cards to save." };
  try {
    const { db, ownerId } = await getOwnerContext();
    const counts = await commitFrontHalf(db, ownerId, input);
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function commitLineAction(input: BackLineCommit): Promise<CommitResult> {
  if (input.stages.length === 0) return { ok: false, error: "The line has no stages." };
  try {
    const { db, ownerId } = await getOwnerContext();
    const counts = await commitBackLine(db, ownerId, input);
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function commitSpecialtyAction(input: SpecialtyCommit): Promise<CommitResult> {
  if (input.cards.length === 0) return { ok: false, error: "No cards to save." };
  try {
    const { db, ownerId } = await getOwnerContext();
    const counts = await commitSpecialty(db, ownerId, input);
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
