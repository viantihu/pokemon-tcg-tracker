"use server";

/**
 * Finish a magic-link sign-in from the tokens in the link's fragment (UIL-097).
 *
 * A Server Function is reachable by a direct POST, not only from /auth/confirm, so this checks everything
 * itself: the tokens are handed to Supabase, which VALIDATES them with the auth server before it keeps the
 * session (`setSession` → `_getUser`), the session cookies are written by the SSR client, and the user it
 * belongs to must be the one allow-listed owner — any other session is signed out at once. RLS remains the
 * backstop behind all of it.
 *
 * NOTHING HERE LOGS, ECHOES OR RETURNS A TOKEN, OR ANY TEXT THAT COULD CARRY ONE (the Senior BA's
 * condition): no console output, and the result is one of three fixed codes, never Supabase's message.
 *
 * Two rules from the Tech Lead's security review (#333), ruled in by the Senior BA:
 *   R2 — ALREADY SIGNED IN AS THE OWNER: nothing is touched. A link cannot replace her session, so a crafted
 *        `/login#access_token=…` for another account cannot sign her out. (The trade: a second link opened
 *        while she is signed in is not consumed here; it stays usable until it is used or revoked.)
 *   R1 — ROTATE AT ONCE: once the allow-list passes, the session is refreshed, so the cookies hold a NEW
 *        pair and the refresh token that travelled in the URL — and may sit in the in-app browser's history
 *        — stops working after Supabase's reuse interval, instead of staying a live credential for days.
 */

import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";

export type CompleteSignInResult = { ok: true } | { ok: false; error: "auth" | "forbidden" };

export async function completeSignIn(
  accessToken: unknown,
  refreshToken: unknown,
): Promise<CompleteSignInResult> {
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    return { ok: false, error: "auth" };
  }
  if (accessToken === "" || refreshToken === "") return { ok: false, error: "auth" };

  const supabase = await createClient();

  // R2: already the owner — leave her session exactly as it is.
  const {
    data: { user: current },
  } = await supabase.auth.getUser();
  if (current && isAllowedEmail(current.email)) return { ok: true };

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) return { ok: false, error: "auth" };

  // Re-read the user the auth server says this session belongs to; never trust the token's own claims.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAllowedEmail(user?.email)) {
    await supabase.auth.signOut();
    return { ok: false, error: "forbidden" };
  }

  // R1: burn the pair that came through the URL. A session that cannot rotate is not kept.
  const { error: rotateError } = await supabase.auth.refreshSession();
  if (rotateError) {
    await supabase.auth.signOut();
    return { ok: false, error: "auth" };
  }
  return { ok: true };
}
