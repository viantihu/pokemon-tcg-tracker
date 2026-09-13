import { z } from "zod";

/**
 * Server-side environment contract. Parsed lazily (on first use at request
 * time), never at import — so `next build` stays green before secrets exist.
 * See docs/devops-strategy.md §7 for where each value lives.
 */
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  // The two SUPABASE_*_KEY names below are historical. Supabase is retiring the legacy JWT
  // `anon` / `service_role` keys in favour of `sb_publishable_…` / `sb_secret_…`; either format is
  // accepted in these vars and nothing here inspects the value. See lib/supabase/admin.ts for the
  // one caveat that bites on the privileged key after a format migration.
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TCGDEX_BASE_URL: z.string().min(1).default("https://api.tcgdex.net/v2"),
  // Single allow-listed owner email (dev-spec §3 decision 4). Magic-link sign-in is offered
  // ONLY to this address; every other email is rejected before a link is sent and again after
  // the link is verified.
  ALLOWED_OWNER_EMAIL: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment. Missing/invalid: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Public vars are inlined by Next at build time and safe to read directly. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};
