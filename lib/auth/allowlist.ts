/**
 * Single-owner allow-list gate (dev-spec §3 decision 4; devops-strategy §12).
 *
 * The binder is a single-user app on the open web. Magic-link sign-in is offered to exactly one
 * configured email (`ALLOWED_OWNER_EMAIL`); every other address is rejected. This is enforced in
 * two places: the sign-in action refuses to send a link to a non-allow-listed email, and the auth
 * callback re-checks the verified session's email and signs it out if it does not match (so a
 * session obtained by calling Supabase directly with the public anon key still cannot get in).
 *
 * SERVER ONLY — reads the server env.
 */
import { getServerEnv } from "@/lib/env";

/** True only when `email` matches the configured owner email (case-insensitive, trimmed). */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = getServerEnv().ALLOWED_OWNER_EMAIL.trim().toLowerCase();
  if (!allowed) return false;
  return email.trim().toLowerCase() === allowed;
}
