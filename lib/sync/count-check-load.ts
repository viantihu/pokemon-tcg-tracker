/**
 * UIL-100 — read everything the count check needs and run it, for the Sync page. Server-only (repos); the
 * rule itself lives in ./count-check.ts, pure, so the page and the tests exercise the same function.
 */
import type { DbClient } from "@/lib/repo";
import {
  catalogCardRepo,
  copyRepo,
  dexImportRepo,
  dexPresenceRepo,
  presenceGroupRepo,
  removedPresenceRepo,
  unresolvedEntryRepo,
} from "@/lib/repo";
import { computeCountCheck, type CountCheckView } from "./count-check";

/** The Sync page names at most this many cards; the sum still counts every one. */
const NAMED_LIMIT = 50;

export async function loadCountCheck(db: DbClient): Promise<CountCheckView> {
  const [header, record, removed, groups, copies, entries] = await Promise.all([
    dexImportRepo.get(db),
    dexPresenceRepo.listAll(db),
    removedPresenceRepo.listAll(db),
    presenceGroupRepo.listAll(db),
    copyRepo.listAllFields(db, ["id", "presence_group_id"]),
    unresolvedEntryRepo.list(db),
  ]);

  const perGroup = new Map<string, number>();
  let ungrouped = 0;
  for (const c of copies) {
    if (c.presence_group_id)
      perGroup.set(c.presence_group_id, (perGroup.get(c.presence_group_id) ?? 0) + 1);
    else ungrouped += 1;
  }
  const sumQty = (status: string) =>
    entries.filter((e) => e.status === status).reduce((n, e) => n + Math.max(0, e.quantity), 0);

  const check = computeCountCheck({
    header: header
      ? { fileTotal: header.file_total, rowCount: header.row_count, importedAt: header.imported_at }
      : null,
    record: record.map((r) => ({
      catalog_card_id: r.catalog_card_id,
      dex_variant_raw: r.dex_variant_raw,
      quantity: r.quantity,
    })),
    removed: removed.map((r) => ({
      catalogCardId: r.catalog_card_id,
      dexVariantRaw: r.dex_variant_raw,
      count: r.count,
    })),
    groups: groups.map((g) => ({
      catalogCardId: g.catalog_card_id,
      dexVariantRaw: g.dex_variant_raw,
      copies: perGroup.get(g.id) ?? 0,
    })),
    ungroupedCopies: ungrouped,
    waitingQuantity: sumQty("WAITING"),
    dismissedQuantity: sumQty("DISMISSED"),
  });

  const named = await Promise.all(
    check.mismatches.slice(0, NAMED_LIMIT).map(async (m) => {
      const card = await catalogCardRepo.getByPk(db, m.catalogCardId);
      return {
        ...m,
        name: card?.name ?? m.catalogCardId,
        setName: card?.set_name ?? null,
        localId: card?.local_id ?? null,
      };
    }),
  );
  return { ...check, mismatches: named, importedAt: header?.imported_at ?? null };
}
