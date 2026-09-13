import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";
import type { Database } from "@/lib/repo/database.types";

/**
 * PRIVILEGED Supabase client — bypasses row-level security. SERVER ONLY.
 *
 * The catalog mirror (M2) writes `catalog_card`, which is read-only to the app under RLS
 * (0002_domain.sql). Those writes need a key that bypasses RLS, which is why this client exists
 * separately from `client.ts` / `server.ts` (both RLS-scoped).
 *
 * KEY FORMAT. `SUPABASE_SERVICE_ROLE_KEY` is a historical NAME, not a claim about the value.
 * Supabase is retiring the legacy JWT `service_role` key in favour of `sb_secret_…`, and either
 * works here — supabase-js takes the key as an opaque string. One caveat if this project moves to
 * the new format: `sb_secret_…` keys are not JWTs and are meant to travel on the `apikey` header
 * only, but supabase-js still adds an `Authorization: Bearer` fallback when there is no user
 * session (its `omitApiKeyAsBearer` escape hatch is internal to the Functions client and is not
 * exposed through `createClient`). If privileged reads/writes start failing with "Invalid JWT"
 * after a key migration, that is the reason — upgrade supabase-js rather than patching here.
 *
 * NEVER import this into a Client Component or anything that ships to the browser: it carries the
 * privileged key. It has no cookie/session wiring on purpose — it is not a user session.
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (typeof window !== "undefined") {
    throw new Error(
      "createAdminClient() is server-only — the service-role key must never reach the browser.",
    );
  }
  const env = getServerEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
