import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";
import type { Database } from "@/lib/repo/database.types";

/**
 * SERVICE-ROLE Supabase client — bypasses row-level security. SERVER ONLY.
 *
 * The catalog mirror (M2) writes `catalog_card`, which is read-only to the app under RLS
 * (0002_domain.sql). Those writes land as the service role, which is why this client exists
 * separately from `client.ts` / `server.ts` (both anon-key + RLS).
 *
 * NEVER import this into a Client Component or anything that ships to the browser: it carries the
 * service-role key. It has no cookie/session wiring on purpose — it is not a user session.
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
