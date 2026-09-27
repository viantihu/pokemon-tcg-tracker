/**
 * Who may use the app (dev-spec §3 decision 4; devops-strategy §12; UIL-127c).
 *
 * The app began as a single-owner binder: one allow-listed email (`ALLOWED_OWNER_EMAIL`). Since UIL-127c the
 * environment decides (./signup-mode): in INVITE mode an address must be on the list (`ALLOWED_EMAILS`,
 * comma-separated, plus `ALLOWED_OWNER_EMAIL`); in OPEN mode every address may. Enforced in the same two places as
 * before: the sign-in action refuses to send a link to an address that may not, and the auth callback / confirm step
 * re-checks the verified session's email and signs it out if it may not (so a session minted by calling Supabase
 * directly with the public anon key still cannot get in). RLS is the backstop behind both.
 *
 * SERVER ONLY — reads the server env.
 */
import { getServerEnv } from "@/lib/env";
import { signupMode } from "./signup-mode";

const norm = (e: string) => e.trim().toLowerCase();

/** The invite list: ALLOWED_EMAILS (comma-separated) plus ALLOWED_OWNER_EMAIL, normalised, empties dropped. */
export function inviteList(env = getServerEnv()): Set<string> {
  const all = [...(env.ALLOWED_EMAILS ?? "").split(","), env.ALLOWED_OWNER_EMAIL ?? ""];
  return new Set(all.map(norm).filter((e) => e !== ""));
}

/** True when `email` may sign in here: any address in open mode, a listed one in invite mode. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email || norm(email) === "") return false;
  if (signupMode() === "open") return true;
  return inviteList().has(norm(email));
}
