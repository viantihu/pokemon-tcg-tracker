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
  // Who may sign in (UIL-127c, lib/auth/signup-mode.ts + lib/auth/allowlist.ts). SIGNUP_MODE is "open" or
  // anything else, which means invite (fails closed). In invite mode an address must be in ALLOWED_EMAILS
  // (comma-separated) or be ALLOWED_OWNER_EMAIL, the original single owner (dev-spec §3 decision 4), which is
  // why existing environments keep working with no change. All three are optional.
  SIGNUP_MODE: z.string().optional(),
  ALLOWED_EMAILS: z.string().optional(),
  ALLOWED_OWNER_EMAIL: z.string().optional(),
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
  // Cloudflare Turnstile's public site key (UIL-127c, the Tech Lead's D1). Set only where open sign-up is
  // protected by Supabase Auth's CAPTCHA; empty means no check is shown or sent.
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
};
