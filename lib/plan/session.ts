/**
 * Owner/session seam (dev-spec §3 decision 4; §7 gate 1).
 *
 * Resolves the owner context for a server request: the RLS-scoped Supabase server client (anon key +
 * the caller's cookies) and the owner id derived from the authenticated session. Magic-link auth has
 * landed, so `auth.uid()` is real and this is the single place callers get their DB handle + owner.
 *
 * HISTORY: M6 shipped this as a STUB — service-role client (bypassing RLS) + a fixed seeded owner id
 * — because auth did not exist yet. The auth task swapped the implementation to the real RLS path.
 * Because the RLS client and the session lookup are both async (`cookies()` and `auth.getUser()`),
 * `getOwnerContext` is now `async` and returns `Promise<OwnerContext>` — callers must `await` it.
 * The exports (`getOwnerContext`, `OwnerContext`, `SEEDED_OWNER_ID`) are otherwise unchanged.
 *
 * With RLS active, writes no longer stamp `owner_id` explicitly: the column defaults to `auth.uid()`
 * and the `with check (owner_id = auth.uid())` policy enforces it. `ownerId` is still returned for
 * reads/labels that need the id.
 *
 * SERVER ONLY. Imported only by server actions / route handlers / server components.
 */

import { createClient } from "@/lib/supabase/server";
import type { DbClient } from "@/lib/repo";

/** Fixed local owner used by `supabase/seed.sql`. Retained for reference/back-compat. */
export const SEEDED_OWNER_ID = "00000000-0000-0000-0000-000000000001";

export interface OwnerContext {
  db: DbClient;
  ownerId: string;
}

/**
 * Resolve the owner context for a server request: the RLS-scoped server client + the session's
 * owner id. Throws if there is no authenticated session (the app's auth guard / proxy redirect to
 * /login means this should not be reached unauthenticated).
 */
export async function getOwnerContext(): Promise<OwnerContext> {
  const db = await createClient();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) {
    throw new Error("No authenticated session: getOwnerContext requires a signed-in owner.");
  }
  return { db, ownerId: user.id };
}
