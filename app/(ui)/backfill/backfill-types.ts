/**
 * Client/server shared shapes for the backfill screen (dev-spec §5 M5). No directive — safe to
 * import from both the server actions and the client screen; contains only serializable data types.
 */

import type { BackfillBinder, BackfillCollection, BandOption, CommitCounts } from "@/lib/backfill";

/** What `loadContext` returns for the screen to render its pickers. */
export interface BackfillContextPayload {
  binders: BackfillBinder[];
  collections: BackfillCollection[];
  bands: BandOption[];
  /** DB-key type→band map so the client can preview the auto-computed band per card. */
  typeColorMap: Record<string, string>;
}

/** Result of any of the three commit actions. */
export type CommitResult = { ok: true; counts: CommitCounts } | { ok: false; error: string };
