/**
 * TEMPORARY deployment diagnostic. Delete once the Testing sign-in path is verified.
 *
 * `/login` returning 500 cannot distinguish "env var absent" from "env var present but scoped to
 * the wrong Vercel environment" — both surface as the same opaque error page, because Next hides
 * server exception detail in production. This reports which required names the running deployment
 * can actually see, and which Vercel scope it is running as.
 *
 * Reports names, presence, and length ONLY. Never a value, never a prefix of a value.
 */

import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWED_OWNER_EMAIL",
] as const;

export async function GET() {
  const env = Object.fromEntries(
    REQUIRED.map((name) => {
      const raw = process.env[name];
      return [
        name,
        { present: typeof raw === "string" && raw.length > 0, length: raw?.length ?? 0 },
      ];
    }),
  );

  // Reproduces exactly what /login does first, so a failure here is the failure there.
  let authProbe: { ok: boolean; error?: string };
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.getUser();
    authProbe = { ok: true, ...(error ? { error: `non-fatal: ${error.message}` } : {}) };
  } catch (caught) {
    authProbe = { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }

  return Response.json({
    vercelEnv: process.env.VERCEL_ENV ?? "(unset)",
    vercelBranch: process.env.VERCEL_GIT_COMMIT_REF ?? "(unset)",
    env,
    authProbe,
  });
}
