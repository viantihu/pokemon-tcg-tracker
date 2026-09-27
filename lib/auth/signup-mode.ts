/**
 * Who may get a sign-in link (UIL-127c). Karvi's rulings (2026-09-27): Testing stays invite-only until go-live
 * ("Yes, invite only"), and Production opens sign-up at launch ("It opens to sign ups when it launches").
 *
 *   invite — only the listed addresses (ALLOWED_EMAILS, plus ALLOWED_OWNER_EMAIL, the original single owner).
 *   open   — any valid address; the first link to a new address creates its account.
 *
 * FAILS CLOSED (the Tech Lead's D3): only the exact value "open" opens sign-up. Unset, empty, a typo, any case
 * variant: invite. And open sign-up needs its bot check (D1): without a Turnstile site key it stays invite, so one
 * missed variable can never leave a sign-up form that mails any address with nothing in front of it. The deploy smoke's stranger probe keys on the GitHub environment's SIGNUP_MODE, set in the same
 * step as this one (docs/go-live-runbook.md).
 *
 * SERVER ONLY — reads the server environment.
 */
import { publicEnv } from "@/lib/env";

export type SignupMode = "open" | "invite";

/** The mode a raw SIGNUP_MODE value and site key mean. Pure, for tests. */
export function parseSignupMode(raw: string | undefined, turnstileSiteKey: string): SignupMode {
  return raw === "open" && turnstileSiteKey.trim() !== "" ? "open" : "invite";
}

/** Read at request time, straight from the environment: one optional string, no other variable required. */
export function signupMode(): SignupMode {
  return parseSignupMode(process.env.SIGNUP_MODE, publicEnv.turnstileSiteKey);
}
