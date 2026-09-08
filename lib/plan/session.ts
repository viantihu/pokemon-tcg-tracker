/**
 * Owner/session seam (dev-spec §3 decision 4; §7 gate 1 — auth is a SEPARATE task).
 *
 * ⚠️ STUBBED SESSION SEAM. Magic-link auth (single allow-listed email + RLS keyed to the owner) is
 * not built yet, so there is no request session and `auth.uid()` is null. M6 still has to read and
 * write real rows for the seeded local owner, so this module is the ONE place that fakes the
 * session:
 *
 *   • it returns the SERVICE-ROLE client (bypasses RLS), and
 *   • it stamps every write with the fixed seeded owner id explicitly (the `auth.uid()` column
 *     default is null under the service role).
 *
 * WHEN AUTH LANDS, change only this file: return `await createClient()` (the RLS anon server client
 * from `lib/supabase/server.ts`) and derive `ownerId` from the session, then drop the explicit
 * `owner_id` stamping in the callers (the RLS `with check (owner_id = auth.uid())` will supply it).
 * Nothing else in M6 needs to move.
 *
 * SERVER ONLY. Imported only by server actions / route handlers / server components. The admin
 * client throws if it is ever evaluated in the browser.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { DbClient } from "@/lib/repo";

/** Fixed local owner used by `supabase/seed.sql`. See seed.sql header. */
export const SEEDED_OWNER_ID = "00000000-0000-0000-0000-000000000001";

export interface OwnerContext {
  db: DbClient;
  ownerId: string;
}

/**
 * Resolve the owner context for a server request. Today: service-role client + seeded owner.
 * See the file header for the auth swap.
 */
export function getOwnerContext(): OwnerContext {
  return { db: createAdminClient(), ownerId: SEEDED_OWNER_ID };
}
